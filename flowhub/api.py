"""REST API (prefix /api). Interactive docs at /docs.

Auth: when enabled, every call needs `X-API-Key: <key>` (or `?key=` for links
and the event stream). The dashboard asks for the key once and remembers it.
"""
from __future__ import annotations

import base64
from copy import deepcopy
import json
import os
import secrets
import string
import tempfile
import time
import zipfile
from typing import Any, Literal, Optional

from fastapi.security import APIKeyHeader
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import canvas_chain
from .catalog import MODES
from .canvas_project_import import CanvasProjectImportError, import_canvas_project, new_public_id
from .canvas_project_json import CanvasProjectExportError, build_canvas_project_snapshot
from .config import VERSION
from .presets import build_character_prompt, presets
from .protocol import batch as fb
from .protocol import observe as ob


def core_of(request: Request):
    return request.app.state.core


api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

def require_key(request: Request, header_key: Optional[str] = Depends(api_key_header)) -> None:
    core = core_of(request)
    if not core.config.auth_enabled:
        return
    key = header_key or request.headers.get("x-api-key") or request.query_params.get("key") or ""
    if not key or not secrets.compare_digest(key, core.api_key):
        raise HTTPException(401, "Thiếu hoặc sai API key (header X-API-Key)")


router = APIRouter(prefix="/api")
api = APIRouter(dependencies=[Depends(require_key)])


def _bad(exc: Exception) -> HTTPException:
    return HTTPException(400, str(exc))


def _new_project_id() -> str:
    return new_public_id()


def _assert_canvas_extension_online(core: Any, worker_id: Optional[str]) -> None:
    if not worker_id:
        return
    worker = core.hub.workers.get(worker_id)
    if worker is None:
        raise HTTPException(409, f"Extension {worker_id[:8]} đang offline. Project này chỉ chạy qua extension đã liên kết.")
    if not worker.projects:
        raise HTTPException(409, f"Extension {worker.label} chưa mở project nào trên Flow.")


# ── Canvas boards (persisted in the same SQLite database as jobs) ──

class CanvasBoardCreate(BaseModel):
    name: str = "Untitled"
    project_id: str = "default"
    viewport: Optional[dict[str, float]] = None
    worker_id: Optional[str] = None
    flow_project_id: Optional[str] = None


class CanvasBoardPatch(BaseModel):
    name: Optional[str] = None
    viewport: Optional[dict[str, float]] = None
    worker_id: Optional[str] = None
    flow_project_id: Optional[str] = None


class CanvasBoardImport(BaseModel):
    boards: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    requests: list[dict[str, Any]] = []


class CanvasNodeCreate(BaseModel):
    board_id: int
    type: str
    x: float = 0
    y: float = 0
    data: dict[str, Any] = {}


class CanvasEdgeCreate(BaseModel):
    board_id: int
    source_id: int
    target_id: int


class CanvasRequestCreate(BaseModel):
    type: str
    node_id: Optional[str | int] = None
    params: dict[str, Any] = {}
    spec: dict[str, Any]
    workspace_id: Optional[str] = None


def _canvas_node(row: dict) -> dict:
    row["data"] = json.loads(row.get("data") or "{}") if isinstance(row.get("data"), str) else row.get("data", {})
    return row


@api.get("/boards", tags=["canvas"])
async def list_canvas_boards(request: Request):
    return core_of(request).db.all("""SELECT b.id, b.public_id, b.name, b.project_id, b.created_at, b.worker_id, b.flow_project_id,
        (SELECT COUNT(*) FROM canvas_nodes n WHERE n.board_id=b.id) AS node_count,
        (SELECT COUNT(*) FROM media m WHERE m.workspace_id=b.public_id AND m.kind='video') AS video_count,
        (SELECT COUNT(*) FROM media m WHERE m.workspace_id=b.public_id AND m.kind='image') AS image_count
        FROM canvas_boards b ORDER BY b.id DESC""")


@api.post("/boards", tags=["canvas"], status_code=201)
async def create_canvas_board(body: CanvasBoardCreate, request: Request):
    core = core_of(request)
    db = core.db
    if body.worker_id is not None and not db.one("SELECT id FROM workers WHERE id=?", (body.worker_id,)):
        raise HTTPException(404, "Kh\u00f4ng t\u00ecm th\u1ea5y extension n\u00e0y")
    public_id = _new_project_id()
    board_id = db.insert("canvas_boards", {"name": body.name, "project_id": body.project_id,
                                             "public_id": public_id, "created_at": time.time(),
                                             "viewport": body.viewport, "worker_id": body.worker_id,
                                             "flow_project_id": body.flow_project_id})
    core.media.project_dir(public_id)
    if db.one("SELECT COUNT(*) AS n FROM canvas_boards")["n"] == 1:
        db.execute("UPDATE jobs SET workspace_id=? WHERE workspace_id IS NULL", (public_id,))
        db.execute("UPDATE media SET workspace_id=? WHERE workspace_id IS NULL", (public_id,))
    return db.one("SELECT id, public_id, name, project_id, created_at, viewport, worker_id, flow_project_id FROM canvas_boards WHERE id=?", (board_id,))


@api.get("/boards/{board_id}", tags=["canvas"])
async def get_canvas_board(board_id: int, request: Request):
    db = core_of(request).db
    board = db.one("SELECT id, public_id, name, project_id, created_at, viewport, worker_id, flow_project_id FROM canvas_boards WHERE id=?", (board_id,))
    if not board:
        raise HTTPException(404, "không tìm thấy canvas")
    nodes = [_canvas_node(n) for n in db.all("SELECT * FROM canvas_nodes WHERE board_id=? ORDER BY id", (board_id,))]
    for canvas_node in nodes:
        latest_request = db.one(
            "SELECT r.id,j.status FROM canvas_requests r JOIN jobs j ON j.id=r.job_id "
            "WHERE r.node_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 1",
            (str(canvas_node["id"]),),
        )
        if latest_request:
            stored_request_id = canvas_node["data"].get("lastRequestId")
            if stored_request_id is None:
                # Older nodes have no request pointer at all. Preserve an
                # explicit null written by a new dispatch that failed before
                # the server created its request.
                if "lastRequestId" not in canvas_node["data"]:
                    canvas_node["data"]["lastRequestId"] = latest_request["id"]
                    canvas_node["data"]["lastRequestStatus"] = latest_request["status"]
            elif stored_request_id == latest_request["id"]:
                canvas_node["data"]["lastRequestStatus"] = latest_request["status"]
    edges = db.all("SELECT * FROM canvas_edges WHERE board_id=? ORDER BY id", (board_id,))
    return {"board": board, "nodes": nodes, "edges": edges}


@api.get("/boards/{board_id}/export", tags=["canvas"])
async def export_canvas_board(board_id: int, request: Request):
    try:
        return await build_canvas_project_snapshot(core_of(request), board_id)
    except CanvasProjectExportError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc


@api.post("/boards/import-project", tags=["canvas"], status_code=201)
async def import_canvas_project_endpoint(request: Request):
    """Rebuild a whole canvas project from an exported `flow-hub-canvas-project` file.

    The body is the raw JSON document (what the dashboard's "Export JSON"
    button downloads). Validation happens before anything is written; the
    write itself runs in a single transaction, so a bad file never leaves a
    half-imported board behind.
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "File không phải JSON hợp lệ.") from None
    try:
        return import_canvas_project(core_of(request), payload)
    except CanvasProjectImportError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc


@api.patch("/boards/{board_id}", tags=["canvas"])
async def rename_canvas_board(board_id: int, body: CanvasBoardPatch, request: Request):
    db = core_of(request).db
    if not db.one("SELECT id FROM canvas_boards WHERE id=?", (board_id,)):
        raise HTTPException(404, "không tìm thấy canvas")
    changes = {key: value for key, value in body.model_dump(exclude_unset=True).items()
               if value is not None or key == "flow_project_id"}
    if "worker_id" in body.model_fields_set:
        changes["worker_id"] = body.worker_id
        if body.worker_id is not None and not db.one("SELECT id FROM workers WHERE id=?", (body.worker_id,)):
            raise HTTPException(404, "Không tìm thấy client extension này")
    db.update("canvas_boards", "id", board_id, changes)
    return db.one("SELECT id, public_id, name, project_id, created_at, viewport, worker_id, flow_project_id FROM canvas_boards WHERE id=?", (board_id,))


@api.delete("/boards/{board_id}", tags=["canvas"])
async def delete_canvas_board(board_id: int, request: Request):
    core = core_of(request)
    db = core.db
    project = db.one("SELECT id, public_id FROM canvas_boards WHERE id=?", (board_id,))
    if not project:
        raise HTTPException(404, "không tìm thấy project")
    # Cancel and remove project jobs before deleting results and canvas data.
    job_ids = [row["id"] for row in db.all("SELECT id FROM jobs WHERE workspace_id=?", (project["public_id"],))]
    for job_id in job_ids:
        core.jobs.delete(job_id)
    core.media.delete_workspace(project["public_id"])
    with db.transaction():
        db.execute("DELETE FROM canvas_edges WHERE board_id=?", (board_id,))
        db.execute("DELETE FROM canvas_nodes WHERE board_id=?", (board_id,))
        db.execute("DELETE FROM canvas_boards WHERE id=?", (board_id,))
    return {"ok": True}


def _remove_file(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _video_export_names(db: Any, board_id: int, public_id: str) -> dict[str, str]:
    """Map video media ids to ordered, node-labelled archive filenames."""
    rows = db.all("SELECT id, type, short_id, x, y, data FROM canvas_nodes WHERE board_id=?", (board_id,))
    nodes: dict[int, dict[str, Any]] = {}
    for row in rows:
        data = row.get("data")
        if isinstance(data, str):
            try:
                data = json.loads(data or "{}")
            except (TypeError, ValueError):
                data = {}
        row["data"] = data if isinstance(data, dict) else {}
        nodes[int(row["id"])] = row

    # Walk the directed canvas chain in stable order. Unconnected and legacy
    # nodes are appended by position and id so every board gets reproducible
    # filenames, even when it has disconnected branches.
    edges = db.all("SELECT source_id, target_id, id FROM canvas_edges WHERE board_id=? ORDER BY id", (board_id,))
    outgoing: dict[int, list[int]] = {node_id: [] for node_id in nodes}
    incoming: set[int] = set()
    for edge in edges:
        source, target = int(edge["source_id"]), int(edge["target_id"])
        if source in nodes and target in nodes:
            outgoing[source].append(target)
            incoming.add(target)

    def position(node_id: int) -> tuple[float, float, int]:
        node = nodes[node_id]
        return (float(node.get("x") or 0), float(node.get("y") or 0), node_id)

    ordered: list[int] = []
    seen: set[int] = set()

    def visit(node_id: int) -> None:
        if node_id in seen:
            return
        seen.add(node_id)
        ordered.append(node_id)
        for target in sorted(outgoing[node_id], key=position):
            visit(target)

    for node_id in sorted((n for n in nodes if n not in incoming), key=position):
        visit(node_id)
    for node_id in sorted(nodes, key=position):
        visit(node_id)

    media_to_filename: dict[str, str] = {}
    index = 0
    for node_id in ordered:
        node = nodes[node_id]
        if node.get("type") != "video":
            continue
        data = node["data"]
        media_ids = data.get("mediaIds") if isinstance(data.get("mediaIds"), list) else []
        media_ids = [str(value) for value in [data.get("mediaId"), *media_ids] if value]
        title = str(data.get("title") or node.get("short_id") or f"video-{node_id}")
        safe_title = "".join(ch if ch.isalnum() or ch in "-_ " else "_" for ch in title).strip(" ._-") or f"video-{node_id}"
        for media_id in dict.fromkeys(media_ids):
            media = db.one("SELECT kind, workspace_id FROM media WHERE id=?", (media_id,))
            if not media or media.get("kind") != "video" or media.get("workspace_id") != public_id:
                continue
            index += 1
            path = db.one("SELECT local_path, mime FROM media WHERE id=?", (media_id,)) or {}
            ext = os.path.splitext((path.get("local_path") or ""))[1]
            if not ext:
                ext = {"video/mp4": ".mp4", "video/webm": ".webm"}.get(path.get("mime"), ".bin")
            media_to_filename[media_id] = f"{index:03d}_{safe_title}{ext}"
    return media_to_filename


@api.get("/projects/{public_id}/media.zip", tags=["canvas"])
async def export_project_media(public_id: str, request: Request, background: BackgroundTasks):
    """Bulk export: every local media file of the project, zipped.

    The project id is the folder name under data/media, so the zip mirrors the
    folder layout. It is spooled to a temp file (videos are big) and removed
    once the download has been sent.
    """
    core = core_of(request)
    project = core.db.one("SELECT id, public_id, name FROM canvas_boards WHERE public_id=?", (public_id,))
    if not project:
        raise HTTPException(404, "không tìm thấy project")
    folder = core.media.project_dir(project["public_id"])
    if not any(path.is_file() for path in folder.iterdir()):
        raise HTTPException(404, "project chưa có media nào")
    fd, tmp = tempfile.mkstemp(suffix=".zip", prefix="media-export-")
    os.close(fd)
    video_names = _video_export_names(core.db, project["id"], project["public_id"])
    media_by_path = {
        os.path.abspath(row["local_path"]): row["id"]
        for row in core.db.all("SELECT id, local_path FROM media WHERE workspace_id=? AND local_path IS NOT NULL", (project["public_id"],))
    }
    media_by_id = {
        row["id"]: row["id"]
        for row in core.db.all("SELECT id FROM media WHERE workspace_id=?", (project["public_id"],))
    }
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(folder.iterdir()):
            if path.is_file():
                media_id = media_by_path.get(os.path.abspath(path)) or media_by_id.get(path.stem)
                name = video_names.get(media_id, path.name) if media_id else path.name
                zf.write(path, arcname=f"{project['public_id']}/{name}")
    background.add_task(_remove_file, tmp)
    return FileResponse(tmp, media_type="application/zip", filename=f"{project['public_id']}-media.zip")


@api.post("/boards/import", tags=["canvas"])
async def import_canvas_localstorage(body: CanvasBoardImport, request: Request):
    """One-time migration endpoint for boards stored by older browser builds."""
    db = core_of(request).db
    with db.transaction():
        boards_imported = not db.one("SELECT id FROM canvas_boards LIMIT 1")
        if boards_imported:
            id_map: dict[int, int] = {}
            for b in body.boards:
                old_id = int(b.get("id", 0))
                public_id = _new_project_id()
                db.execute("INSERT INTO canvas_boards(id,name,project_id,public_id,created_at) VALUES(?,?,?,?,?)",
                           (old_id or None, b.get("name") or "Untitled", b.get("project_id") or "default",
                            public_id, time.time()))
                core_of(request).media.project_dir(public_id)
                new_id = old_id or db.one("SELECT last_insert_rowid() AS id")["id"]
                id_map[old_id] = new_id
            for n in body.nodes:
                old_board_id = int(n.get("board_id", 0))
                board_id = id_map.get(old_board_id)
                if board_id is None:
                    continue
                db.execute("INSERT INTO canvas_nodes(id,board_id,type,short_id,status,x,y,data) VALUES(?,?,?,?,?,?,?,?)",
                           (n.get("id"), board_id, n.get("type") or "image", n.get("short_id") or f'n{n.get("id")}',
                            n.get("status") or "idle", n.get("x", 0), n.get("y", 0),
                            json.dumps(n.get("data") or {}, ensure_ascii=False)))
            for e in body.edges:
                board_id = id_map.get(int(e.get("board_id", 0)))
                if board_id is None:
                    continue
                db.execute("INSERT INTO canvas_edges(id,board_id,source_id,target_id,source_variant_idx) VALUES(?,?,?,?,?)",
                           (e.get("id"), board_id, e.get("source_id"), e.get("target_id"), e.get("source_variant_idx")))
        requests_imported = False
        for r in body.requests:
            if not r.get("id") or not r.get("jobId"):
                continue
            if not db.one("SELECT id FROM jobs WHERE id=?", (r["jobId"],)):
                continue
            db.insert("canvas_requests", {
                "id": str(r["id"]), "job_id": str(r["jobId"]), "type": r.get("type") or "image",
                "node_id": str(r["nodeId"]) if r.get("nodeId") is not None else None,
                "params": r.get("params") or {},
                "created_at": (r.get("createdAt") or 0) / 1000 if (r.get("createdAt") or 0) > 1_000_000_000_000 else (r.get("createdAt") or 0),
            }, ignore=True)
            requests_imported = True
        if boards_imported and id_map:
            for old_id, new_id in id_map.items():
                imported_public_id = db.one("SELECT public_id FROM canvas_boards WHERE id=?", (new_id,))["public_id"]
                db.execute("UPDATE jobs SET workspace_id=? WHERE workspace_id=?", (imported_public_id, old_id))
                db.execute("UPDATE media SET workspace_id=? WHERE workspace_id=?", (imported_public_id, old_id))
            fallback_workspace = db.one("SELECT public_id FROM canvas_boards WHERE id=?",
                                        (next(iter(id_map.values())),))["public_id"]
            db.execute("""UPDATE jobs SET workspace_id=(
                SELECT b.public_id FROM canvas_requests r JOIN canvas_nodes n ON CAST(n.id AS TEXT)=r.node_id
                JOIN canvas_boards b ON b.id=n.board_id
                WHERE r.job_id=jobs.id LIMIT 1) WHERE workspace_id IS NULL""")
            db.execute("UPDATE jobs SET workspace_id=? WHERE workspace_id IS NULL", (fallback_workspace,))
            db.execute("""UPDATE media SET workspace_id=COALESCE(
                (SELECT workspace_id FROM jobs WHERE jobs.id=media.job_id), ?) WHERE workspace_id IS NULL""",
                (fallback_workspace,))
        result = {"imported": boards_imported or requests_imported,
                  "boards_imported": boards_imported, "requests_imported": requests_imported}
    return result


@api.post("/nodes", tags=["canvas"], status_code=201)
async def create_canvas_node(body: CanvasNodeCreate, request: Request):
    db = core_of(request).db
    if not db.one("SELECT id FROM canvas_boards WHERE id=?", (body.board_id,)):
        raise HTTPException(404, "không tìm thấy canvas")
    cur = db.execute("INSERT INTO canvas_nodes(board_id,type,short_id,status,x,y,data) VALUES(?,?,?,?,?,?,?)",
                     (body.board_id, body.type, "", body.data.get("status", "idle"), body.x, body.y,
                      json.dumps(body.data, ensure_ascii=False)))
    node_id = cur.lastrowid
    db.update("canvas_nodes", "id", node_id, {"short_id": f"n{node_id}"})
    return _canvas_node(db.one("SELECT * FROM canvas_nodes WHERE id=?", (node_id,)))


@api.patch("/nodes/{node_id}", tags=["canvas"])
async def patch_canvas_node(node_id: int, body: dict[str, Any], request: Request):
    db = core_of(request).db
    node = db.one("SELECT * FROM canvas_nodes WHERE id=?", (node_id,))
    if not node:
        raise HTTPException(404, "không tìm thấy card")
    for key in ("x", "y", "status"):
        if key in body:
            node[key] = body[key]
    stored_data = node["data"]
    data = stored_data if isinstance(stored_data, dict) else json.loads(stored_data or "{}")
    data.update(body.get("data") or {})
    db.execute("UPDATE canvas_nodes SET x=?,y=?,status=?,data=? WHERE id=?",
               (node["x"], node["y"], node["status"], json.dumps(data, ensure_ascii=False), node_id))
    return _canvas_node(db.one("SELECT * FROM canvas_nodes WHERE id=?", (node_id,)))


@api.delete("/nodes/{node_id}", tags=["canvas"])
async def delete_canvas_node(node_id: int, request: Request):
    db = core_of(request).db
    db.execute("DELETE FROM canvas_edges WHERE source_id=? OR target_id=?", (node_id, node_id))
    db.execute("DELETE FROM canvas_nodes WHERE id=?", (node_id,))
    return {"ok": True}


@api.post("/edges", tags=["canvas"], status_code=201)
async def create_canvas_edge(body: CanvasEdgeCreate, request: Request):
    db = core_of(request).db
    nodes = db.all("SELECT id FROM canvas_nodes WHERE board_id=? AND id IN (?,?)",
                   (body.board_id, body.source_id, body.target_id))
    if len({node["id"] for node in nodes}) != 2:
        raise HTTPException(400, "hai đầu edge phải thuộc cùng canvas")
    cur = db.execute("INSERT INTO canvas_edges(board_id,source_id,target_id) VALUES(?,?,?)",
                     (body.board_id, body.source_id, body.target_id))
    return db.one("SELECT * FROM canvas_edges WHERE id=?", (cur.lastrowid,))


@api.patch("/edges/{edge_id}", tags=["canvas"])
async def patch_canvas_edge(edge_id: int, body: dict[str, Any], request: Request):
    db = core_of(request).db
    if not db.one("SELECT id FROM canvas_edges WHERE id=?", (edge_id,)):
        raise HTTPException(404, "không tìm thấy edge")
    if "source_variant_idx" in body:
        db.update("canvas_edges", "id", edge_id, {"source_variant_idx": body["source_variant_idx"]})
    return db.one("SELECT * FROM canvas_edges WHERE id=?", (edge_id,))


@api.delete("/edges/{edge_id}", tags=["canvas"])
async def delete_canvas_edge(edge_id: int, request: Request):
    core_of(request).db.execute("DELETE FROM canvas_edges WHERE id=?", (edge_id,))
    return {"ok": True}


@api.post("/canvas/requests", tags=["canvas"], status_code=201)
async def create_canvas_request(body: CanvasRequestCreate, request: Request):
    core = core_of(request)
    if body.node_id is None:
        raise HTTPException(400, "canvas request cần node_id")
    node = core.db.one("SELECT board_id FROM canvas_nodes WHERE id=?", (int(body.node_id),))
    if not node:
        raise HTTPException(404, "không tìm thấy node canvas")
    project = core.db.one("SELECT public_id, worker_id, flow_project_id FROM canvas_boards WHERE id=?", (node["board_id"],))
    _assert_canvas_extension_online(core, project["worker_id"])
    if body.workspace_id is not None and body.workspace_id != project["public_id"]:
        raise HTTPException(400, "node không thuộc project đang mở")
    reference_ids = set()
    for key in ("ref_media_ids", "start_media_ids", "end_media_ids"):
        reference_ids.update(str(value) for value in (body.spec.get(key) or []) if value)
    for key in ("start_media_id", "end_media_id", "base_media_id", "source_media_id"):
        if body.spec.get(key):
            reference_ids.add(str(body.spec[key]))
    for media_id in reference_ids:
        media = core.db.one("SELECT workspace_id FROM media WHERE id=?", (media_id,))
        if not media or media["workspace_id"] != project["public_id"]:
            raise HTTPException(400, "ảnh tham chiếu không thuộc project canvas hiện tại")
    # For source-first video jobs the referenced media must itself be a video.
    if body.spec.get("type") in ("extend_video", "video_reference") and body.spec.get("source_media_id"):
        src_vid = core.db.one("SELECT kind FROM media WHERE id=?", (str(body.spec["source_media_id"]),))
        if not src_vid or src_vid["kind"] != "video":
            raise HTTPException(400, "source_media_id phải là video"
                                     + (" để kéo dài" if body.spec.get("type") == "extend_video"
                                        else " (video tham chiếu)"))
    if body.spec.get("type") == "video_reference":
        # jIps6 edits a single clip and only Omni Flash exposes it; the picker
        # offers no other family, and a stray wire id here would silently build
        # an abra_edit body the page never sends.
        if str(body.spec.get("family") or "omni_flash") != "omni_flash":
            raise HTTPException(400, "video_reference chỉ hỗ trợ Omni Flash")
        model = str(body.spec.get("model") or "")
        if model and model != fb.VIDEO_REFERENCE_OPERATION:
            raise HTTPException(400, "video_reference chỉ hỗ trợ Omni Flash (abra_edit)")
        # The reference video is the only video input; anything in ref_media_ids
        # is an image the edit is guided by, never a second clip.
        for ref_id in (str(v) for v in (body.spec.get("ref_media_ids") or []) if v):
            ref = core.db.one("SELECT kind FROM media WHERE id=?", (ref_id,))
            if ref and ref["kind"] != "image":
                raise HTTPException(400, "video_reference chỉ nhận 1 video tham chiếu (ref_media_ids là ảnh)")
    extract_video_ids = set(str(value) for value in (body.spec.get("extract_video_ids") or []) if value)
    if body.spec.get("extract_start_video_id"):
        extract_video_ids.add(str(body.spec["extract_start_video_id"]))
    for media_id in extract_video_ids:
        media = core.db.one("SELECT workspace_id, kind FROM media WHERE id=?", (media_id,))
        if not media or media["kind"] != "video" or media["workspace_id"] != project["public_id"]:
            raise HTTPException(400, "video nguồn không thuộc project Canvas hiện tại")
    spec = {**body.spec, "workspace_id": project["public_id"]}
    if project.get("flow_project_id"):
        spec["project_id"] = project["flow_project_id"]
    # Persist dependencies on connected upstream generations in the job spec.
    # The backend can then wait and inject their media even after a page reload.
    incoming = core.db.all(
        "SELECT e.source_id,e.source_variant_idx,n.type,n.status,n.data "
        "FROM canvas_edges e JOIN canvas_nodes n ON n.id=e.source_id "
        "WHERE e.board_id=? AND e.target_id=? ORDER BY e.id",
        (node["board_id"], int(body.node_id)),
    )
    dependencies = []
    for source in incoming:
        if source["type"] not in {"image", "video", "Storyboard", "character", "visual_asset"}:
            continue
        # `canvas_nodes.data` is a JSON column, so the DB layer already decoded
        # it into a dict. Calling json.loads() on that raises TypeError, which
        # would silently wipe the media of an uploaded source and make the
        # whole chain look like it had no result.
        raw_data = source.get("data")
        if isinstance(raw_data, dict):
            source_data = raw_data
        else:
            try:
                source_data = json.loads(raw_data or "{}")
            except (TypeError, json.JSONDecodeError):
                source_data = {}
        source_variants = source_data.get("mediaIds") if isinstance(source_data.get("mediaIds"), list) else []
        existing_ids = [value for value in (source_data.get("mediaId"), *source_variants) if value]
        latest = core.db.one(
            "SELECT r.id,r.created_at,j.status FROM canvas_requests r JOIN jobs j ON j.id=r.job_id "
            "WHERE r.node_id=? ORDER BY r.created_at DESC LIMIT 1",
            (str(source["source_id"]),),
        )
        latest_active = bool(latest and latest["status"] in {"queued", "running", "polling"})
        source_active = latest_active or source["status"] in {"queued", "running"}
        if source_active:
            dependencies.append({
                "source_node_id": int(source["source_id"]),
                # A terminal latest job is still safer to resolve than to
                # wait forever on a stale node status after browser reload.
                "request_id": latest["id"] if latest else None,
                "after_created_at": latest["created_at"] if latest else 0,
                "source_variant_idx": source.get("source_variant_idx"),
                "source_type": source["type"],
                "previous_media_ids": list(dict.fromkeys(str(value) for value in existing_ids)),
            })
        elif source["status"] == "error":
            raise HTTPException(409, f"node nguồn #{source['source_id']} đang lỗi; chuỗi đã dừng")
        elif latest and latest["status"] in {"failed", "timeout", "canceled", "partial"}:
            # A failed latest run invalidates this node for the current chain,
            # even if stale media from an older successful run remains cached.
            dependencies.append({
                "source_node_id": int(source["source_id"]),
                "request_id": latest["id"],
                "source_variant_idx": source.get("source_variant_idx"),
                "source_type": source["type"],
                "previous_media_ids": list(dict.fromkeys(str(value) for value in existing_ids)),
            })
        elif latest and not existing_ids:
            dependencies.append({
                "source_node_id": int(source["source_id"]),
                "request_id": latest["id"],
                "source_variant_idx": source.get("source_variant_idx"),
                "source_type": source["type"],
                "previous_media_ids": list(dict.fromkeys(str(value) for value in existing_ids)),
            })
        elif not existing_ids and source["status"] == "idle":
            # A user may queue the downstream node first, then start its
            # upstream node. Wait for that next request instead of silently
            # generating without the connected input.
            dependencies.append({
                "source_node_id": int(source["source_id"]),
                "request_id": None,
                "after_created_at": latest["created_at"] if latest else 0,
                "source_variant_idx": source.get("source_variant_idx"),
                "source_type": source["type"],
                "previous_media_ids": [],
            })
        elif not existing_ids:
            raise HTTPException(409, f"node nguồn #{source['source_id']} đang lỗi hoặc chưa có kết quả để nối chuỗi")
    if dependencies:
        # A pending dependency cycle cannot make progress (each queued job
        # would be waiting for the other). Reject only cycles that would
        # actually become job dependencies; static media-reference cycles
        # remain unaffected.
        adjacency: dict[int, list[int]] = {}
        for edge in core.db.all("SELECT source_id,target_id FROM canvas_edges WHERE board_id=?", (node["board_id"],)):
            adjacency.setdefault(int(edge["source_id"]), []).append(int(edge["target_id"]))
        reachable = set()
        stack = [int(body.node_id)]
        while stack:
            current = stack.pop()
            if current in reachable:
                continue
            reachable.add(current)
            stack.extend(adjacency.get(current, []))
        for dependency in dependencies:
            if dependency["source_node_id"] in reachable:
                raise HTTPException(409, "chuỗi node có vòng lặp nên không thể chờ hoàn tất")
        spec["canvas_dependencies"] = dependencies
    spec.pop("worker_id", None)
    if project["worker_id"]:
        spec["worker_id"] = project["worker_id"]
    try:
        job = core.jobs.create(spec)
    except ValueError as exc:
        raise _bad(exc)
    request_id = secrets.token_urlsafe(24)
    core.db.insert("canvas_requests", {
        "id": request_id,
        "job_id": job["id"],
        "type": body.type,
        "node_id": str(body.node_id) if body.node_id is not None else None,
        "params": body.params,
        "created_at": core.db.one("SELECT created_at FROM jobs WHERE id=?", (job["id"],))["created_at"],
    })
    return {"id": request_id, "status": "running", "type": body.type,
            "params": body.params, "result": {}, "error": None,
            "resolved_model": job.get("model")}


@api.post("/canvas/requests/{request_id}/cancel", tags=["canvas"])
async def cancel_canvas_request(request_id: str, request: Request):
    core = core_of(request)
    record = core.db.one("SELECT job_id FROM canvas_requests WHERE id=?", (request_id,))
    if not record:
        raise HTTPException(404, "không tìm thấy request")
    try:
        job = await core.jobs.cancel(record["job_id"])
    except KeyError:
        raise HTTPException(404, "không tìm thấy job của request")
    return {"id": request_id, "status": job["status"]}


def _canvas_node_or_404(db, board_id: int, node_id: int) -> dict:
    node = db.one("SELECT id,status,data FROM canvas_nodes WHERE id=? AND board_id=?", (int(node_id), int(board_id)))
    if not node:
        raise HTTPException(404, "không tìm thấy node trong canvas")
    return node


@api.post("/boards/{board_id}/nodes/{node_id}/stop-chain", tags=["canvas"])
async def stop_canvas_chain(board_id: int, node_id: int, request: Request):
    """Stop one node and every node that depends on it.

    Scope is the dependency graph, not the canvas layout: the node plus
    everything reachable downstream through the edges. Upstream nodes and
    nodes on unrelated branches are never touched. A dependent that was
    still queued parks at `idle` (it never ran, so it is not a failure); one
    that was already running is canceled and stays retryable.
    """
    core = core_of(request)
    db = core.db
    _canvas_node_or_404(db, board_id, node_id)
    scope = [int(node_id), *canvas_chain.downstream_ids(db, board_id, node_id)]
    stopped = [{"id": nid, "status": core.jobs.stop_node(nid)} for nid in scope]
    return {"stopped": stopped}


@api.post("/boards/{board_id}/stop-all", tags=["canvas"])
async def stop_canvas_board(board_id: int, request: Request):
    """Stop every running/queued node of the project (the header Stop All).

    Same per-node rules as stopping a chain, applied across the whole board:
    queued nodes park at `idle`, running ones land on the canceled state that
    keeps their retry available. `done` and `failed` nodes are left alone.
    """
    core = core_of(request)
    if not core.db.one("SELECT id FROM canvas_boards WHERE id=?", (board_id,)):
        raise HTTPException(404, "không tìm thấy canvas")
    return {"stopped": core.jobs.stop_board(board_id)}


@api.post("/boards/{board_id}/nodes/{node_id}/resume-chain", tags=["canvas"])
async def resume_canvas_chain(board_id: int, node_id: int, body: dict[str, Any], request: Request):
    """Retry a failed Canvas generation and its downstream jobs stopped by it."""
    core = core_of(request)
    db = core.db
    board = db.one("SELECT public_id,worker_id,flow_project_id FROM canvas_boards WHERE id=?", (board_id,))
    if not board:
        raise HTTPException(404, "không tìm thấy canvas")
    node = db.one("SELECT id FROM canvas_nodes WHERE id=? AND board_id=?", (node_id, board_id))
    if not node:
        raise HTTPException(404, "không tìm thấy node trong canvas")
    _assert_canvas_extension_online(core, board["worker_id"])

    latest_rows = db.all(
        "SELECT r.id,r.job_id,r.type,r.node_id,r.params,r.created_at,j.status,j.spec,j.error "
        "FROM canvas_requests r JOIN jobs j ON j.id=r.job_id "
        "JOIN canvas_nodes n ON CAST(n.id AS TEXT)=r.node_id "
        "WHERE n.board_id=? AND NOT EXISTS ("
        "SELECT 1 FROM canvas_requests newer WHERE newer.node_id=r.node_id "
        "AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.id>r.id)))",
        (board_id,),
    )
    by_node = {str(row["node_id"]): row for row in latest_rows if row["node_id"] is not None}
    root = by_node.get(str(node_id))
    expected_request_id = str(body.get("request_id") or "")
    if not root or root["id"] != expected_request_id:
        raise HTTPException(409, "request của node đã thay đổi; hãy tải lại canvas rồi thử lại")
    # Run from Here semantics: a `done` root is kept (never re-run) and only
    # its unfinished downstream is retried; a failed/canceled root itself
    # becomes the first member of the retry set. A root that is still running
    # (or idle with no request) has nothing to retry here.
    root_retried = root["status"] in {"failed", "timeout", "canceled"}
    if root["status"] not in {"failed", "timeout", "canceled", "done"}:
        raise HTTPException(409, "chỉ có thể chạy lại chuỗi từ node đã lỗi, bị hủy hoặc đã hoàn tất")

    # Follow persisted job dependencies rather than every visual edge. That
    # limits the retry to requests that actually belonged to the stopped run.
    # `done` requests are never candidates: a completed node is never re-run.
    candidates: dict[str, dict[str, Any]] = {root["id"]: root} if root_retried else {}
    chain_request_ids = {root["id"]}
    chain_node_ids = {str(node_id)}
    changed = True
    while changed:
        changed = False
        for row in latest_rows:
            request_id = str(row["id"])
            if request_id in candidates or row["status"] not in {"queued", "running", "polling", "failed", "timeout", "canceled"}:
                continue
            spec = row.get("spec") if isinstance(row.get("spec"), dict) else {}
            dependencies = spec.get("canvas_dependencies") or []
            follows_chain = any(
                str(dep.get("request_id")) in chain_request_ids
                or (not dep.get("request_id") and str(dep.get("source_node_id")) in chain_node_ids)
                for dep in dependencies if isinstance(dep, dict)
            )
            if follows_chain:
                candidates[request_id] = row
                chain_request_ids.add(request_id)
                chain_node_ids.add(str(row["node_id"]))
                changed = True

    # A failed source outside this retry set cannot provide a usable input.
    # Ask the user to resume at that earlier failure instead of queuing a job
    # that is guaranteed to fail again.
    for row in candidates.values():
        if row["id"] != root["id"]:
            continue
        spec = row.get("spec") if isinstance(row.get("spec"), dict) else {}
        for dep in spec.get("canvas_dependencies") or []:
            if not isinstance(dep, dict):
                continue
            source_id = str(dep.get("source_node_id") or "")
            upstream = by_node.get(source_id)
            if upstream and upstream["status"] in {"failed", "timeout", "canceled", "partial"}:
                raise HTTPException(
                    409,
                    f"node nguồn #{source_id} cũng chưa hoàn tất; hãy chạy lại chuỗi từ node nguồn đó trước",
                )

    # Topologically order the retry set using the old request dependency IDs.
    # Completed outputs outside the set remain untouched and are reused. A
    # done root counts as a satisfied upstream without being retried itself.
    ordered: list[dict[str, Any]] = [root] if root_retried else []
    ordered_ids = {root["id"]}
    pending = [row for row in candidates.values()]
    while pending:
        ready = []
        for row in pending:
            spec = row.get("spec") if isinstance(row.get("spec"), dict) else {}
            deps = spec.get("canvas_dependencies") or []
            parents = {
                rid for rid, candidate in candidates.items()
                if candidate["id"] != row["id"] and any(
                    str(dep.get("request_id")) == rid
                    or (not dep.get("request_id") and str(dep.get("source_node_id")) == str(candidate["node_id"]))
                    for dep in deps if isinstance(dep, dict)
                )
            }
            if parents.issubset(ordered_ids):
                ready.append(row)
        if not ready:
            raise HTTPException(409, "không thể sắp xếp chuỗi node để chạy lại")
        for row in ready:
            ordered.append(row)
            ordered_ids.add(row["id"])
            pending.remove(row)

    new_request_ids = {row["id"]: secrets.token_urlsafe(24) for row in ordered}
    new_request_by_node = {str(row["node_id"]): new_request_ids[row["id"]] for row in ordered}
    prepared = []
    for row in ordered:
        old_job = core.jobs.get(row["job_id"])
        if not old_job:
            raise HTTPException(409, f"job cũ của node #{row['node_id']} không còn tồn tại")
        spec = deepcopy(old_job.get("spec") or {})
        spec["workspace_id"] = board["public_id"]
        if board.get("flow_project_id"):
            spec["project_id"] = board["flow_project_id"]
        spec.pop("worker_id", None)
        if board["worker_id"]:
            spec["worker_id"] = board["worker_id"]
        dependencies = spec.get("canvas_dependencies") or []
        for dep in dependencies:
            if not isinstance(dep, dict):
                continue
            old_parent_id = str(dep.get("request_id") or "")
            if old_parent_id in new_request_ids:
                dep["request_id"] = new_request_ids[old_parent_id]
                dep.pop("after_created_at", None)
                continue
            source_id = str(dep.get("source_node_id") or "")
            if not old_parent_id and source_id in new_request_by_node:
                dep["request_id"] = new_request_by_node[source_id]
                dep.pop("after_created_at", None)
                continue
            latest_parent = by_node.get(source_id)
            if latest_parent:
                if latest_parent["status"] in {"failed", "timeout", "canceled", "partial"}:
                    raise HTTPException(
                        409,
                        f"node nguồn #{source_id} chưa có kết quả thành công; hãy chạy lại chuỗi từ node nguồn đó trước",
                    )
                dep["request_id"] = latest_parent["id"]
                dep.pop("after_created_at", None)

        try:
            spec = core.jobs.normalize(spec)
        except ValueError as exc:
            raise HTTPException(409, f"không thể chạy lại request của node #{row['node_id']}: {exc}")
        prepared.append((row, old_job, spec, new_request_ids[row["id"]]))

    restarted = []
    for row, old_job, spec, new_request_id in prepared:
        if old_job["status"] in {"queued", "running", "polling"}:
            await core.jobs.cancel(old_job["id"])
        new_job = core.jobs.create(spec)
        created_at = db.one("SELECT created_at FROM jobs WHERE id=?", (new_job["id"],))["created_at"]
        db.insert("canvas_requests", {
            "id": new_request_id,
            "job_id": new_job["id"],
            "type": row["type"],
            "node_id": str(row["node_id"]),
            "params": row.get("params") or {},
            "created_at": created_at,
        })
        canvas_node = db.one("SELECT data FROM canvas_nodes WHERE id=?", (int(row["node_id"]),)) or {}
        node_data = canvas_node.get("data") if isinstance(canvas_node.get("data"), dict) else {}
        node_data = {
            **node_data,
            "error": None,
            "canceled": False,
            "lastRequestId": new_request_id,
            "lastRequestStatus": "queued",
        }
        db.update("canvas_nodes", "id", int(row["node_id"]), {"status": "queued", "data": node_data})
        restarted.append({
            "id": new_request_id,
            "type": row["type"],
            "node_id": str(row["node_id"]),
            "params": row.get("params") or {},
            "status": "queued",
        })

    return {"items": restarted}


@api.get("/canvas/requests/{request_id}", tags=["canvas"])
async def get_canvas_request(request_id: str, request: Request):
    core = core_of(request)
    record = core.db.one("SELECT * FROM canvas_requests WHERE id=?", (request_id,))
    if not record:
        raise HTTPException(404, "không tìm thấy request")
    job = core.jobs.get(record["job_id"])
    if not job:
        raise HTTPException(404, "không tìm thấy job của request")
    status = job["status"]
    if status in ("done", "partial"):
        status = "done"
    elif status not in ("failed", "timeout", "canceled"):
        status = "running"
    # `stopped` distinguishes a job the engine parked because its upstream
    # died (node goes back to `idle` — it never ran) from a generation the
    # user canceled (node keeps its retryable error state). See
    # JobEngine._block_chain.
    stopped = status == "canceled" and bool((job.get("spec") or {}).get("chain_blocked"))
    return {
        "id": request_id,
        "type": record["type"],
        "status": status,
        "stopped": stopped,
        "params": record["params"],
        "result": {
            "media_ids": [r.get("media_id") for r in (job.get("results") or [])],
            "partial_error": job.get("error"),
        },
        "error": job.get("error"),
    }


@api.get("/boards/{board_id}/requests", tags=["canvas"])
async def list_canvas_requests(board_id: int, request: Request, all: bool = Query(False)):
    db = core_of(request).db
    if not db.one("SELECT id FROM canvas_boards WHERE id=?", (board_id,)):
        raise HTTPException(404, "không tìm thấy canvas")
    active_filter = "" if all else "AND (j.status IN ('queued','running','polling') OR n.status IN ('queued','running')) "
    return {"items": db.all(
        "SELECT r.id,r.type,r.node_id,r.params,j.status,j.model AS resolved_model,r.created_at "
        "FROM canvas_requests r JOIN canvas_nodes n ON CAST(n.id AS TEXT)=r.node_id "
        "JOIN jobs j ON j.id=r.job_id "
        "WHERE n.board_id=? " + active_filter +
        "AND NOT EXISTS (SELECT 1 FROM canvas_requests r2 WHERE r2.node_id=r.node_id "
        "AND (r2.created_at>r.created_at OR (r2.created_at=r.created_at AND r2.id>r.id))) "
        "ORDER BY r.created_at DESC,r.id DESC",
        (board_id,),
    )}


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
    type: Literal["image", "character", "edit", "t2v", "i2v", "first_last", "r2v", "extend_video",
                  "video_reference", "upscale", "template"]
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
    ref_media_names: Optional[list[str]] = Field(None, description="Tên hiển thị của từng ảnh ingredient trong cùng thứ tự")
    start_media_ids: list[str] = []
    start_media_id: Optional[str] = None
    end_media_id: Optional[str] = None
    base_media_id: Optional[str] = None
    media_id: Optional[str] = None
    source_media_id: Optional[str] = Field(None, description="fZytfe extend / jIps6 video_reference: clip nguồn (media id)")
    scene_id: Optional[str] = Field(None, description="fZytfe: scene uuid của Flow (thường = /scene/<id>), không bắt buộc")
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
        spec = body.model_dump()
        if body.type == "upscale" and body.media_id:
            source = core_of(request).media.get(body.media_id)
            if source:
                spec["workspace_id"] = source.get("workspace_id")
        if body.type in ("extend_video", "video_reference") and (body.source_media_id or body.media_id):
            source = core_of(request).media.get(body.source_media_id or body.media_id)
            if source:
                # Keep the new clip in the same Flow workspace as its source.
                spec["workspace_id"] = source.get("workspace_id")
        return core_of(request).jobs.create(spec)
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

@api.delete("/jobs", tags=["jobs"])
async def clear_jobs(request: Request):
    core_of(request).jobs.clear()
    return {"ok": True}


#: Upload allow-list. Video only exists for the jIps6 "video reference" mode —
#: a local clip the user picks instead of one already in the Flow project — and
#: goes through the very same maseQ upload job, so there is one upload pipeline.
IMAGE_MIMES = ("image/jpeg", "image/png", "image/webp", "image/gif")
VIDEO_MIMES = ("video/mp4", "video/webm", "video/quicktime")
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 50 * 1024 * 1024


@api.post("/uploads", tags=["media"], status_code=201)
async def upload(request: Request, file: UploadFile = File(...), project_id: Optional[str] = Form(None),
                 workspace_id: Optional[str] = Form(None)):
    core = core_of(request)
    board = core.db.one("SELECT id, worker_id, flow_project_id FROM canvas_boards WHERE public_id=?", (workspace_id,)) if workspace_id else None
    if board:
        _assert_canvas_extension_online(core, board["worker_id"])
    if workspace_id is not None and board is None:
        raise HTTPException(404, "không tìm thấy project")
    mime = (file.content_type or "").split(";")[0].strip().lower()
    if mime in IMAGE_MIMES:
        limit = MAX_IMAGE_BYTES
        default_name = "upload.jpg"
    elif mime in VIDEO_MIMES:
        limit = MAX_VIDEO_BYTES
        default_name = "upload.mp4"
    else:
        raise HTTPException(415, "chỉ nhận JPEG / PNG / WEBP / GIF / MP4 / WEBM / MOV")
    data = await file.read(limit + 1)
    if not data or len(data) > limit:
        raise HTTPException(413, f"tệp rỗng hoặc quá {limit // (1024 * 1024)} MB")
    spec = {"type": "upload", "file_name": file.filename or default_name, "mime_type": mime, "size": len(data),
            "project_id": (board.get("flow_project_id") if board and board.get("flow_project_id") else project_id),
            "workspace_id": workspace_id}
    if board and board["worker_id"]:
        spec["worker_id"] = board["worker_id"]
    return core.jobs.create(spec, secret={"b64": base64.b64encode(data).decode("ascii")})


# ── media ───────────────────────────────────────────────────────────────────

@api.get("/media", tags=["media"])
async def list_media(request: Request, kind: Optional[str] = None, source: Optional[str] = None, limit: int = 200,
               offset: int = 0, workspace_id: Optional[str] = None):
    core = core_of(request)
    if workspace_id is not None and not core.db.one("SELECT id FROM canvas_boards WHERE public_id=?", (workspace_id,)):
        raise HTTPException(404, "không tìm thấy project")
    return core.media.list(kind, source, min(limit, 1000), offset, workspace_id)


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
    workspace_id: Optional[str] = None


@api.post("/media", tags=["media"], status_code=201)
async def add_media(body: MediaAdd, request: Request):
    core = core_of(request)
    board = core.db.one("SELECT id, worker_id FROM canvas_boards WHERE public_id=?", (body.workspace_id,)) if body.workspace_id else None
    if board:
        _assert_canvas_extension_online(core, board["worker_id"])
    if body.workspace_id is not None and not core.db.one("SELECT id FROM canvas_boards WHERE public_id=?", (body.workspace_id,)):
        raise HTTPException(404, "không tìm thấy project")
    try:
        if body.workspace_id is not None:
            existing = core.media.get(body.media_id.strip())
            if existing and existing.get("workspace_id") not in (None, body.workspace_id):
                raise HTTPException(409, "media này thuộc project khác")
        row = await core.jobs.refresh_media(body.media_id.strip(), board["worker_id"] if board else None)
        if body.workspace_id is not None:
            row = core.media.upsert({"id": row["id"], "workspace_id": body.workspace_id})
        return row
    except fb.FlowError as exc:
        return core.media.upsert({"id": body.media_id.strip(), "kind": "image", "source": "manual", "workspace_id": body.workspace_id,
                                  "note": f"chưa lấy được url: {exc}"})


@api.post("/media/{media_id}/refresh", tags=["media"])
async def refresh_media(media_id: str, request: Request):
    core = core_of(request)
    media = core.media.get(media_id)
    board = core.db.one("SELECT id, worker_id FROM canvas_boards WHERE public_id=?", (media or {}).get("workspace_id")) if media and media.get("workspace_id") else None
    if board:
        _assert_canvas_extension_online(core, board["worker_id"])
    try:
        return await core.jobs.refresh_media(media_id, board["worker_id"] if board else None)
    except fb.FlowError as exc:
        raise _bad(exc)


@api.delete("/media/{media_id}", tags=["media"])
async def delete_media(media_id: str, request: Request):
    core_of(request).media.delete(media_id)
    return {"ok": True}

@api.delete("/media", tags=["media"])
async def clear_media(request: Request, workspace_id: Optional[str] = None):
    core = core_of(request)
    if workspace_id is None:
        core.media.clear()
    else:
        if not core.db.one("SELECT id FROM canvas_boards WHERE public_id=?", (workspace_id,)):
            raise HTTPException(404, "không tìm thấy project")
        core.media.delete_workspace(workspace_id)
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
