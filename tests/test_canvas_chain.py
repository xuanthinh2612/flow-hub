"""Tests for the Canvas chain rules.

Covers the behaviours the rules depend on:

* a node whose upstream fails is parked at `idle`, never `failed`
  (JobEngine._wait_canvas_dependencies raises ChainStopped -> _block_chain);
* stopping a node stops its whole downstream through the edge graph, and
  leaves upstream / independent nodes alone (stop-chain / stop-all);
* Run from Here (resume-chain) never re-runs a `done` node, and accepts a
  `done` root so its unfinished downstream can continue.

Deterministic by construction: jobs are inserted straight into SQLite, so
no worker, no network, and no background task runs unless a test starts it.
"""
from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from fastapi.testclient import TestClient

import flowhub.main
from flowhub import canvas_chain
from flowhub.config import Config
from flowhub.jobs import ChainStopped


# ── helpers ────────────────────────────────────────────────────────────────

def make_board(client: TestClient) -> int:
    res = client.post("/api/boards", json={"name": "Chain"})
    assert res.status_code == 201, res.text
    return res.json()["id"]


def make_node(client: TestClient, board_id: int, node_type: str = "image",
              x: int = 0, y: int = 0, data: dict | None = None) -> int:
    res = client.post("/api/nodes", json={
        "board_id": board_id, "type": node_type, "x": x, "y": y, "data": data or {},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def make_edge(client: TestClient, board_id: int, source_id: int, target_id: int) -> None:
    res = client.post("/api/edges", json={
        "board_id": board_id, "source_id": source_id, "target_id": target_id,
    })
    assert res.status_code == 201, res.text


def make_job(core, node_id: int, status: str = "queued", spec: dict | None = None,
              results: list | None = None, t: float = 1.0) -> tuple[str, str]:
    """Insert a canvas job + request row directly (no scheduler involved).

    The node status is mirrored from the job the way the real pipeline does it
    (`dispatchGeneration` stamps `queued`), so board-level rules that filter on
    canvas_nodes.status see the same picture the engine does.
    """
    spec = {"type": "image", "prompt": "p", **(spec or {})}
    job_id = uuid.uuid4().hex[:12]
    core.db.insert("jobs", {
        "id": job_id, "type": spec["type"], "status": status,
        "spec": json.dumps(spec), "prompt": "p",
        "warnings": "[]", "ops": "[]", "results": json.dumps(results or []),
        "created_at": t, "updated_at": t, "finished_at": None,
    })
    request_id = uuid.uuid4().hex[:12]
    core.db.insert("canvas_requests", {
        "id": request_id, "job_id": job_id, "type": spec["type"],
        "node_id": str(node_id), "params": "{}", "created_at": t,
    })
    node_status = "error" if status in {"failed", "timeout", "canceled"} else status
    if status == "done" and results:
        set_node_status(core, node_id, "done", {"mediaId": results[0]["media_id"]})
    else:
        set_node_status(core, node_id, node_status)
    return job_id, request_id


def link_nodes(core, node_id: int, upstream_node_id: int, upstream_request_id: str) -> None:
    """Point a node's latest job at another node's request as its dependency."""
    row = core.db.one(
        "SELECT job_id FROM canvas_requests WHERE node_id=? "
        "ORDER BY created_at DESC, id DESC LIMIT 1", (node_id,))
    job_id = row["job_id"]
    raw = core.db.one("SELECT spec FROM jobs WHERE id=?", (job_id,))["spec"]
    spec = raw if isinstance(raw, dict) else json.loads(raw or "{}")
    spec["canvas_dependencies"] = [{
        "source_node_id": int(upstream_node_id),
        "request_id": upstream_request_id,
        "source_type": "image",
        "previous_media_ids": [],
    }]
    core.db.update("jobs", "id", job_id, {"spec": json.dumps(spec)})


def node_status(client: TestClient, board_id: int, node_id: int) -> str:
    detail = client.get(f"/api/boards/{board_id}").json()
    node = next(n for n in detail["nodes"] if n["id"] == node_id)
    return node["status"]


def set_node_status(core, node_id: int, status: str, data: dict | None = None) -> None:
    row = core.db.one("SELECT data FROM canvas_nodes WHERE id=?", (node_id,))
    raw = (row or {}).get("data")
    blob = raw if isinstance(raw, dict) else (json.loads(raw or "{}") if raw else {})
    if data:
        blob.update(data)
    core.db.update("canvas_nodes", "id", node_id,
                   {"status": status, "data": json.dumps(blob, ensure_ascii=False)})


# ── fixture ───────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path):
    config = Config(
        host="127.0.0.1", port=8787,
        data_dir=tmp_path / "data",
        worker_token="t", api_key="k", auth="off",
    )
    app = flowhub.main.create_app(config)
    with TestClient(app) as test_client:
        yield test_client


# ── 1. a failed upstream parks its dependents at idle, not failed ─────────

def test_failed_upstream_parks_downstream_idle(client):
    board = make_board(client)
    core = client.app.state.core
    upstream = make_node(client, board)
    dependent = make_node(client, board)
    make_edge(client, board, upstream, dependent)

    _, failed_request = make_job(core, upstream, status="failed")
    dep_job, dep_request = make_job(core, dependent, status="queued")
    link_nodes(core, dependent, upstream, failed_request)

    # The engine refuses to run a node whose prerequisite failed — with
    # ChainStopped rather than a plain failure, so it is not recorded as failed.
    with pytest.raises(ChainStopped):
        asyncio.run(core.jobs._wait_canvas_dependencies(core.jobs.get(dep_job)))

    # Blocking the chain parks the dependent at idle: it never executed.
    core.jobs._block_chain(core.jobs.get(dep_job), "dừng chuỗi: node nguồn #1 thất bại (failed)")

    job = core.jobs.get(dep_job)
    assert job["status"] == "canceled"
    assert job["spec"]["chain_blocked"] is True
    assert node_status(client, board, dependent) == "idle"
    # Only the node that actually ran is failed.
    assert node_status(client, board, upstream) == "error"

    # The Canvas can tell a parked node from a user-canceled one, so the poll
    # loop leaves it at idle instead of painting the canceled error state.
    res = client.get(f"/api/canvas/requests/{dep_request}")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "canceled"
    assert body["stopped"] is True



def test_canceled_upstream_also_parks_downstream(client):
    """The same rule when the upstream was stopped by the user, not failed."""
    board = make_board(client)
    core = client.app.state.core
    upstream = make_node(client, board)
    dependent = make_node(client, board)
    make_edge(client, board, upstream, dependent)

    _, upstream_request = make_job(core, upstream, status="canceled")
    dep_job, _ = make_job(core, dependent, status="queued")
    link_nodes(core, dependent, upstream, upstream_request)

    core.jobs._block_chain(core.jobs.get(dep_job), "dừng chuỗi: node nguồn #1 thất bại (canceled)")
    assert node_status(client, board, dependent) == "idle"
    assert node_status(client, board, upstream) == "error"


# ── 2. stopping a node stops its whole downstream ──────────────────────────

def test_stop_chain_scope_follows_the_graph(client):
    board = make_board(client)
    core = client.app.state.core
    # X -> A -> B -> C   (A is mid-chain); K sits on its own branch.
    x = make_node(client, board)
    a = make_node(client, board)
    b = make_node(client, board)
    c = make_node(client, board)
    k = make_node(client, board)
    make_edge(client, board, x, a)
    make_edge(client, board, a, b)
    make_edge(client, board, b, c)

    make_job(core, x, status="done", results=[{"media_id": "m-x", "url": "u"}])
    make_job(core, a, status="running")
    make_job(core, b, status="queued")   # waiting on A
    make_job(core, c, status="queued")   # waiting on B
    make_job(core, k, status="running")  # unrelated branch

    res = client.post(f"/api/boards/{board}/nodes/{a}/stop-chain")
    assert res.status_code == 200, res.text
    stopped = {item["id"]: item["status"] for item in res.json()["stopped"]}

    # A was mid-generation: canceled, retryable. Its dependents never ran:
    # they park at idle. Upstream and the independent branch are untouched.
    assert stopped[a] == "canceled"
    assert stopped[b] == "idle"
    assert stopped[c] == "idle"
    assert x not in stopped and k not in stopped
    assert node_status(client, board, a) == "error"
    assert node_status(client, board, b) == "idle"
    assert node_status(client, board, c) == "idle"


def test_stop_chain_cancels_a_running_dependent_without_failing_it(client):
    """A dependent mid-generation is stopped, but never marked failed."""
    board = make_board(client)
    core = client.app.state.core
    head = make_node(client, board)
    running = make_node(client, board)
    make_edge(client, board, head, running)

    make_job(core, head, status="running")
    make_job(core, running, status="running")  # already executing downstream

    res = client.post(f"/api/boards/{board}/nodes/{head}/stop-chain")
    assert res.status_code == 200
    stopped = {item["id"]: item["status"] for item in res.json()["stopped"]}

    # Canceled + retryable — the status the card already knows, not `failed`.
    assert stopped == {head: "canceled", running: "canceled"}
    assert node_status(client, board, running) == "error"
    assert node_status(client, board, head) == "error"
    # The dependent's error is the cancellation, not an execution failure.
    latest = canvas_chain.latest_request(core.db, running)
    job = core.jobs.get(latest["job_id"])
    assert job["status"] == "canceled"


def test_stop_chain_ignores_canvas_layout(client):
    """A node physically between two others is not 'downstream' of either."""
    board = make_board(client)
    core = client.app.state.core
    left = make_node(client, board, x=0)
    middle = make_node(client, board, x=200)   # sits between them…
    right = make_node(client, board, x=400)
    # …but only `left -> right` is wired. `middle` is independent.
    make_edge(client, board, left, right)

    make_job(core, left, status="running")
    make_job(core, right, status="queued")
    make_job(core, middle, status="running")

    res = client.post(f"/api/boards/{board}/nodes/{left}/stop-chain")
    assert res.status_code == 200
    stopped = {item["id"]: item["status"] for item in res.json()["stopped"]}
    assert stopped == {left: "canceled", right: "idle"}
    assert node_status(client, board, middle) == "running"


def test_stop_all_stops_running_nodes_but_keeps_done_and_failed(client):
    board = make_board(client)
    core = client.app.state.core
    running = make_node(client, board)
    waiting = make_node(client, board)
    done = make_node(client, board)
    failed = make_node(client, board)
    make_edge(client, board, running, waiting)

    make_job(core, running, status="running")
    make_job(core, waiting, status="queued")
    make_job(core, done, status="done", results=[{"media_id": "m-d", "url": "u"}])
    make_job(core, failed, status="failed")

    res = client.post(f"/api/boards/{board}/stop-all")
    assert res.status_code == 200, res.text
    stopped = {item["id"]: item["status"] for item in res.json()["stopped"]}

    assert stopped[running] == "canceled"
    assert stopped[waiting] == "idle"
    assert done not in stopped and failed not in stopped
    assert node_status(client, board, done) == "done"
    assert node_status(client, board, failed) == "error"



# ── 3. Run from Here never re-runs a done node ────────────────────────────

def test_resume_chain_skips_done_and_allows_done_root(client):
    from flowhub import canvas_chain

    board = make_board(client)
    core = client.app.state.core
    root = make_node(client, board)
    downstream = make_node(client, board)
    make_edge(client, board, root, downstream)

    _, root_request = make_job(core, root, status="done",
                              results=[{"media_id": "m-root", "url": "u"}])
    down_job, _ = make_job(core, downstream, status="failed")
    link_nodes(core, downstream, root, root_request)
    set_node_status(core, root, "done", {"mediaId": "m-root"})
    set_node_status(core, downstream, "error", {"error": "lỗi cũ"})

    res = client.post(f"/api/boards/{board}/nodes/{root}/resume-chain",
                      json={"request_id": root_request})
    assert res.status_code == 200, res.text
    items = res.json()["items"]

    # Only the failed downstream is restarted; the done root is untouched.
    assert [item["node_id"] for item in items] == [str(downstream)]
    assert node_status(client, board, root) == "done"
    assert node_status(client, board, downstream) == "queued"
    # A brand-new job replaces the failed one.
    latest = canvas_chain.latest_request(core.db, downstream)
    assert latest["job_id"] != down_job
    assert latest["job_status"] in {"queued", "running"}


def test_resume_chain_still_rejects_a_running_root(client):
    board = make_board(client)
    core = client.app.state.core
    node = make_node(client, board)
    _, running_request = make_job(core, node, status="running")

    res = client.post(f"/api/boards/{board}/nodes/{node}/resume-chain",
                      json={"request_id": running_request})
    assert res.status_code == 409


# ── 4. graph helpers the buttons and the engine share ─────────────────────

def test_topological_order_respects_dependencies(client):
    from flowhub import canvas_chain

    core = client.app.state.core
    board = make_board(client)
    ids = [make_node(client, board) for _ in range(4)]
    # 3 -> 0, 3 -> 1, 0 -> 2  (shuffled edge insertion, deliberately)
    make_edge(client, board, ids[3], ids[0])
    make_edge(client, board, ids[3], ids[1])
    make_edge(client, board, ids[0], ids[2])

    order = canvas_chain.topo_order(core.db, board, ids)
    assert order.index(ids[3]) < order.index(ids[0]) < order.index(ids[2])
    assert order.index(ids[3]) < order.index(ids[1])
    assert sorted(order) == sorted(ids)


def test_topological_order_tolerates_a_cycle(client):
    from flowhub import canvas_chain

    core = client.app.state.core
    board = make_board(client)
    a = make_node(client, board)
    b = make_node(client, board)
    make_edge(client, board, a, b)
    make_edge(client, board, b, a)

    # No node is dropped: a cycle cannot be ordered, it is reported.
    assert sorted(canvas_chain.topo_order(core.db, board, [a, b])) == sorted([a, b])



# ── 5. an uploaded image is a valid chain source ───────────────────────────

def test_uploaded_image_can_feed_a_downstream_node(client):
    """An uploaded image must be usable as the source of a chain.

    Uploads take a different path from generated media: `/api/uploads` creates
    a bare `jobs` row, so the node ends up `status="done"` with
    `data.mediaId` set and NO `canvas_requests` row at all. The chain check in
    `create_canvas_request` must read `mediaId` off the node instead of
    concluding the source has no result — otherwise every image→video chain
    dies on "node nguồn #N đang lỗi hoặc chưa có kết quả để nối chuỗi".
    """
    board = make_board(client)
    core = client.app.state.core
    public_id = core.db.one("SELECT public_id FROM canvas_boards WHERE id=?", (board,))["public_id"]

    uploaded = make_node(client, board, node_type="image")
    video = make_node(client, board, node_type="video")
    make_edge(client, board, uploaded, video)

    core.db.insert("media", {"id": "up-1", "kind": "image", "url": "u",
                             "workspace_id": public_id, "created_at": 1.0})
    # Exactly what NodeCard's upload path persists once the job finishes.
    set_node_status(core, uploaded, "done", {"mediaId": "up-1", "mediaIds": None})

    res = client.post("/api/canvas/requests", json={
        "type": "i2v", "node_id": str(video), "params": {},
        "spec": {"type": "i2v", "prompt": "make it move", "start_media_ids": ["up-1"]},
        "workspace_id": public_id,
    })
    assert res.status_code == 201, res.text

    job_id = core.db.one("SELECT job_id FROM canvas_requests WHERE id=?", (res.json()["id"],))["job_id"]
    # The source already has media, so there is nothing to wait for.
    assert not core.jobs.get(job_id)["spec"].get("canvas_dependencies")


def test_generated_image_chain_still_waits_when_it_has_no_media_yet(client):
    """Guard the other side of the fix: a source with a *done* job but no
    media must still be awaited, not dispatched with a missing input."""
    board = make_board(client)
    core = client.app.state.core
    public_id = core.db.one("SELECT public_id FROM canvas_boards WHERE id=?", (board,))["public_id"]

    upstream = make_node(client, board, node_type="image")
    video = make_node(client, board, node_type="video")
    make_edge(client, board, upstream, video)

    make_job(core, upstream, status="done", results=[])
    set_node_status(core, upstream, "done")

    res = client.post("/api/canvas/requests", json={
        "type": "i2v", "node_id": str(video), "params": {},
        "spec": {"type": "i2v", "prompt": "p"}, "workspace_id": public_id,
    })
    assert res.status_code == 201, res.text
    job_id = core.db.one("SELECT job_id FROM canvas_requests WHERE id=?", (res.json()["id"],))["job_id"]
    deps = core.jobs.get(job_id)["spec"]["canvas_dependencies"]
    assert [d["source_node_id"] for d in deps] == [upstream]


def test_extend_video_canvas_chain(client):
    """Test canvas chain for extend_video:
    1. Downstream extend_video node can depend on upstream running video node.
    2. When upstream finishes, _wait_canvas_dependencies injects source_media_id.
    """
    board = make_board(client)
    core = client.app.state.core
    public_id = core.db.one("SELECT public_id FROM canvas_boards WHERE id=?", (board,))["public_id"]

    upstream_video = make_node(client, board, node_type="video")
    downstream_extend = make_node(client, board, node_type="video")
    make_edge(client, board, upstream_video, downstream_extend)

    up_job, up_req = make_job(core, upstream_video, status="running")

    # Submit extend_video request while upstream is still running
    res = client.post("/api/canvas/requests", json={
        "type": "gen_video_extend",
        "node_id": str(downstream_extend),
        "params": {"prompt": "extend action"},
        "spec": {
            "type": "extend_video",
            "family": "veo",
            "prompt": "extend action",
            "aspect": "16:9",
            "count": 1,
        },
        "workspace_id": public_id,
    })
    assert res.status_code == 201, res.text
    down_job_id = core.db.one("SELECT job_id FROM canvas_requests WHERE id=?", (res.json()["id"],))["job_id"]

    # Verify dependency on upstream
    down_job = core.jobs.get(down_job_id)
    deps = down_job["spec"]["canvas_dependencies"]
    assert len(deps) == 1
    assert deps[0]["source_node_id"] == upstream_video
    assert deps[0]["source_type"] == "video"

    # Now upstream finishes with a media id
    vid_media_id = "test-vid-12345"
    core.db.insert("media", {
        "id": vid_media_id, "kind": "video", "url": "http://media/test.mp4",
        "workspace_id": public_id, "created_at": 1.0,
    })
    core.db.update("jobs", "id", up_job, {
        "status": "done",
        "results": [{"media_id": vid_media_id}],
    })

    # Resolve dependencies
    asyncio.run(core.jobs._wait_canvas_dependencies(core.jobs.get(down_job_id)))

    # Verify that source_media_id was injected into the extend_video spec
    updated_down_job = core.jobs.get(down_job_id)
    assert updated_down_job["spec"]["source_media_id"] == vid_media_id
    assert "canvas_dependencies" not in updated_down_job["spec"]

