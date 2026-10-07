"""REST API (prefix /api). Interactive docs at /docs.

Auth: when enabled, every call needs `X-API-Key: <key>` (or `?key=` for links
and the event stream). The dashboard asks for the key once and remembers it.
"""
from __future__ import annotations

import base64
import json
import secrets
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .catalog import MODES
from .config import VERSION
from .presets import build_character_prompt, presets
from .protocol import batch as fb
from .protocol import observe as ob


def core_of(request: Request):
    return request.app.state.core


def require_key(request: Request) -> None:
    core = core_of(request)
    if not core.config.auth_enabled:
        return
    key = request.headers.get("x-api-key") or request.query_params.get("key") or ""
    if not key or not secrets.compare_digest(key, core.api_key):
        raise HTTPException(401, "Thiếu hoặc sai API key (header X-API-Key)")


router = APIRouter(prefix="/api")
api = APIRouter(dependencies=[Depends(require_key)])


def _bad(exc: Exception) -> HTTPException:
    return HTTPException(400, str(exc))


# ── health / overview / events ──────────────────────────────────────────────

@router.get("/health", tags=["system"])
async def health(request: Request):
    core = core_of(request)
    return {"ok": True, "version": VERSION, "workers_online": len(core.hub.workers),
            "auth": core.config.auth_enabled}


@api.get("/overview", tags=["system"])
async def overview(request: Request):
    core = core_of(request)
    counts = {r["status"]: r["n"] for r in core.db.all("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")}
    return {"version": VERSION, "workers": core.hub.all_workers(), "job_counts": counts,
            "recent_jobs": core.jobs.list(limit=8), "alerts": core.alerts.list(limit=20),
            "alerts_unseen": core.alerts.unseen_count(),
            "media_count": (core.db.one("SELECT COUNT(*) AS n FROM media") or {}).get("n", 0),
            "observation_count": (core.db.one("SELECT COUNT(*) AS n FROM observations") or {}).get("n", 0),
            "last_build": core.settings.get("last_build"), "project_id": core.settings.get("project_id")}


@api.get("/events", tags=["system"])
async def events(request: Request):
    return StreamingResponse(core_of(request).events.stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@api.get("/workers", tags=["workers"])
async def workers(request: Request):
    return core_of(request).hub.all_workers()


# ── jobs ────────────────────────────────────────────────────────────────────

class JobCreate(BaseModel):
    type: Literal["image", "character", "edit", "t2v", "i2v", "first_last", "r2v", "upscale", "template"]
    prompt: Optional[str] = None
    prompts: Optional[list[str]] = Field(None, description="prompt riêng từng biến thể ảnh")
    model: Optional[str] = Field(None, description="wire id chính xác; bỏ trống để chọn theo family")
    family: Optional[str] = Field(None, description="family trong Models; bỏ trống = mặc định")
    aspect: str = Field("16:9", description="ảnh: 1:1 9:16 16:9 3:4 4:3 · video: 16:9 9:16")
    count: int = 1
    seed: Optional[int] = None
    duration: Optional[int] = Field(None, description="Omni: 4 6 8 10")
    resolution: Optional[str] = Field(None, description="Omni: 720p / 360p · upscale: 2K / 4K")
    ref_media_ids: list[str] = []
    start_media_ids: list[str] = []
    start_media_id: Optional[str] = None
    end_media_id: Optional[str] = None
    base_media_id: Optional[str] = None
    media_id: Optional[str] = None
    character: Optional[dict] = Field(None, description="{gender, country, vibe, extras}")
    character_id: Optional[str] = Field(None, description="ảnh: gắn vào một Nhân vật (Character) có sẵn trên Flow")
    template_id: Optional[int] = None
    variables: Optional[dict] = None
    project_id: Optional[str] = None
    worker_id: Optional[str] = None
    webhook_url: Optional[str] = None
    timeout_min: Optional[float] = None


@api.post("/jobs", tags=["jobs"], status_code=201)
async def create_job(body: JobCreate, request: Request):
    try:
        return core_of(request).jobs.create(body.model_dump())
    except ValueError as exc:
        raise _bad(exc)


@api.post("/jobs/preview", tags=["jobs"])
async def preview_job(body: JobCreate, request: Request):
    """Body chính xác sẽ gửi (không gửi đi)."""
    try:
        return core_of(request).jobs.preview(body.model_dump())
    except ValueError as exc:
        raise _bad(exc)


@api.get("/jobs", tags=["jobs"])
async def list_jobs(request: Request, status: Optional[str] = None, type: Optional[str] = None, limit: int = 100):
    return core_of(request).jobs.list(status, type, min(limit, 500))


@api.get("/jobs/{job_id}", tags=["jobs"])
async def get_job(job_id: str, request: Request):
    job = core_of(request).jobs.get(job_id, with_log=True)
    if job is None:
        raise HTTPException(404, "không có job này")
    return job


@api.post("/jobs/{job_id}/cancel", tags=["jobs"])
async def cancel_job(job_id: str, request: Request):
    try:
        return await core_of(request).jobs.cancel(job_id)
    except KeyError:
        raise HTTPException(404, "không có job này")


@api.post("/jobs/{job_id}/repoll", tags=["jobs"])
async def repoll_job(job_id: str, request: Request):
    try:
        return await core_of(request).jobs.repoll(job_id)
    except KeyError:
        raise HTTPException(404, "không có job này")
    except ValueError as exc:
        raise _bad(exc)


@api.delete("/jobs/{job_id}", tags=["jobs"])
async def delete_job(job_id: str, request: Request):
    core_of(request).jobs.delete(job_id)
    return {"ok": True}


@api.post("/uploads", tags=["media"], status_code=201)
async def upload(request: Request, file: UploadFile = File(...), project_id: Optional[str] = Form(None)):
    mime = (file.content_type or "").split(";")[0].strip().lower()
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        raise HTTPException(415, "chỉ nhận JPEG / PNG / WEBP / GIF")
    data = await file.read(10 * 1024 * 1024 + 1)
    if not data or len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "ảnh rỗng hoặc quá 10 MB")
    spec = {"type": "upload", "file_name": file.filename or "upload.jpg", "mime_type": mime, "size": len(data),
            "project_id": project_id}
    return core_of(request).jobs.create(spec, secret={"b64": base64.b64encode(data).decode("ascii")})


# ── media ───────────────────────────────────────────────────────────────────

@api.get("/media", tags=["media"])
async def list_media(request: Request, kind: Optional[str] = None, source: Optional[str] = None, limit: int = 200,
               offset: int = 0):
    return core_of(request).media.list(kind, source, min(limit, 1000), offset)


@api.get("/media/{media_id}", tags=["media"])
async def get_media(media_id: str, request: Request):
    row = core_of(request).media.get(media_id)
    if row is None:
        raise HTTPException(404, "không có media này")
    return row


@api.get("/media/{media_id}/file", tags=["media"])
async def media_file(media_id: str, request: Request, download: bool = False):
    core = core_of(request)
    path = core.media.local_file(media_id)
    row = core.media.get(media_id)
    if path:
        return FileResponse(path, media_type=(row or {}).get("mime"), filename=path.name if download else None)
    if row and row.get("url"):
        return RedirectResponse(row["url"])
    raise HTTPException(404, "chưa có file")


@api.get("/media/{media_id}/poster", tags=["media"])
async def media_poster(media_id: str, request: Request):
    row = core_of(request).media.get(media_id)
    if row and row.get("poster_url"):
        return RedirectResponse(row["poster_url"])
    raise HTTPException(404, "không có poster")


class MediaAdd(BaseModel):
    media_id: str


@api.post("/media", tags=["media"], status_code=201)
async def add_media(body: MediaAdd, request: Request):
    core = core_of(request)
    try:
        return await core.jobs.refresh_media(body.media_id.strip())
    except fb.FlowError as exc:
        return core.media.upsert({"id": body.media_id.strip(), "kind": "image", "source": "manual",
                                  "note": f"chưa lấy được url: {exc}"})


@api.post("/media/{media_id}/refresh", tags=["media"])
async def refresh_media(media_id: str, request: Request):
    try:
        return await core_of(request).jobs.refresh_media(media_id)
    except fb.FlowError as exc:
        raise _bad(exc)


@api.delete("/media/{media_id}", tags=["media"])
async def delete_media(media_id: str, request: Request):
    core_of(request).media.delete(media_id)
    return {"ok": True}


# ── observation ─────────────────────────────────────────────────────────────

@api.get("/observations", tags=["observation"])
async def list_observations(request: Request, rpcid: Optional[str] = None, source: Optional[str] = None,
                      kind: Optional[str] = None, q: Optional[str] = None, hide_polls: bool = False,
                      before_id: Optional[int] = None, limit: int = 200):
    return core_of(request).observations.list(rpcid=rpcid, source=source, kind=kind, q=q, hide_polls=hide_polls,
                                              before_id=before_id, limit=limit)


@api.get("/observations/export", tags=["observation"])
async def export_observations(request: Request, limit: int = 5000):
    rows = core_of(request).db.all("SELECT * FROM observations ORDER BY id DESC LIMIT ?", (min(limit, 50000),))
    return Response(json.dumps(rows, ensure_ascii=False, indent=1), media_type="application/json",
                    headers={"Content-Disposition": "attachment; filename=flowhub-observations.json"})


@api.get("/observations/{obs_id}", tags=["observation"])
async def get_observation(obs_id: int, request: Request):
    row = core_of(request).observations.get(obs_id)
    if row is None:
        raise HTTPException(404, "không có observation này")
    return row


@api.post("/observations/{obs_id}/check", tags=["observation"])
async def check_observation(obs_id: int, request: Request, rpc_index: int = 0):
    """Dựng lại request bằng builder của Flow Hub và so với request thật."""
    row = core_of(request).observations.get(obs_id)
    rpcs = (row or {}).get("rpcs") or []
    if rpc_index >= len(rpcs) or rpcs[rpc_index].get("inner") is None:
        raise HTTPException(400, "không có inner JSON để kiểm tra")
    return ob.builder_check(rpcs[rpc_index]["rpcid"], rpcs[rpc_index]["inner"])


class TemplateFromObservation(BaseModel):
    rpc_index: int = 0
    name: Optional[str] = None


@api.post("/observations/{obs_id}/template", tags=["observation"], status_code=201)
async def template_from_observation(obs_id: int, body: TemplateFromObservation, request: Request):
    try:
        return core_of(request).templates.from_observation(obs_id, body.rpc_index, body.name)
    except ValueError as exc:
        raise _bad(exc)


@api.delete("/observations", tags=["observation"])
async def clear_observations(request: Request):
    core_of(request).observations.clear()
    return {"ok": True}


@api.get("/rpcs", tags=["observation"])
async def known_rpcs(request: Request):
    return core_of(request).observations.rpc_counts()


class RpcPatch(BaseModel):
    name: Optional[str] = None
    captcha_action: Optional[str] = None
    ignored: Optional[bool] = None


@api.patch("/rpcs/{rpcid}", tags=["observation"])
async def patch_rpc(rpcid: str, body: RpcPatch, request: Request):
    values = {k: (int(v) if isinstance(v, bool) else v) for k, v in body.model_dump(exclude_none=True).items()}
    core_of(request).db.update("known_rpcs", "rpcid", rpcid, values)
    return core_of(request).db.one("SELECT * FROM known_rpcs WHERE rpcid=?", (rpcid,))


@api.get("/alerts", tags=["observation"])
async def list_alerts(request: Request, unseen: bool = False):
    return core_of(request).alerts.list(unseen_only=unseen)


class AlertSeen(BaseModel):
    id: Optional[int] = None


@api.post("/alerts/seen", tags=["observation"])
async def alerts_seen(body: AlertSeen, request: Request):
    core_of(request).alerts.mark_seen(body.id)
    return {"ok": True}


# ── models ──────────────────────────────────────────────────────────────────

@api.get("/models", tags=["models"])
async def list_models(request: Request, mode: Optional[str] = None):
    catalog = core_of(request).catalog
    return {"modes": MODES, "families": catalog.families(mode), "rows": catalog.rows(mode)}


@api.get("/models/resolve", tags=["models"])
async def resolve_model(request: Request, mode: str, family: Optional[str] = None, aspect: Optional[str] = None,
                  duration: Optional[int] = None, resolution: Optional[str] = None):
    label = {"16:9": "landscape", "9:16": "portrait"}.get(aspect or "", aspect) if mode != "image" else None
    try:
        return core_of(request).catalog.resolve(mode, family, label, duration, resolution)
    except ValueError as exc:
        raise _bad(exc)


class ModelBody(BaseModel):
    mode: Optional[str] = None
    family: Optional[str] = None
    family_label: Optional[str] = None
    key: Optional[str] = None
    aspect: Optional[str] = None
    duration: Optional[int] = None
    resolution: Optional[str] = None
    status: Optional[Literal["verified", "unverified", "disabled"]] = None
    note: Optional[str] = None
    sort: Optional[int] = None


@api.post("/models", tags=["models"], status_code=201)
async def create_model(body: ModelBody, request: Request):
    try:
        return {"id": core_of(request).catalog.create(body.model_dump(exclude_none=True))}
    except (ValueError, Exception) as exc:  # sqlite IntegrityError for a duplicate key
        raise _bad(exc)


@api.patch("/models/{model_id}", tags=["models"])
async def patch_model(model_id: int, body: ModelBody, request: Request):
    values = body.model_dump(exclude_unset=True)
    core_of(request).catalog.update(model_id, values)
    return {"ok": True}


@api.delete("/models/{model_id}", tags=["models"])
async def delete_model(model_id: int, request: Request):
    core_of(request).catalog.delete(model_id)
    return {"ok": True}


class DefaultFamily(BaseModel):
    mode: str
    family: str


@api.post("/models/default", tags=["models"])
async def default_family(body: DefaultFamily, request: Request):
    core_of(request).catalog.set_default(body.mode, body.family)
    return {"ok": True}


# ── templates & raw RPC ─────────────────────────────────────────────────────

@api.get("/templates", tags=["templates"])
async def list_templates(request: Request):
    return core_of(request).templates.list()


class TemplateBody(BaseModel):
    name: Optional[str] = None
    rpcid: Optional[str] = None
    captcha_action: Optional[str] = None
    inner: Optional[Any] = None
    result_kind: Optional[Literal["image", "video", "raw"]] = None
    note: Optional[str] = None


@api.post("/templates", tags=["templates"], status_code=201)
async def create_template(body: TemplateBody, request: Request):
    try:
        return core_of(request).templates.create(body.model_dump(exclude_none=True))
    except ValueError as exc:
        raise _bad(exc)


@api.get("/templates/{template_id}", tags=["templates"])
async def get_template(template_id: int, request: Request):
    row = core_of(request).templates.get(template_id)
    if row is None:
        raise HTTPException(404, "không có template này")
    return row


@api.patch("/templates/{template_id}", tags=["templates"])
async def patch_template(template_id: int, body: TemplateBody, request: Request):
    return core_of(request).templates.update(template_id, body.model_dump(exclude_unset=True))


@api.delete("/templates/{template_id}", tags=["templates"])
async def delete_template(template_id: int, request: Request):
    core_of(request).templates.delete(template_id)
    return {"ok": True}


class RenderBody(BaseModel):
    variables: dict = {}


@api.post("/templates/{template_id}/render", tags=["templates"])
async def render_template(template_id: int, body: RenderBody, request: Request):
    core = core_of(request)
    values = {"project_id": core.settings.get("project_id") or "<PROJECT_ID>", **body.variables}
    try:
        return core.templates.render(template_id, values)
    except ValueError as exc:
        raise _bad(exc)


class RawRpc(BaseModel):
    rpcid: str
    inner: Optional[Any] = None
    freq: Optional[str] = None
    captcha_action: Optional[str] = Field(None, description="bỏ trống = tự chọn theo RPC; 'none' = không captcha")
    worker_id: Optional[str] = None


@api.post("/rpc", tags=["templates"])
async def raw_rpc(body: RawRpc, request: Request):
    """Gửi một RPC thô qua worker (thử nghiệm khi Flow đổi API)."""
    core = core_of(request)
    freq = body.freq or fb.build_envelope(body.rpcid, body.inner)
    captcha = None if body.captcha_action == "none" else (
        body.captcha_action or (core.observations.captcha_action_for(body.rpcid) if fb.CAPTCHA_SLOT in freq else None))
    try:
        return await core.jobs.raw_rpc(body.rpcid, freq, captcha, body.worker_id)
    except fb.FlowError as exc:
        raise _bad(exc)


# ── settings & presets ──────────────────────────────────────────────────────

class SettingsPatch(BaseModel):
    project_id: Optional[str] = None
    observe_enabled: Optional[bool] = None
    observe_responses: Optional[bool] = None
    download_media: Optional[bool] = None
    poll_interval_s: Optional[float] = None
    min_submit_gap_s: Optional[float] = None
    job_timeout_min: Optional[float] = None
    wait_worker_s: Optional[float] = None
    max_observations: Optional[int] = None


def _settings_view(request: Request) -> dict:
    core = core_of(request)
    host = request.headers.get("host")
    return {**core.settings.all(), "worker_token": core.worker_token, "ws_url": core.ws_url(host),
            "auth_enabled": core.config.auth_enabled, "api_key": core.api_key if core.config.auth_enabled else None,
            "version": VERSION, "worker_token_from_env": bool(core.config.worker_token)}


@api.get("/settings", tags=["system"])
async def get_settings(request: Request):
    view = _settings_view(request)
    view.pop("api_key", None)
    return view


@api.patch("/settings", tags=["system"])
async def patch_settings(body: SettingsPatch, request: Request):
    core = core_of(request)
    for key, value in body.model_dump(exclude_none=True).items():
        core.settings.set(key, value.strip() if isinstance(value, str) else value)
    await core.hub.broadcast_config()
    return await get_settings(request)


@api.post("/settings/rotate-worker-token", tags=["system"])
async def rotate_worker_token(request: Request):
    core = core_of(request)
    if core.config.worker_token:
        raise HTTPException(400, "token đang đặt bằng FLOWHUB_WORKER_TOKEN trong .env")
    core.rotate_worker_token()
    return await get_settings(request)


@api.get("/presets/character", tags=["presets"])
async def character_presets():
    return presets()


class CharacterBody(BaseModel):
    gender: Optional[str] = None
    country: Optional[str] = None
    vibe: Optional[str] = "clean"
    extras: str = ""


@api.post("/presets/character/prompt", tags=["presets"])
async def character_prompt(body: CharacterBody):
    return {"prompt": build_character_prompt(body.gender, body.country, body.vibe, body.extras)}


router.include_router(api)
