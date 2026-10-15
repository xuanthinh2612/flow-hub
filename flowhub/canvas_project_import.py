"""Rebuild a canvas project from a `flow-hub-canvas-project` JSON export.

Counterpart of canvas_project_json.py: that module turns a board into a file,
this one replays the file. Everything is written through the very same
`canvas_boards` / `canvas_nodes` / `canvas_edges` tables the canvas itself
uses, so an imported project is indistinguishable from a hand-built one and
keeps working with the normal node pipeline.

Fidelity rules that shape this module:

* The file is the source of truth. Each node payload is copied verbatim into
  `canvas_nodes.data.importSource`, and the whole document into
  `canvas_boards.source_json`. A field this build has never heard of — or a
  `null` where another node has no key at all — therefore survives the round
  trip instead of being normalised away.
* `data.generation` is a *projection* of the file onto the camelCase keys the
  canvas runtime reads (NodeGeneration in frontend/src/store/board.ts). It
  never replaces the original; it only gives the node something the existing
  generation dialog and dispatch code can consume.
* Nothing runs. Import restores structure and data only — no image or video
  job is ever created, and no node is marked done unless the file itself
  carries the media for it.
"""
from __future__ import annotations

import base64
import binascii
import secrets
import string
import time
from copy import deepcopy
from typing import Any, NoReturn

from .media import image_aspect

SUPPORTED_FORMAT = "flow-hub-canvas-project"
SUPPORTED_FORMAT_VERSION = 1

#: Node types the canvas can actually render (NodeType in
#: frontend/src/store/boardApi.ts). Anything else would be stored but never
#: displayed, so import refuses it instead of writing a broken project.
KNOWN_NODE_TYPES = frozenset({
    "image", "video", "prompt", "character", "visual_asset", "Storyboard", "note", "merge",
})

#: `flow-hub-canvas-project` generation keys -> the camelCase keys the canvas
#: runtime uses. Keys absent from this table (unknown or future extensions)
#: are carried over untouched, so nothing is dropped.
GENERATION_KEY_MAP = {
    "backend": "backend",
    "aspect_ratio": "aspectRatio",
    "model": "model",
    "resolution": "resolution",
    "duration_s": "duration",
    "camera": "camera",
    "operation": "operation",
    "video_mode": "videoMode",
    "prompt": "prompt",
    "prompts": "prompts",
    "variants": "variants",
    "storyboard_grid": "storyboardGrid",
    "selected_source_idx": "selectedSourceIdx",
    "connected_video_mode": "connectedVideoMode",
    "independent_video_mode": "independentVideoMode",
}

# Canvas cards are ~280x220 px. The layout is computed once at import:
# dependency depth forms rows, and nodes at the same depth sit side by side.
# Stored coordinates keep the diagram stable on every reopen.
NODE_WIDTH = 280
NODE_HEIGHT = 220
COLUMN_GAP = 140
ROW_GAP = 80
ORIGIN_X = 40
ORIGIN_Y = 40


class CanvasProjectImportError(Exception):
    """A file that must not be written to the database."""

    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def new_public_id() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(48))


def _fail(detail: str, status_code: int = 400) -> NoReturn:
    raise CanvasProjectImportError(detail, status_code)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _as_id(value: Any, label: str) -> str:
    """Node ids are opaque keys: keep them exactly as the file spells them."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        _fail(f"{label} phải là chuỗi hoặc số, nhận {type(value).__name__}")
    text = str(value)
    if not text.strip():
        _fail(f"{label} không được rỗng")
    return text


def _decode_asset(node_id: str, index: int, asset: Any) -> dict:
    label = f"node “{node_id}” có assets[{index}]"
    if not isinstance(asset, dict):
        _fail(f"{label} không phải object")
    encoded = asset.get("data_base64")
    if not isinstance(encoded, str) or not encoded:
        _fail(f"{label} thiếu `data_base64`")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        _fail(f"{label} không phải base64 hợp lệ: {exc}")
    if not data:
        _fail(f"{label} rỗng")
    name = asset.get("name")
    mime = asset.get("mime_type")
    media_id = asset.get("media_id")
    return {
        "bytes": data,
        "name": name if isinstance(name, str) and name else None,
        "mime_type": mime if isinstance(mime, str) and mime else None,
        # Reuse the file's own media id when it is free, so the asset stays
        # addressable by the name the export gave it.
        "media_id": media_id if isinstance(media_id, str) and media_id.strip() else None,
    }

def _validate_nodes(raw_nodes: Any) -> list[dict]:
    if not isinstance(raw_nodes, list):
        _fail("`nodes` phải là một danh sách")
    nodes: list[dict] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_nodes):
        label = f"nodes[{index}]"
        if not isinstance(raw, dict):
            _fail(f"{label} phải là một object")
        source_id = _as_id(raw.get("id"), f"{label}.id")
        if source_id in seen:
            _fail(f"ID node bị trùng trong file: “{source_id}”")
        seen.add(source_id)

        node_type = raw.get("type")
        if not isinstance(node_type, str) or not node_type:
            _fail(f"node “{source_id}” thiếu trường `type`")
        if node_type not in KNOWN_NODE_TYPES:
            _fail(f"node “{source_id}” có type không hợp lệ: “{node_type}”. "
                  f"Các type canvas hiểu: {', '.join(sorted(KNOWN_NODE_TYPES))}")

        generation = raw.get("generation")
        if generation is not None and not isinstance(generation, dict):
            _fail(f"node “{source_id}” có `generation` không phải object")
        properties = raw.get("properties")
        if properties is not None and not isinstance(properties, dict):
            _fail(f"node “{source_id}” có `properties` không phải object")
        for axis in ("x", "y"):
            if axis in raw and raw[axis] is not None and not _is_number(raw[axis]):
                _fail(f"node “{source_id}” có `{axis}` không phải số")

        assets = raw.get("assets")
        if assets is not None:
            if not isinstance(assets, list):
                _fail(f"node “{source_id}” có `assets` không phải danh sách")
            # Decode here, before anything is written, so a corrupt payload
            # fails the whole import instead of leaving a half-built board.
            assets = [_decode_asset(source_id, i, asset) for i, asset in enumerate(assets)]

        nodes.append({
            "id": source_id,
            "type": node_type,
            "raw": raw,
            "assets": assets or [],
            "has_position": _is_number(raw.get("x")) and _is_number(raw.get("y")),
        })
    return nodes


def _validate_edges(raw_edges: Any, node_ids: set[str]) -> list[dict]:
    if raw_edges is None:
        return []
    if not isinstance(raw_edges, list):
        _fail("`edges` phải là một danh sách")
    edges: list[dict] = []
    for index, raw in enumerate(raw_edges):
        label = f"edges[{index}]"
        if not isinstance(raw, dict):
            _fail(f"{label} phải là một object")
        source = _as_id(raw.get("source"), f"{label}.source")
        target = _as_id(raw.get("target"), f"{label}.target")
        for role, value in (("source", source), ("target", target)):
            if value not in node_ids:
                _fail(f"{label}.{role} = “{value}” không có node tương ứng trong `nodes`")
        relation = raw.get("relation")
        if relation is not None and not isinstance(relation, str):
            _fail(f"{label}.relation phải là chuỗi hoặc null")
        variant = raw.get("source_variant_idx")
        if variant is not None and (isinstance(variant, bool) or not isinstance(variant, int)):
            _fail(f"{label}.source_variant_idx phải là số nguyên hoặc null")
        edges.append({
            "source": source,
            "target": target,
            "relation": relation,
            "source_variant_idx": variant,
        })
    return edges


def _validate_document(payload: Any) -> tuple[str, list[dict], list[dict]]:
    if not isinstance(payload, dict):
        _fail("Nội dung file phải là một JSON object")

    fmt = payload.get("format")
    if fmt != SUPPORTED_FORMAT:
        _fail(f"`format` không được hỗ trợ: {fmt!r}. Cần “{SUPPORTED_FORMAT}”.")
    version = payload.get("format_version")
    if isinstance(version, bool) or not isinstance(version, int) or version != SUPPORTED_FORMAT_VERSION:
        _fail(f"`format_version` không được hỗ trợ: {version!r}. Cần {SUPPORTED_FORMAT_VERSION}.")

    project = payload.get("project")
    if not isinstance(project, dict):
        _fail("Thiếu `project` hoặc `project` không phải object")
    name = project.get("name")
    if not isinstance(name, str) or not name.strip():
        _fail("`project.name` phải là chuỗi khác rỗng")

    if "nodes" not in payload:
        _fail("Thiếu `nodes`")
    nodes = _validate_nodes(payload.get("nodes"))
    edges = _validate_edges(payload.get("edges"), {node["id"] for node in nodes})
    return name, nodes, edges


def _build_generation(raw: dict) -> dict:
    """Project the file's payload onto the camelCase keys the runtime reads.

    Every key the file has is carried over — mapped when we know the runtime
    name, verbatim otherwise — so a field this build has never heard of still
    survives, and `null` stays `null` (only absent keys are absent).
    """
    generation: dict[str, Any] = {}
    source = raw.get("generation")
    if isinstance(source, dict):
        for key, value in source.items():
            generation[GENERATION_KEY_MAP.get(key, key)] = deepcopy(value)
    properties = raw.get("properties")
    if isinstance(properties, dict):
        for key, value in properties.items():
            generation[key] = deepcopy(value)
    if "prompt" in raw:
        generation["prompt"] = deepcopy(raw["prompt"])
    return generation


def _build_node_data(node: dict) -> dict:
    raw = node["raw"]
    data: dict[str, Any] = {"type": node["type"]}
    title = raw.get("title")
    if isinstance(title, str) and title:
        data["title"] = title
    generation = _build_generation(raw)
    if generation:
        data["generation"] = generation
    properties = raw.get("properties")
    if isinstance(properties, dict) and properties:
        data["properties"] = deepcopy(properties)
    # The node exactly as the file spelled it, including its original id.
    data["importSource"] = {
        "format": SUPPORTED_FORMAT,
        "format_version": SUPPORTED_FORMAT_VERSION,
        "id": node["id"],
        "node": deepcopy(raw),
    }
    return data


def _layered_layout(nodes: list[dict], edges: list[dict]) -> dict[str, tuple[float, float]]:
    """Deterministic top-to-bottom layout, with peers side by side per depth."""
    predecessors: dict[str, list[str]] = {node["id"]: [] for node in nodes}
    for edge in edges:
        predecessors[edge["target"]].append(edge["source"])

    layer = dict.fromkeys(predecessors, 0)
    # Longest-path layering. The cap keeps a cycle from pushing nodes off to
    # infinity; it only ever affects files that are already malformed.
    cap = max(0, len(nodes) - 1)
    for _ in range(len(nodes)):
        changed = False
        for node_id, incoming in predecessors.items():
            if not incoming:
                continue
            candidate = min(max(layer[source] for source in incoming) + 1, cap)
            if candidate > layer[node_id]:
                layer[node_id] = candidate
                changed = True
        if not changed:
            break

    rows: dict[int, list[str]] = {}
    for node in nodes:
        rows.setdefault(layer[node["id"]], []).append(node["id"])

    positions: dict[str, tuple[float, float]] = {}
    for row, node_ids in sorted(rows.items()):
        for column, node_id in enumerate(node_ids):
            positions[node_id] = (
                ORIGIN_X + column * (NODE_WIDTH + COLUMN_GAP),
                ORIGIN_Y + row * (NODE_HEIGHT + ROW_GAP),
            )
    return positions


def _resolve_positions(nodes: list[dict], edges: list[dict]) -> dict[str, tuple[float, float]]:
    """Use the file's own coordinates when it has them for every node.

    Mixing file coordinates with computed ones would let two cards land on top
    of each other, so an all-or-nothing rule keeps the result predictable.
    """
    if nodes and all(node["has_position"] for node in nodes):
        return {
            node["id"]: (float(node["raw"]["x"]), float(node["raw"]["y"]))
            for node in nodes
        }
    return _layered_layout(nodes, edges)


def _import_assets(core: Any, workspace_id: str, node: dict) -> list[str]:
    """Materialise the file's base64 assets as real media rows + local files."""
    media_ids: list[str] = []
    for asset in node["assets"]:
        media_id = asset["media_id"]
        if not media_id or core.media.get(media_id):
            media_id = f"import-{secrets.token_hex(8)}"
        core.media.upsert({
            "id": media_id,
            "kind": "image",
            "source": "import",
            "prompt": asset["name"],
            "aspect": image_aspect(asset["bytes"]),
            "workspace_id": workspace_id,
        })
        core.media.save_bytes(media_id, asset["bytes"], asset["mime_type"], workspace_id=workspace_id)
        media_ids.append(media_id)
    return media_ids


def import_canvas_project(core: Any, payload: Any) -> dict:
    """Validate `payload` and rebuild it as a brand new board.

    Raises CanvasProjectImportError for anything that must not reach the
    database. The write itself is a single transaction, so a failure partway
    through leaves no half-imported project behind.
    """
    name, nodes, edges = _validate_document(payload)
    positions = _resolve_positions(nodes, edges)

    db = core.db
    with db.transaction():
        public_id = new_public_id()
        board_id = db.insert("canvas_boards", {
            "name": name,
            "project_id": "default",
            "public_id": public_id,
            "created_at": time.time(),
            "viewport": None,
            "source_json": deepcopy(payload),
        })
        # Same first-board bookkeeping create_canvas_board does: jobs and media
        # that predate any board belong to the project the user just made.
        if db.one("SELECT COUNT(*) AS n FROM canvas_boards")["n"] == 1:
            db.execute("UPDATE jobs SET workspace_id=? WHERE workspace_id IS NULL", (public_id,))
            db.execute("UPDATE media SET workspace_id=? WHERE workspace_id IS NULL", (public_id,))
        board = db.one(
            "SELECT id, public_id, name, project_id, created_at, viewport, worker_id "
            "FROM canvas_boards WHERE id=?",
            (board_id,),
        )
        core.media.project_dir(public_id)

        # Original id -> row id. Edges are rewritten through this map, so they
        # can only ever point at a node of the project being imported.
        id_map: dict[str, int] = {}
        for node in nodes:
            data = _build_node_data(node)
            media_ids = _import_assets(core, public_id, node)
            if media_ids:
                data["mediaId"] = media_ids[0]
                data["mediaIds"] = media_ids
                status = "done"
            else:
                # Import never runs a generation: a node without its own media
                # comes back as a card the user can generate from.
                status = "idle"
            data["status"] = status
            x, y = positions[node["id"]]
            node_id = db.insert("canvas_nodes", {
                "board_id": board_id,
                "type": node["type"],
                # The file's own id, kept in the column the UI shows as #id.
                "short_id": node["id"],
                "status": status,
                "x": float(x),
                "y": float(y),
                "data": data,
            })
            id_map[node["id"]] = node_id

        for edge in edges:
            db.insert("canvas_edges", {
                "board_id": board_id,
                "source_id": id_map[edge["source"]],
                "target_id": id_map[edge["target"]],
                "source_variant_idx": edge["source_variant_idx"],
            })

    return {
        "board": board,
        "imported": {"nodes": len(nodes), "edges": len(edges)},
    }

