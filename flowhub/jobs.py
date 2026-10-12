"""The job engine: spec in, Flow RPCs out through a worker, media back.

Job types
  image / character / edit      ogiZ0b, every variant in one RPC (inline image urls)
  t2v / i2v / first_last / r2v  YhhmEf / eb1hJf / nprQif / MZZa6b, then polling
  upload / upscale               maseQ / SPrCad
  template                       a body saved from Observation, re-sent with new values

Video polling follows what Flow's own UI does (observed 2026-10-07): jwpduf
with every pending operation id every few seconds; once one reports done,
as29s with that same id gives the clip. The project listing (Zzl0ze) is only a
fallback for when as29s does not know the operation id.

All state is in SQLite: a server restart resumes polling jobs, and a worker
reconnecting mid-job only costs the call that was in flight.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Optional

import httpx

from .db import DB, Settings, now
from .media import image_aspect
from .presets import build_character_prompt
from .protocol import batch as fb
from .protocol import observe as ob

if TYPE_CHECKING:
    from .catalog import Catalog
    from .events import EventHub
    from .media import MediaStore
    from .observations import ObservationStore
    from .templates import TemplateStore
    from .workers import Worker, WorkerHub

log = logging.getLogger("flowhub.jobs")

IMAGE_TYPES = {"image", "character", "edit"}
VIDEO_TYPES = {"t2v", "i2v", "first_last", "r2v"}
TYPES = IMAGE_TYPES | VIDEO_TYPES | {"upload", "upscale", "template"}
MODE_BY_TYPE = {"image": "image", "character": "image", "edit": "image", "t2v": "t2v", "i2v": "i2v",
                "first_last": "first_last", "r2v": "r2v"}
ACTIVE = {"queued", "running", "polling"}
TERMINAL = {"done", "partial", "failed", "timeout", "canceled"}

#: Worker errors where the request may have left the tab but its answer never
#: came back (typically the Flow tab reloading mid-call). Flow renders such a
#: request anyway, so an image call looks for its result instead of failing.
RESPONSE_LOST = ("PAGE_UNLOADED", "FETCH_FAILED", "NO_INJECTION_RESULT")
#: How long to look for the image of a lost ogiZ0b answer in the project listing.
IMAGE_RECOVER_S = 150


class ResponseLost(fb.FlowError):
    """The call may have reached Flow, but its answer was lost on the way back."""

    def __init__(self, message: str, sent: Optional[bool]):
        super().__init__(message)
        self.sent = sent   # None: an extension older than 1.0.1 cannot tell


@dataclass
class Call:
    label: str
    rpcid: str
    build: Callable[[], str]
    captcha: Optional[str] = None
    text: Optional[str] = None
    extra: dict = field(default_factory=dict)


def _clip(text: Optional[str], limit: int) -> Optional[str]:
    if text is None:
        return None
    return text if len(text) <= limit else text[:limit] + f"… ({len(text)} ký tự)"


class JobEngine:
    def __init__(self, db: DB, settings: Settings, catalog: "Catalog", hub: "WorkerHub",
                 media: "MediaStore", events: "EventHub", observations: "ObservationStore",
                 templates: "TemplateStore"):
        self.db = db
        self.settings = settings
        self.catalog = catalog
        self.hub = hub
        self.media = media
        self.events = events
        self.observations = observations
        self.templates = templates
        self.tasks: dict[str, asyncio.Task] = {}
        self._secrets: dict[str, dict] = {}   # upload bytes: kept in memory only

    # ── lifecycle ──
    async def startup(self) -> None:
        for row in self.db.all("SELECT id, status, type, spec FROM jobs WHERE status IN ('queued','running','polling')"):
            if row["status"] == "running":
                spec = row.get("spec") or {}
                if spec.get("stage") == "extracting_frames":
                    self.db.update("jobs", "id", row["id"], {
                        "status": "queued", "error": None, "updated_at": now(), "finished_at": None})
                    self._spawn(row["id"], self._run)
                else:
                    self.db.update("jobs", "id", row["id"], {
                        "status": "failed", "error": "bị gián đoạn: server khởi động lại giữa lúc gửi",
                        "updated_at": now(), "finished_at": now()})
            elif row["status"] == "queued":
                self._spawn(row["id"], self._run)
            else:
                self._spawn(row["id"], self._poll)

    async def shutdown(self) -> None:
        for task in list(self.tasks.values()):
            task.cancel()

    def _spawn(self, job_id: str, fn) -> None:
        task = asyncio.create_task(fn(job_id))
        self.tasks[job_id] = task
        task.add_done_callback(lambda t, jid=job_id: self.tasks.pop(jid, None) if self.tasks.get(jid) is t else None)

    # ── spec ──
    def normalize(self, spec: dict) -> dict:
        s = {k: v for k, v in dict(spec).items() if v is not None}
        kind = s.get("type")
        if kind not in TYPES:
            raise ValueError(f"type phải là một trong {sorted(TYPES)}")
        s["count"] = max(1, min(4, int(s.get("count") or 1)))
        if kind == "edit":
            s["count"] = 1
        if kind == "character" and not str(s.get("prompt") or "").strip():
            c = s.get("character") or {}
            s["prompt"] = build_character_prompt(c.get("gender"), c.get("country"), c.get("vibe"), c.get("extras", ""))
        if isinstance(s.get("prompt"), str):
            s["prompt"] = s["prompt"].strip()
        if kind in IMAGE_TYPES | VIDEO_TYPES and not s.get("prompt"):
            raise ValueError("thiếu prompt")

        if kind in IMAGE_TYPES:
            aspect = s.get("aspect", "16:9")
            s["aspect_code"] = aspect if isinstance(aspect, int) else fb.IMAGE_ASPECTS.get(str(aspect))
            if s["aspect_code"] not in (1, 2, 3, 4, 5):
                raise ValueError(f"tỉ lệ ảnh không hợp lệ: {aspect} (1:1, 9:16, 16:9, 3:4, 4:3)")
            # kept on the media row: the frame crop of a video made from it depends on it
            s["aspect"] = next(k for k, v in fb.IMAGE_ASPECTS.items() if v == s["aspect_code"])
        elif kind in VIDEO_TYPES:
            aspect = s.get("aspect", "16:9")
            s["aspect_code"] = fb.VIDEO_ASPECTS.get(str(aspect))
            if s["aspect_code"] is None:
                raise ValueError(f"tỉ lệ video không hợp lệ: {aspect} (16:9, 9:16)")
            s["aspect_label"] = "portrait" if s["aspect_code"] == fb.VIDEO_PORTRAIT else "landscape"

        if kind in MODE_BY_TYPE and not s.get("model"):
            row = self.catalog.resolve(MODE_BY_TYPE[kind], s.get("family"), s.get("aspect_label"),
                                       s.get("duration"), s.get("resolution"))
            s["model"] = row["key"]
            s["family"] = row["family"]
            s["model_status"] = row["status"]
        elif kind == "r2v" and s.get("model") in {
                "veo_3_1_r2v_fast", "veo_3_1_r2v_fast_portrait", "veo_3_1_r2v_fast_landscape"}:
            # Fast uses distinct Flow keys for portrait and landscape.
            # Resolve stale/mismatched picker values against the selected aspect.
            row = self.catalog.resolve("r2v", "veo_3_1_fast", s.get("aspect_label"))
            s["model"] = row["key"]
            s["family"] = row["family"]
            s["model_status"] = row["status"]

        refs = [m for m in s.get("ref_media_ids") or [] if m]
        s["ref_media_ids"] = refs
        if s.get("ref_media_names") is not None:
            names = [str(name) for name in s["ref_media_names"]]
            if len(names) != len(refs):
                raise ValueError("ref_media_names cần một tên cho mỗi ref_media_id")
            s["ref_media_names"] = names
        if kind == "edit" and not s.get("base_media_id"):
            raise ValueError("sửa ảnh cần base_media_id")
        if kind == "i2v":
            starts = [m for m in (s.get("start_media_ids") or []) if m] or ([s["start_media_id"]] if s.get("start_media_id") else [])
            if not starts and not s.get("extract_start_video_id") and not s.get("canvas_dependencies"):
                raise ValueError("i2v cần start_media_ids")
            s["start_media_ids"] = starts
        if s.get("extract_start_video_id"):
            s["extract_start_video_id"] = str(s["extract_start_video_id"])
        if kind == "first_last" and not (s.get("start_media_id") and s.get("end_media_id")):
            raise ValueError("first_last cần start_media_id và end_media_id")
        s["extract_video_ids"] = [str(m) for m in (s.get("extract_video_ids") or []) if m]
        if kind == "r2v" and not refs and not s["extract_video_ids"] and not s.get("canvas_dependencies"):
            raise ValueError("r2v cần ít nhất 1 ref_media_ids")
        if s["extract_video_ids"] or s.get("extract_start_video_id"):
            s["stage"] = "extracting_frames"
            s["extracted_video_frames"] = {}
        if kind == "upscale":
            if not s.get("media_id"):
                raise ValueError("upscale cần media_id")
            s["resolution"] = str(s.get("resolution") or "2K").upper()
            if s["resolution"] not in fb.IMAGE_UPSCALE_RESOLUTIONS:
                raise ValueError("upscale resolution: 2K hoặc 4K")
        if kind == "template":
            if self.templates.get(int(s.get("template_id") or 0)) is None:
                raise ValueError("template_id không tồn tại")
        s["timeout_s"] = float(s.get("timeout_min") or self.settings.get("job_timeout_min") or 10) * 60
        return s

    def plan(self, job: dict, project_id: str) -> list[Call]:
        s = job["spec"]
        kind = job["type"]
        model = s.get("model")
        cap = self.observations.captcha_action_for
        prompt = s.get("prompt") or ""
        calls: list[Call] = []
        if kind in IMAGE_TYPES:
            # Like Flow's UI: every variant is an item of one call, each with its own seed.
            prompts = s.get("prompts") or []
            texts = [prompts[i] if i < len(prompts) and prompts[i] else prompt for i in range(s["count"])]
            seeds = ([int(s["seed"]) + i * 9973 for i in range(s["count"])]
                     if s.get("seed") not in (None, "") else None)
            base = s.get("base_media_id") if kind == "edit" else None
            refs = [m for m in s["ref_media_ids"] if m != base] or None
            calls.append(Call(f"{len(texts)} biến thể" if len(texts) > 1 else "ảnh", fb.RPC_GEN_IMAGE,
                              captcha=cap(fb.RPC_GEN_IMAGE), text=prompt,
                              build=lambda: fb.image_request(texts, project_id, s["aspect_code"], model,
                                                             seeds, refs, base, s.get("character_id")),
                              extra={"texts": texts, "exclude": [m for m in [base, *(refs or [])] if m]}))
        elif kind == "t2v":
            for n in range(s["count"]):
                calls.append(Call(f"video {n + 1}", fb.RPC_GEN_VIDEO_TEXT, captcha=cap(fb.RPC_GEN_VIDEO_TEXT),
                                  build=lambda: fb.text_video_request(prompt, project_id, s["aspect_code"], model)))
        elif kind == "i2v":
            for i, src in enumerate(s["start_media_ids"]):
                for n in range(s["count"]):
                    calls.append(Call(f"ảnh {i + 1} #{n + 1}", fb.RPC_GEN_VIDEO, captcha=cap(fb.RPC_GEN_VIDEO),
                                      build=lambda src=src: fb.i2v_request(prompt, project_id, src, s["aspect_code"], model,
                                                                           self._crop(src, s["aspect_code"]))))
        elif kind == "first_last":
            for n in range(s["count"]):
                calls.append(Call(f"đầu+cuối #{n + 1}", fb.RPC_GEN_VIDEO_FIRST_LAST, captcha=cap(fb.RPC_GEN_VIDEO_FIRST_LAST),
                                  build=lambda: fb.first_last_request(
                                      prompt, project_id, s["start_media_id"], s["end_media_id"], s["aspect_code"], model,
                                      self._crop(s["start_media_id"], s["aspect_code"]),
                                      self._crop(s["end_media_id"], s["aspect_code"]))))
        elif kind == "r2v":
            # The current Flow MZZa6b shape embeds reference labels in the
            # prompt block for Veo 3.1 Fast and Lite. Omni keeps its verified
            # prompt-only shape.
            is_veo_r2v = str(model or "").startswith("veo_3_1_r2v_")
            names = s.get("ref_media_names") if is_veo_r2v else None
            if is_veo_r2v and names is None:
                names = []
                for media_id in s["ref_media_ids"]:
                    media = self.media.get(str(media_id)) or {}
                    # Uploads through Flow Hub keep the original filename in
                    # `prompt`; generated/imported media may not have a label.
                    names.append(str(media.get("file_name") or media.get("prompt") or media_id))
            for n in range(s["count"]):
                calls.append(Call(f"ingredients #{n + 1}", fb.RPC_GEN_VIDEO_REFERENCES, captcha=cap(fb.RPC_GEN_VIDEO_REFERENCES),
                                  build=lambda: fb.reference_video_request(prompt, project_id, s["ref_media_ids"],
                                                                           s["aspect_code"], model, names)))
        elif kind == "upscale":
            calls.append(Call(s["resolution"], fb.RPC_UPSCALE_IMAGE, captcha=cap(fb.RPC_UPSCALE_IMAGE),
                              build=lambda: fb.upscale_request(s["media_id"], s["resolution"])))
        elif kind == "upload":
            secret = self._secrets.get(job["id"], {})
            calls.append(Call(s.get("file_name") or "upload", fb.RPC_UPLOAD_IMAGE, captcha=cap(fb.RPC_UPLOAD_IMAGE),
                              build=lambda: fb.upload_request(secret.get("b64", ""), project_id,
                                                              s.get("mime_type") or "image/jpeg",
                                                              s.get("file_name") or "upload.jpg")))
        elif kind == "template":
            tpl = self.templates.get(int(s["template_id"]))
            values = {**(s.get("variables") or {}), "project_id": project_id}
            if prompt:
                values.setdefault("prompt", prompt)
            captcha = tpl.get("captcha_action") or cap(tpl["rpcid"])
            calls.append(Call(tpl["name"], tpl["rpcid"], captcha=captcha,
                              build=lambda: fb.build_envelope(tpl["rpcid"], ob.render_template(tpl["inner"], values)),
                              extra={"result_kind": tpl.get("result_kind") or "raw"}))
        return calls

    def _crop(self, media_id: str, video_aspect: int) -> list:
        """The frame crop Flow's UI sends: the image's centre at the video's aspect
        (full frame when the image's aspect is unknown, e.g. an id typed in by hand)."""
        return fb.center_crop((self.media.get(media_id) or {}).get("aspect"), video_aspect)

    def preview(self, spec: dict) -> list[dict]:
        s = self.normalize(spec)
        job = {"id": "preview", "type": s["type"], "spec": s}
        project = s.get("project_id") or self.settings.get("project_id") or "<PROJECT_ID>"
        out = []
        for call in self.plan(job, project):
            freq = call.build()
            items = fb.decode_envelope(freq)
            out.append({"label": call.label, "rpcid": call.rpcid, "captcha_action": call.captcha,
                        "inner": items[0][1] if items else None, "model": s.get("model"),
                        "model_status": s.get("model_status")})
        return out

    # ── public API ──
    def create(self, spec: dict, secret: Optional[dict] = None) -> dict:
        s = self.normalize(spec)
        job_id = uuid.uuid4().hex[:12]
        t = now()
        self.db.insert("jobs", {"id": job_id, "type": s["type"], "status": "queued", "spec": s,
                                "model": s.get("model"), "prompt": s.get("prompt") or s.get("file_name"),
                                "warnings": [], "ops": [], "results": [], "created_at": t, "updated_at": t,
                                "timeout_s": s["timeout_s"], "workspace_id": s.get("workspace_id")})
        if secret:
            self._secrets[job_id] = secret
        self._spawn(job_id, self._run)
        job = self.get(job_id)
        self.events.publish("job", self._brief(job))
        return job

    def get(self, job_id: str, with_log: bool = False) -> Optional[dict]:
        job = self.db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
        if job and with_log:
            job["rpc_log"] = self.db.all("SELECT * FROM rpc_log WHERE job_id=? ORDER BY id", (job_id,))
        return job

    def list(self, status: Optional[str] = None, kind: Optional[str] = None, limit: int = 100) -> list[dict]:
        where, args = [], []
        if status == "active":
            where.append("status IN ('queued','running','polling')")
        elif status:
            where.append("status=?")
            args.append(status)
        if kind:
            where.append("type=?")
            args.append(kind)
        sql = "SELECT * FROM jobs" + (" WHERE " + " AND ".join(where) if where else "")
        return self.db.all(sql + " ORDER BY created_at DESC LIMIT ?", args + [limit])

    async def cancel(self, job_id: str) -> dict:
        job = self.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job["status"] in ACTIVE:
            self.db.update("jobs", "id", job_id, {"status": "canceled", "updated_at": now(), "finished_at": now(),
                                                  "error": "đã huỷ (Flow vẫn có thể render xong)"})
            task = self.tasks.get(job_id)
            if task:
                task.cancel()
        job = self.get(job_id)
        self.events.publish("job", self._brief(job))
        return job

    async def repoll(self, job_id: str) -> dict:
        job = self.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if not any(not op.get("done") for op in job["ops"] or []):
            raise ValueError("không còn operation nào để kiểm tra")
        self.db.update("jobs", "id", job_id, {"status": "polling", "error": None, "poll_started_at": now(),
                                              "updated_at": now(), "finished_at": None})
        if job_id not in self.tasks:
            self._spawn(job_id, self._poll)
        return self.get(job_id)

    def delete(self, job_id: str) -> None:
        task = self.tasks.get(job_id)
        if task:
            task.cancel()
        self.db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        self.db.execute("DELETE FROM rpc_log WHERE job_id=?", (job_id,))
        self.events.publish("job", {"id": job_id, "deleted": True})

    def clear(self) -> None:
        for task in self.tasks.values():
            task.cancel()
        self.tasks.clear()
        self.db.execute("DELETE FROM jobs")
        self.db.execute("DELETE FROM rpc_log")
        self.events.publish("job", {"deleted_all": True})

    # ── persistence ──
    def _brief(self, job: Optional[dict]) -> dict:
        if not job:
            return {}
        return {k: job.get(k) for k in ("id", "type", "status", "model", "prompt", "error", "note",
                                         "updated_at", "worker_id")}

    def _save(self, job: dict, *fields: str) -> None:
        keys = fields or ("status", "error", "warnings", "ops", "results", "note", "worker_id",
                          "poll_started_at", "finished_at")
        values = {k: job.get(k) for k in keys}
        values["updated_at"] = now()
        self.db.update("jobs", "id", job["id"], values)
        self.events.publish("job", self._brief({**job, **values}))

    def _finish(self, job: dict, ok: int, total: int, first_error: Optional[str]) -> None:
        if ok == 0:
            job["status"] = "failed"
            job["error"] = first_error or "không có kết quả"
        else:
            job["status"] = "done" if ok >= total else "partial"
        job["finished_at"] = now()
        job["note"] = None
        self._save(job)
        self._secrets.pop(job["id"], None)
        asyncio.create_task(self._webhook(job["id"]))

    def _fail(self, job: dict, error: str) -> None:
        job["status"] = "failed"
        job["error"] = error[:500]
        job["finished_at"] = now()
        job["note"] = None
        self._save(job)
        self._secrets.pop(job["id"], None)
        asyncio.create_task(self._webhook(job["id"]))

    async def _webhook(self, job_id: str) -> None:
        job = self.get(job_id)
        url = (job or {}).get("spec", {}).get("webhook_url")
        if not url:
            return
        body = {"event": f"job.{job['status']}", "job": job}
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.post(url, json=body)
                if resp.status_code < 400:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(2 * (attempt + 1))
        log.warning("webhook %s failed for job %s", url, job_id)

    # ── calling Flow through a worker ──
    async def _call(self, job: Optional[dict], worker: "Worker", rpcid: str, freq: str, captcha: Optional[str],
                    *, log_call: bool = True, match: Optional[str | list[str]] = None, timeout: float = 300,
                    body_preview: Optional[str] = None) -> Any:
        started = now()
        reqid, result = await self.hub.rpc(worker, rpcid, freq, captcha, match=match, timeout=timeout)
        error = result.get("error")
        if log_call or error:
            self.db.insert("rpc_log", {
                "job_id": (job or {}).get("id"), "worker_id": worker.id, "rpcid": rpcid, "captcha_action": captcha,
                "reqid": reqid, "body": body_preview or _clip(freq, 20000), "status": result.get("status"),
                "response": _clip(result.get("text"), 4000), "error": error, "started_at": started,
                "duration_ms": int((now() - started) * 1000)})
        if error:
            if error.startswith(RESPONSE_LOST):
                raise ResponseLost(f"{rpcid}: {error}", result.get("sent"))
            raise fb.FlowError(f"{rpcid}: {error}")
        if match is not None:
            return result
        text = result.get("text") or ""
        try:
            return fb.first_payload(text, rpcid)
        except fb.FlowError:
            status = result.get("status") or 200
            if status == 400:   # the whole batch refused before reaching the RPC: session, not body
                raise fb.FlowError(f"{rpcid}: HTTP 400 — Flow từ chối cả request (phiên/token `at` không khớp). "
                                   "Tab Flow đăng nhập bằng tài khoản phụ (flow.google.com/u/N/…) cần extension "
                                   "≥ 1.0.3; nếu vẫn lỗi hãy F5 tab Flow")
            if status >= 400:
                raise fb.FlowError(f"{rpcid}: HTTP {status}")
            raise

    def _project_for(self, job: dict, worker: "Worker") -> str:
        pid = job["spec"].get("project_id")
        if pid in ("", "default"):
            pid = None
        if not pid and job["spec"].get("worker_id"):
            pid = (worker.projects or [None])[0]
        if not pid:
            configured_project = self.settings.get("project_id")
            if configured_project in ("", "default"):
                configured_project = None
            pid = configured_project or (worker.projects or [None])[0]
        if not pid:
            raise fb.FlowError("chưa có Flow project id: mở một project trên flow.google.com hoặc đặt trong Cài đặt")
        return pid

    # ── running ──
    async def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        if job is None or job["status"] != "queued":
            return
        try:
            if job["spec"].get("canvas_dependencies"):
                await self._wait_canvas_dependencies(job)
                job = self.get(job_id)
                if job is None or job["status"] not in ACTIVE:
                    return
            worker = self.hub.pick(job["spec"].get("worker_id"),
                                   job["spec"].get("project_id") or self.settings.get("project_id"))
            if worker is None:
                assigned_worker_id = job["spec"].get("worker_id")
                if assigned_worker_id:
                    return self._fail(job, f"Extension {assigned_worker_id[:8]} đang offline; project chỉ chạy qua extension đã liên kết.")
                job["note"] = "Chờ extension (worker) kết nối…"
                self._save(job, "note")
                worker = await self.hub.wait_for(job["spec"].get("worker_id"), float(self.settings.get("wait_worker_s") or 120))
            if worker is None:
                return self._fail(job, "không có worker nào kết nối (mở Chrome có extension Flow Hub + tab Flow)")
            job.update(status="running", worker_id=worker.id, note=None)
            self._save(job)
            project_id = self._project_for(job, worker)
            if job["spec"].get("extract_video_ids") or job["spec"].get("extract_start_video_id"):
                await self._prepare_video_frames(job, worker, project_id)
                job = self.get(job_id)
                if job is None or job["status"] not in ACTIVE:
                    return
            calls = self.plan(job, project_id)
            kind = job["type"]
            if kind in IMAGE_TYPES:
                await self._run_images(job, worker, calls, project_id)
            elif kind in VIDEO_TYPES:
                await self._submit_videos(job, worker, calls)
            elif kind == "upload":
                await self._run_upload(job, worker, calls[0])
            elif kind == "upscale":
                await self._run_upscale(job, worker, calls[0])
            elif kind == "template":
                await self._run_template(job, worker, calls[0])
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — reported on the job, never swallowed
            log.exception("job %s failed", job_id)
            current = self.get(job_id)
            if current and current["status"] in ACTIVE:
                self._fail(job, str(exc))

    async def _wait_canvas_dependencies(self, job: dict) -> None:
        """Wait for upstream Canvas jobs, then attach their media to this spec."""
        spec = job["spec"]
        dependencies = spec.get("canvas_dependencies") or []
        started = asyncio.get_running_loop().time()
        # Waiting for a chain must not consume the generation's own timeout.
        timeout = max(float(spec.get("timeout_s") or 600), 24 * 60 * 60)
        resolved: list[tuple[dict, str]] = []
        while len(resolved) < len(dependencies):
            current = self.get(job["id"])
            if current is None or current["status"] not in ACTIVE:
                return
            for dep in dependencies[len(resolved):]:
                request_id = dep.get("request_id")
                if not request_id:
                    latest = self.db.one(
                        "SELECT id FROM canvas_requests WHERE node_id=? AND created_at>? ORDER BY created_at DESC LIMIT 1",
                        (str(dep["source_node_id"]), float(dep.get("after_created_at") or 0)),
                    )
                    if latest:
                        request_id = latest["id"]
                        dep["request_id"] = request_id
                        self.db.update("jobs", "id", job["id"], {"spec": spec})
                    else:
                        source_node = self.db.one("SELECT status FROM canvas_nodes WHERE id=?", (dep["source_node_id"],))
                        if not source_node or source_node["status"] not in {"idle", "queued", "running"}:
                            raise fb.FlowError(f"node nguồn #{dep.get('source_node_id')} không tạo được request")
                        break
                request = self.db.one("SELECT job_id FROM canvas_requests WHERE id=?", (request_id,))
                if not request:
                    raise fb.FlowError(f"node nguồn #{dep.get('source_node_id')} không còn request để chờ")
                upstream = self.get(request["job_id"])
                if not upstream:
                    raise fb.FlowError(f"node nguồn #{dep.get('source_node_id')} mất job")
                if upstream["status"] in ACTIVE:
                    break
                if upstream["status"] != "done":
                    detail = upstream.get("error") or upstream["status"]
                    raise fb.FlowError(f"dừng chuỗi: node nguồn #{dep.get('source_node_id')} thất bại ({detail})")
                outputs = upstream.get("results") or []
                idx = dep.get("source_variant_idx")
                output = outputs[idx] if isinstance(idx, int) and 0 <= idx < len(outputs) else (outputs[0] if outputs else None)
                media_id = (output or {}).get("media_id")
                if not media_id:
                    raise fb.FlowError(f"node nguồn #{dep.get('source_node_id')} hoàn tất nhưng không có media")
                resolved.append((dep, str(media_id)))
            else:
                break
            if asyncio.get_running_loop().time() - started > timeout:
                raise fb.FlowError("hết thời gian chờ node nguồn hoàn tất")
            job["note"] = "Đang chờ node nguồn hoàn tất…"
            self._save(job, "note")
            await asyncio.sleep(1.5)

        for dep, media_id in resolved:
            is_video = dep.get("source_type") == "video"
            kind = spec.get("type")
            if kind in IMAGE_TYPES:
                key = "extract_video_ids" if is_video else "ref_media_ids"
            elif kind == "i2v":
                key = "extract_video_ids" if is_video else "start_media_ids"
            elif kind == "r2v":
                key = "extract_video_ids" if is_video else "ref_media_ids"
            else:
                continue
            old_ids = set(dep.get("previous_media_ids") or [])
            if old_ids:
                spec[key] = [value for value in (spec.get(key) or []) if value not in old_ids]
                if is_video and spec.get("extract_start_video_id") in old_ids:
                    spec.pop("extract_start_video_id", None)
                if not is_video and spec.get("start_media_id") in old_ids:
                    spec.pop("start_media_id", None)
            spec[key] = list(dict.fromkeys([*(spec.get(key) or []), media_id]))
        spec.pop("canvas_dependencies", None)
        self.db.update("jobs", "id", job["id"], {"spec": spec})
        job["spec"] = spec
        if spec.get("extract_video_ids"):
            spec["stage"] = "extracting_frames"
            spec["extracted_video_frames"] = {}
            self.db.update("jobs", "id", job["id"], {"spec": spec})

    async def _prepare_video_frames(self, job: dict, worker: "Worker", project_id: str) -> None:
        """Extract and upload source-video frames server-side, checkpointing each one."""
        spec = job["spec"]
        spec["stage"] = "extracting_frames"
        spec.setdefault("extracted_video_frames", {})
        self.db.update("jobs", "id", job["id"], {"spec": spec})
        video_ids = list(dict.fromkeys(spec.get("extract_video_ids") or []))
        if spec.get("extract_start_video_id"):
            video_ids.append(spec["extract_start_video_id"])
        video_ids = list(dict.fromkeys(video_ids))
        workspace_id = job.get("workspace_id") or spec.get("workspace_id")

        for video_id in video_ids:
            if spec["extracted_video_frames"].get(video_id):
                continue
            source = self.media.get(video_id)
            if not source or source.get("kind") != "video":
                raise fb.FlowError(f"media nguồn {video_id} không phải video")
            if workspace_id and source.get("workspace_id") != workspace_id:
                raise fb.FlowError(f"video nguồn {video_id} không thuộc Canvas project hiện tại")
            path = self.media.local_file(video_id) or await self.media.download(video_id, worker.id)
            if not path:
                raise fb.FlowError(f"không tải được video nguồn {video_id} về backend để trích frame")
            image_bytes = await self._extract_last_frame(path)
            image_id = await self._upload_frame(job, worker, project_id, video_id, image_bytes)
            spec["extracted_video_frames"][video_id] = image_id
            self.db.update("jobs", "id", job["id"], {"spec": spec})
            job["spec"] = spec

        frame_ids = [spec["extracted_video_frames"][video_id] for video_id in video_ids]
        if spec.get("type") == "r2v":
            spec["ref_media_ids"] = list(spec.get("ref_media_ids") or []) + frame_ids
            if spec.get("ref_media_names") is not None:
                spec["ref_media_names"] = list(spec["ref_media_names"]) + [
                    f"last_frame_{video_id[:12]}.jpg" for video_id in video_ids
                ]
        elif spec.get("type") in IMAGE_TYPES:
            spec["ref_media_ids"] = list(spec.get("ref_media_ids") or []) + frame_ids
        elif spec.get("type") == "i2v":
            spec["start_media_ids"] = list(spec.get("start_media_ids") or []) + frame_ids
        spec.pop("extract_video_ids", None)
        spec.pop("extract_start_video_id", None)
        spec.pop("extracted_video_frames", None)
        spec.pop("stage", None)
        self.db.update("jobs", "id", job["id"], {"spec": spec})
        job["spec"] = spec

    async def _extract_last_frame(self, path) -> bytes:
        try:
            process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-sseof", "-5",
                "-i", str(path), "-vf", "reverse", "-frames:v", "1", "-f", "image2pipe",
                "-an", "-vcodec", "mjpeg", "pipe:1", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=120)
        except FileNotFoundError as exc:
            raise fb.FlowError("backend chưa cài ffmpeg để trích frame video") from exc
        except asyncio.TimeoutError as exc:
            raise fb.FlowError("trích frame video vượt quá 120 giây") from exc
        if process.returncode != 0 or not stdout:
            detail = stderr.decode("utf-8", errors="replace")[-500:]
            raise fb.FlowError(f"ffmpeg không trích được frame cuối: {detail}")
        return stdout

    async def _upload_frame(self, job: dict, worker: "Worker", project_id: str, source_video_id: str, data: bytes) -> str:
        file_name = f"last_frame_{source_video_id[:12]}.jpg"
        encoded = base64.b64encode(data).decode("ascii")
        call = fb.upload_request(encoded, project_id, "image/jpeg", file_name)
        uploaded_id = fb.read_uploaded_media_id(await self._call(
            job, worker, fb.RPC_UPLOAD_IMAGE, call, self.observations.captcha_action_for(fb.RPC_UPLOAD_IMAGE),
            body_preview=call.replace(encoded, f"<base64: {len(encoded)} ký tự>"), timeout=180,
        ))
        urls = await self._media_urls(job, worker, uploaded_id)
        workspace_id = job.get("workspace_id") or job["spec"].get("workspace_id")
        self.media.upsert({"id": uploaded_id, "kind": "image", "url": urls[1] if urls else None,
                           "prompt": file_name, "source": "video_frame", "job_id": job["id"],
                           "workspace_id": workspace_id})
        self.media.save_bytes(uploaded_id, data, "image/jpeg")
        return uploaded_id

    async def _run_images(self, job: dict, worker: "Worker", calls: list[Call], project_id: str) -> None:
        gap = float(self.settings.get("min_submit_gap_s") or 0)
        s = job["spec"]
        first_error = None
        expected = 0
        for call in calls:
            texts = call.extra.get("texts") or [call.text]
            expected += len(texts)
            try:
                await worker.pace(gap)
                images = await self._image_call(job, worker, call, project_id, len(texts))
            except fb.FlowError as exc:
                first_error = first_error or str(exc)
                job["warnings"].append(f"{call.label}: {exc}")
                continue
            if len(images) < len(texts):
                job["warnings"].append(f"{call.label}: Flow trả về {len(images)}/{len(texts)} ảnh")
            for i, (media_id, url) in enumerate(images):
                job["results"].append({"kind": "image", "media_id": media_id, "url": url})
                self.media.upsert({"id": media_id, "kind": "image", "url": url,
                                   "prompt": texts[i] if i < len(texts) else call.text, "model": s.get("model"),
                                   "source": job["type"], "job_id": job["id"], "aspect": s.get("aspect"),
                                   "workspace_id": job.get("workspace_id", s.get("workspace_id"))})
                self._download(media_id)
        self._finish(job, len(job["results"]), expected, first_error)

    async def _image_call(self, job: dict, worker: "Worker", call: Call, project_id: str,
                          expected: int) -> list[tuple[str, str]]:
        """[(media_id, url)] of one ogiZ0b call, in item order. References and
        the edited base image are never counted as results."""
        exclude = set(call.extra.get("exclude") or [])
        freq = call.build()
        try:
            payload = await self._call(job, worker, call.rpcid, freq, call.captcha)
        except ResponseLost as exc:
            if exc.sent is False:
                raise fb.FlowError(f"{exc} — request chưa rời tab nên Flow chưa nhận, hãy tạo lại") from exc
            found = await self._recover_images(job, project_id, freq, expected, exclude)
            if not found:
                raise fb.FlowError(f"{exc} — không tìm thấy ảnh trong project sau {IMAGE_RECOVER_S}s "
                                   "(ảnh có thể vẫn hiện trên flow.google.com)") from exc
            job["warnings"].append(f"{call.label}: {exc} — đã lấy lại {len(found)} ảnh từ project")
            return found
        images = [im for im in fb.read_images(payload) if im[0] not in exclude]
        if not images:
            raise fb.FlowError("ogiZ0b trả về không có url ảnh")
        return images

    async def _recover_images(self, job: dict, project_id: str, freq: str, expected: int,
                              exclude: set) -> list[tuple[str, str]]:
        """An ogiZ0b answer was lost (the Flow tab reloaded mid-call), yet Flow
        renders the images anyway: find them in the project listing by the
        request's client uuids, then ask as29s for their urls."""
        client_ids = fb.image_client_ids(freq)
        if not client_ids:
            return []
        job["note"] = "Tab Flow tải lại giữa lúc chờ ảnh — đang tìm ảnh trong project…"
        self._save(job, "note")
        every = 2 * float(self.settings.get("poll_interval_s") or 5)   # the listing is MBs: half the video poll rate
        deadline = now() + IMAGE_RECOVER_S
        found: dict[str, str] = {}
        while now() < deadline and len(found) < expected:
            await asyncio.sleep(every)
            assigned_worker_id = job.get("worker_id") or job["spec"].get("worker_id")
            worker = self.hub.pick(assigned_worker_id) if assigned_worker_id else self.hub.pick()
            if worker is None:
                continue
            try:
                listing = await self._call(job, worker, fb.RPC_PROJECT_MEDIA, fb.project_media_request(project_id),
                                           None, log_call=False, match=client_ids, timeout=120)
            except fb.FlowError:
                continue   # the reloaded page may not be ready yet
            text = (listing.get("text") or "") if listing.get("matched") else ""
            for media_id in fb.find_media_ids_before(text, client_ids):
                if media_id in found or media_id in exclude:
                    continue
                urls = await self._media_urls(job, worker, media_id)
                if urls and urls[1]:
                    found[media_id] = urls[1]
        return list(found.items())

    async def _submit_videos(self, job: dict, worker: "Worker", calls: list[Call]) -> None:
        gap = float(self.settings.get("min_submit_gap_s") or 0)
        first_error = None
        for call in calls:   # sequential: each submit mints its own reCAPTCHA in the page
            try:
                await worker.pace(gap)
                sub = fb.read_video_submit(await self._call(job, worker, call.rpcid, call.build(), call.captcha,
                                                            timeout=180))
                job["ops"].append({"id": sub["operation_id"], "label": call.label, "media_id": sub["media_id"],
                                   "project_id": sub["project_id"], "status": sub["status"], "rounds": 0,
                                   "done": False, "complaint": None})
            except fb.FlowError as exc:
                first_error = first_error or str(exc)
                job["warnings"].append(f"{call.label}: {exc}")
            self._save(job, "ops", "warnings")
        if not job["ops"]:
            return self._fail(job, first_error or "video submit không trả về operation")
        job["status"] = "polling"
        job["poll_started_at"] = now()
        job["expected"] = len(calls)
        self._save(job)
        self.db.update("jobs", "id", job["id"], {"spec": {**job["spec"], "expected": len(calls)}})
        self._spawn(job["id"], self._poll)

    async def _poll(self, job_id: str) -> None:
        interval = float(self.settings.get("poll_interval_s") or 5)
        try:
            while True:
                job = self.get(job_id)
                if job is None or job["status"] != "polling":
                    return
                pending = [op for op in job["ops"] if not op.get("done")]
                if not pending:
                    break
                if now() - (job["poll_started_at"] or now()) > (job["timeout_s"] or 600):
                    job["status"] = "timeout"
                    job["error"] = "hết thời gian chờ — video có thể vẫn đang render, bấm Kiểm tra lại"
                    job["finished_at"] = now()
                    self._save(job)
                    asyncio.create_task(self._webhook(job_id))
                    return
                await asyncio.sleep(interval)
                assigned_worker_id = job.get("worker_id") or job["spec"].get("worker_id")
                worker = self.hub.pick(assigned_worker_id) if assigned_worker_id else self.hub.pick()
                if worker is None:
                    job["note"] = "Mất kết nối worker — chờ kết nối lại để poll tiếp"
                    self._save(job, "note")
                    continue
                job["note"] = None
                await self._poll_round(job, worker, pending)
                if (self.get(job_id) or {}).get("status") != "polling":
                    return
                self._save(job, "ops", "results", "warnings", "note")
            job = self.get(job_id)
            done = sum(1 for op in job["ops"] if op.get("done"))
            expected = job["spec"].get("expected") or len(job["ops"])
            self._finish(job, done, expected, (job["warnings"] or [None])[0])
        except asyncio.CancelledError:
            return

    async def _media_urls(self, job: dict, worker: "Worker", media_id: str):
        try:
            payload = await self._call(job, worker, fb.RPC_MEDIA, fb.media_request(media_id), None,
                                       log_call=False, timeout=60)
            return fb.read_media_urls(payload)
        except fb.FlowError:
            return None

    async def _poll_round(self, job: dict, worker: "Worker", pending: list[dict]) -> None:
        records: Optional[dict] = None
        try:
            payload = await self._call(job, worker, fb.RPC_OPERATION, fb.operation_request([op["id"] for op in pending]),
                                       None, log_call=False, timeout=60)
            records = {o.operation_id: o for o in fb.read_operations(payload)}
        except fb.FlowError as exc:
            for op in pending:
                op["complaint"] = str(exc)[:200]
        for op in pending:
            op["rounds"] = op.get("rounds", 0) + 1
            rec = records.get(op["id"]) if records is not None else None
            worth = op["rounds"] % 3 == 0 or rec is None
            if rec is not None:
                op["status"] = rec.status
                op["complaint"] = rec.complaint   # "Media not found." is survivable, never fatal
                worth = worth or rec.done or bool(rec.complaint)
            if not worth:
                continue
            for media_id in dict.fromkeys([op.get("media_id"), op["id"]]):
                if not media_id:
                    continue
                urls = await self._media_urls(job, worker, media_id)
                if not urls or not (urls[0] or urls[1]):
                    continue
                op["media_id"] = media_id         # as29s knows it: this is the media id
                op["poster_url"] = urls[1] or op.get("poster_url")
                if urls[0]:
                    self._finish_op(job, op, media_id, urls)
                break
            if op.get("done") or op.get("media_id"):
                continue
            try:   # fallback the September 2026 notes relied on
                listing = await self._call(job, worker, fb.RPC_PROJECT_MEDIA,
                                           fb.project_media_request(op.get("project_id") or self._project_for(job, worker)),
                                           None, log_call=False, match=op["id"], timeout=120)
                media_id = fb.find_media_id_in_text(listing.get("text") or "", op["id"]) if listing.get("matched") else None
            except fb.FlowError:
                media_id = None
            if media_id:
                op["media_id"] = media_id
                urls = await self._media_urls(job, worker, media_id)
                if urls and urls[0]:
                    self._finish_op(job, op, media_id, urls)

    def _finish_op(self, job: dict, op: dict, media_id: str, urls: tuple) -> None:
        video, poster = urls
        op.update(done=True, url=video, poster_url=poster)
        job["results"].append({"kind": "video", "media_id": media_id, "url": video, "poster_url": poster})
        s = job["spec"]
        self.media.upsert({"id": media_id, "kind": "video", "url": video, "poster_url": poster, "prompt": s.get("prompt"),
                           "model": s.get("model"), "source": job["type"], "job_id": job["id"], "aspect": s.get("aspect"),
                           "workspace_id": job.get("workspace_id", s.get("workspace_id"))})
        self._download(media_id)

    async def _run_upload(self, job: dict, worker: "Worker", call: Call) -> None:
        secret = self._secrets.get(job["id"]) or {}
        b64 = secret.get("b64")
        if not b64:
            return self._fail(job, "mất dữ liệu ảnh upload (server khởi động lại?)")
        freq = call.build()
        preview = freq.replace(b64, f"<base64: {len(b64)} ký tự>")
        media_id = fb.read_uploaded_media_id(await self._call(job, worker, call.rpcid, freq, call.captcha,
                                                              body_preview=_clip(preview, 20000), timeout=180))
        urls = await self._media_urls(job, worker, media_id)
        url = urls[1] if urls else None
        s = job["spec"]
        data = base64.b64decode(b64)
        self.media.upsert({"id": media_id, "kind": "image", "url": url, "prompt": s.get("file_name"), "source": "upload",
                           "job_id": job["id"], "aspect": image_aspect(data),
                           "workspace_id": job.get("workspace_id", s.get("workspace_id"))})
        self.media.save_bytes(media_id, data, s.get("mime_type"))
        job["results"].append({"kind": "image", "media_id": media_id, "url": url})
        self._finish(job, 1, 1, None)

    async def _run_upscale(self, job: dict, worker: "Worker", call: Call) -> None:
        s = job["spec"]
        encoded = fb.read_upscaled_image(await self._call(job, worker, call.rpcid, call.build(), call.captcha, timeout=240))
        new_id = f"upscale-{s['resolution'].lower()}-{s['media_id']}"
        source = self.media.get(s["media_id"]) or {}
        self.media.upsert({"id": new_id, "kind": "image", "prompt": source.get("prompt"), "source": "upscale",
                           "job_id": job["id"], "note": f"Upscale {s['resolution']} của {s['media_id']}",
                           "workspace_id": s.get("workspace_id", source.get("workspace_id"))})
        self.media.save_bytes(new_id, base64.b64decode(encoded))
        job["results"].append({"kind": "image", "media_id": new_id, "local": True})
        self._finish(job, 1, 1, None)

    async def _run_template(self, job: dict, worker: "Worker", call: Call) -> None:
        kind = call.extra.get("result_kind") or "raw"
        freq = call.build()
        if kind == "image":
            job["spec"]["aspect"] = job["spec"].get("aspect")
            payload = await self._call(job, worker, call.rpcid, freq, call.captcha)
            images = fb.read_images(payload)
            for media_id, url in images:
                job["results"].append({"kind": "image", "media_id": media_id, "url": url})
                self.media.upsert({"id": media_id, "kind": "image", "url": url, "prompt": job["spec"].get("prompt"),
                                   "source": "template", "job_id": job["id"]})
                self._download(media_id)
            return self._finish(job, len(images), 1, "template không trả về ảnh")
        if kind == "video":
            await self._submit_videos(job, worker, [Call(call.label, call.rpcid, lambda: freq, call.captcha)])
            return
        payload = await self._call(job, worker, call.rpcid, freq, call.captcha)
        job["results"].append({"kind": "raw", "data": ob.shrink(payload)})
        self._finish(job, 1, 1, None)

    def _download(self, media_id: str) -> None:
        if self.settings.get("download_media"):
            asyncio.create_task(self.media.download(media_id))

    # ── one-off calls from the dashboard / API ──
    async def raw_rpc(self, rpcid: str, freq: str, captcha: Optional[str], worker_id: Optional[str] = None) -> dict:
        worker = self.hub.pick(worker_id)
        if worker is None:
            raise fb.FlowError("không có worker nào kết nối")
        started = now()
        reqid, result = await self.hub.rpc(worker, rpcid, freq, captcha, timeout=300)
        self.db.insert("rpc_log", {"job_id": None, "worker_id": worker.id, "rpcid": rpcid, "captcha_action": captcha,
                                   "reqid": reqid, "body": _clip(freq, 20000), "status": result.get("status"),
                                   "response": _clip(result.get("text"), 4000), "error": result.get("error"),
                                   "started_at": started, "duration_ms": int((now() - started) * 1000)})
        out = {"status": result.get("status"), "error": result.get("error"), "text": _clip(result.get("text"), 200000)}
        if result.get("text"):
            out["decoded"] = ob.decode_response(result["text"])
        return out

    async def refresh_media(self, media_id: str, worker_id: Optional[str] = None) -> dict:
        worker = self.hub.pick(worker_id) if worker_id else self.hub.pick()
        if worker is None:
            if worker_id:
                raise fb.FlowError(f"extension {worker_id[:8]} offline")
            raise fb.FlowError("không có worker nào kết nối")
        payload = await self._call(None, worker, fb.RPC_MEDIA, fb.media_request(media_id), None, log_call=False, timeout=60)
        video, image = fb.read_media_urls(payload)
        if not video and not image:
            raise fb.FlowError("as29s không trả về url cho media id này")
        existing = self.media.get(media_id) or {}
        kind = "video" if video else (existing.get("kind") or "image")
        row = self.media.upsert({"id": media_id, "kind": kind, "url": video or image,
                                 "poster_url": image if video else None, "source": existing.get("source") or "manual"})
        self._download(media_id)
        return row
