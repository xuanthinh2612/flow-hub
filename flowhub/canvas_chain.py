"""Canvas graph helpers shared by the API and the job engine.

Every rule about a node chain lives here so the two callers that enforce it —
the REST layer (Run All / cancel-chain / resume-chain) and the job engine
(stopping dependents when a prerequisite dies) — cannot drift apart.

The vocabulary the rules are written in:

``done``
    The node produced its media. Never executed again by Run All or
    Run from Here, no matter which chain it belongs to.
``failed``
    The node ran and failed. Only this node carries the error; its dependents
    are untouched.
``idle``
    Not run, or parked back to "ready to run" after the chain stopped. This is
    the resting state for a node whose prerequisite is broken — never ``failed``,
    because the node itself never executed.
``queued`` / ``running``
    A job for the node exists and the engine is working on it.

The chain is followed through ``canvas_edges`` (the real dependency graph) and
never through canvas coordinates: node layout carries no ordering meaning.
"""
from __future__ import annotations

import json
from typing import Iterable, Optional

#: canvas_nodes.status values that mean "a job is on this node right now".
ACTIVE_NODE_STATUSES = {"queued", "running"}

#: Job terminal states that leave the node retryable but not done.
RETRYABLE_JOB_STATUSES = {"failed", "timeout", "canceled"}


def node_data(db, node_id: int) -> dict:
    """`canvas_nodes.data` as a dict (the column is JSON text)."""
    row = db.one("SELECT data FROM canvas_nodes WHERE id=?", (int(node_id),))
    raw = (row or {}).get("data")
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        decoded = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


def merge_node_data(db, node_id: int, delta: dict) -> None:
    """Merge `delta` into the node's JSON data blob and write it back."""
    data = node_data(db, node_id)
    data.update(delta)
    db.update("canvas_nodes", "id", int(node_id), {"data": json.dumps(data, ensure_ascii=False)})


def board_id_for_node(db, node_id: int) -> Optional[int]:
    row = db.one("SELECT board_id FROM canvas_nodes WHERE id=?", (int(node_id),))
    return int(row["board_id"]) if row else None


def node_id_for_job(db, job_id: str) -> Optional[int]:
    """The canvas node a job belongs to, or None for non-canvas jobs."""
    row = db.one(
        "SELECT node_id FROM canvas_requests WHERE job_id=? ORDER BY created_at DESC LIMIT 1",
        (str(job_id),),
    )
    if not row or row.get("node_id") is None:
        return None
    try:
        return int(row["node_id"])
    except (TypeError, ValueError):
        return None


def _edges(db, board_id: int) -> list[tuple[int, int]]:
    return [
        (int(edge["source_id"]), int(edge["target_id"]))
        for edge in db.all("SELECT source_id,target_id FROM canvas_edges WHERE board_id=?", (int(board_id),))
    ]


def downstream_ids(db, board_id: int, node_id: int) -> list[int]:
    """Every node that transitively depends on `node_id`.

    Breadth-first over the edges, so the result is grouped by distance: the
    nodes closest to the source come first. Cycles are tolerated (a node is
    emitted once) because a chain being cancelled must not hang on one.
    """
    adjacency: dict[int, list[int]] = {}
    for source, target in _edges(db, board_id):
        adjacency.setdefault(source, []).append(target)

    seen: set[int] = set()
    ordered: list[int] = []
    stack = list(adjacency.get(int(node_id), []))
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        ordered.append(current)
        stack.extend(adjacency.get(current, []))
    return ordered


def topo_order(db, board_id: int, node_ids: Iterable[int]) -> list[int]:
    """Order `node_ids` so every node comes after the ones it consumes.

    Edges leaving the set are ignored: a scope is its own graph, which is what
    lets Run from Here and Run All order a subset without dragging the rest of
    the board in. A cycle cannot be ordered, so the leftover nodes are appended
    in their original order — the engine rejects the real cycle later with a
    message that names the problem, which beats losing nodes silently here.
    """
    scope = [int(node_id) for node_id in node_ids]
    inside = set(scope)
    position = {node_id: index for index, node_id in enumerate(scope)}
    indegree = {node_id: 0 for node_id in scope}
    adjacency: dict[int, list[int]] = {node_id: [] for node_id in scope}
    for source, target in _edges(db, board_id):
        if source in inside and target in inside and source != target:
            adjacency[source].append(target)
            indegree[target] += 1

    ready = sorted((node_id for node_id, degree in indegree.items() if degree == 0), key=position.get)
    ordered: list[int] = []
    while ready:
        current = ready.pop(0)
        ordered.append(current)
        for target in adjacency[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
        ready.sort(key=position.get)

    placed = set(ordered)
    ordered.extend(node_id for node_id in scope if node_id not in placed)
    return ordered


def park_to_idle(db, node_id: int) -> None:
    """Put a node back to `idle`: ready to run again, carrying no error.

    The previous request stays on the node (so the UI can still name what
    stopped it), but the cleared error and ``canceled`` flag are what stop a
    parked node from being mistaken for one that actually failed.
    """
    merge_node_data(db, node_id, {"error": None, "canceled": None})
    db.update("canvas_nodes", "id", int(node_id), {"status": "idle"})


def mark_canceled(db, node_id: int, request_id: str) -> None:
    """A node whose own generation the user stopped: canceled, still retryable."""
    merge_node_data(db, node_id, {
        "error": "Đã hủy",
        "canceled": True,
        "lastRequestId": str(request_id),
        "lastRequestStatus": "canceled",
    })
    db.update("canvas_nodes", "id", int(node_id), {"status": "error"})


def mark_failed(db, node_id: int, request_id: str, status: str, error: Optional[str]) -> None:
    """A node that ran and failed: the only node in a chain that carries `failed`."""
    merge_node_data(db, node_id, {
        "error": error,
        "canceled": False,
        "lastRequestId": str(request_id),
        "lastRequestStatus": status,
    })
    db.update("canvas_nodes", "id", int(node_id), {"status": "error"})


def latest_request(db, node_id: int) -> Optional[dict]:
    """The node's most recent canvas request together with its job status."""
    return db.one(
        "SELECT r.id AS request_id, r.job_id, r.type, j.status AS job_status "
        "FROM canvas_requests r JOIN jobs j ON j.id=r.job_id "
        "WHERE r.node_id=? ORDER BY r.created_at DESC, r.id DESC LIMIT 1",
        (str(node_id),),
    )
