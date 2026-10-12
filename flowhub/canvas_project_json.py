"""Build an import-ready snapshot of a canvas project for JSON export."""
from __future__ import annotations

import base64
import json
from typing import Any


class CanvasProjectExportError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def build_canvas_project_snapshot(core: Any, board_id: int) -> dict:
    board = core.db.one(
        "SELECT id, public_id, name, project_id, created_at, viewport, worker_id FROM canvas_boards WHERE id=?",
        (board_id,),
    )
    if not board:
        raise CanvasProjectExportError(404, "Không tìm thấy canvas")

    nodes = core.db.all("SELECT * FROM canvas_nodes WHERE board_id=? ORDER BY id", (board_id,))
    for node in nodes:
        if isinstance(node.get("data"), str):
            node["data"] = json.loads(node["data"] or "{}")
        elif not isinstance(node.get("data"), dict):
            node["data"] = {}

    assets: list[dict[str, Any]] = []
    for node in nodes:
        if node["type"] != "visual_asset":
            continue
        data = node["data"]
        media_ids = data.get("mediaIds") if isinstance(data.get("mediaIds"), list) else []
        media_id = data.get("mediaId")
        if isinstance(media_id, str) and media_id and media_id not in media_ids:
            media_ids = [*media_ids, media_id]
        for variant_idx, asset_id in enumerate(media_ids):
            if not isinstance(asset_id, str) or not asset_id:
                continue
            path = await core.media.download(asset_id, board.get("worker_id"))
            if path is None:
                raise CanvasProjectExportError(
                    424,
                    f"Không thể đóng gói ảnh reference của node {node['id']} ({asset_id})",
                )
            media = core.media.get(asset_id) or {}
            assets.append({
                "node_id": node["id"],
                "variant_idx": variant_idx,
                "media_id": asset_id,
                "name": media.get("prompt") or media.get("note") or asset_id,
                "mime_type": media.get("mime") or "application/octet-stream",
                "data_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
            })

    edges = core.db.all("SELECT * FROM canvas_edges WHERE board_id=? ORDER BY id", (board_id,))
    return {"board": board, "nodes": nodes, "edges": edges, "assets": assets}
