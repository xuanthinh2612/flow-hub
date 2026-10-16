from __future__ import annotations

import json
import pytest
from fastapi.testclient import TestClient

import flowhub.main
from flowhub.config import Config
from flowhub.protocol import batch as fb
from flowhub.protocol import observe as ob


def make_config(data_dir):
    return Config(
        host="127.0.0.1",
        port=8787,
        data_dir=data_dir,
        worker_token="t",
        api_key="k",
        auth="off",
    )


def test_video_reference_request_builder():
    """Verify video_reference_request shape and envelope."""
    req_str = fb.video_reference_request(
        prompt="transform the girl in the video",
        project_id="proj-123",
        source_media_id="vid-source-999",
        aspect=fb.VIDEO_PORTRAIT,
        model=fb.VIDEO_REFERENCE_OPERATION,
        image_reference_ids=["img-ref-1", "img-ref-2"],
    )
    env = fb.decode_envelope(req_str)
    assert len(env) == 1
    rpcid, inner = env[0]
    assert rpcid == fb.RPC_VIDEO_REFERENCE

    # inner: [[request], context, trailing]
    assert len(inner) == 3
    request = inner[0][0]
    # request[0] is source video block: [None, media_id, height, width]
    assert request[0] == [None, "vid-source-999", fb.VIDEO_REFERENCE_HEIGHT, fb.VIDEO_REFERENCE_WIDTH]
    # request[1] is prompt block
    assert request[1][2][0][0][0] == "transform the girl in the video"
    # request[2] is model/operation: abra_edit
    assert request[2] == "abra_edit"
    # request[3] is aspect code
    assert request[3] == fb.VIDEO_PORTRAIT
    # request[8] is image references
    assert request[8] == [[None, "img-ref-1"], [None, "img-ref-2"]]

    # Test observe.rebuild on this inner payload
    fb.set_uuid_factory(lambda: "00000000-0000-0000-0000-000000000000")
    try:
        rebuilt = ob.rebuild(rpcid, inner)
        assert rebuilt is not None
        rebuilt_env = fb.decode_envelope(rebuilt)
        assert rebuilt_env[0][0] == fb.RPC_VIDEO_REFERENCE
        assert rebuilt_env[0][1][0][0][0] == request[0]
        assert rebuilt_env[0][1][0][0][2] == "abra_edit"
        assert rebuilt_env[0][1][0][0][8] == request[8]
    finally:
        fb.reset_uuid_factory()


def test_jobs_normalize_and_plan(tmp_path):
    cfg = make_config(tmp_path / "data")
    core = flowhub.main.Core(cfg)

    # Missing source_media_id without canvas_dependencies -> ValueError
    with pytest.raises(ValueError, match="video_reference cần source_media_id"):
        core.jobs.normalize({"type": "video_reference", "prompt": "test"})

    # source_media_id provided -> resolves model to abra_edit
    spec = core.jobs.normalize({
        "type": "video_reference",
        "prompt": "test prompt",
        "source_media_id": "vid-1",
        "aspect": "9:16",
        "project_id": "p-1",
    })
    assert spec["type"] == "video_reference"
    assert spec["source_media_id"] == "vid-1"
    assert spec["model"] == "abra_edit"

    # plan() generates call with RPC_VIDEO_REFERENCE
    calls = core.jobs.plan({"type": "video_reference", "spec": spec}, "p-1")
    assert len(calls) == 1
    assert calls[0].rpcid == fb.RPC_VIDEO_REFERENCE
    assert calls[0].captcha == fb.CAPTCHA_VIDEO


def test_api_canvas_request_video_reference_validation(tmp_path):
    cfg = make_config(tmp_path / "data")
    app = flowhub.main.create_app(cfg)
    client = TestClient(app)
    core = app.state.core

    # Create a board (no worker attached so extension online check passes)
    b_res = client.post("/api/boards", json={"name": "VideoRef Board"})
    board = b_res.json()
    board_id = board["id"]
    public_id = board["public_id"]

    # Create canvas node
    n_res = client.post("/api/nodes", json={"board_id": board_id, "type": "video", "x": 0, "y": 0, "data": {}})
    node_id = n_res.json()["id"]

    # Insert test media: one video, one image
    core.media.upsert({"id": "vid-in-proj", "kind": "video", "workspace_id": public_id})
    core.media.upsert({"id": "img-in-proj", "kind": "image", "workspace_id": public_id})
    core.media.upsert({"id": "vid-other-proj", "kind": "video", "workspace_id": "other-proj"})
    core.media.upsert({"id": "img-as-source", "kind": "image", "workspace_id": public_id})

    # 1. source_media_id not in project -> 400
    res = client.post("/api/canvas/requests", json={
        "node_id": node_id,
        "type": "gen_video_video_reference",
        "workspace_id": public_id,
        "params": {},
        "spec": {
            "type": "video_reference",
            "prompt": "test",
            "family": "omni_flash",
            "source_media_id": "vid-other-proj",
        }
    })
    assert res.status_code == 400
    assert "không thuộc project canvas" in res.json()["detail"]

    # 2. source_media_id is not a video -> 400
    res = client.post("/api/canvas/requests", json={
        "node_id": node_id,
        "type": "gen_video_video_reference",
        "workspace_id": public_id,
        "params": {},
        "spec": {
            "type": "video_reference",
            "prompt": "test",
            "family": "omni_flash",
            "source_media_id": "img-as-source",
        }
    })
    assert res.status_code == 400
    assert "source_media_id phải là video" in res.json()["detail"]

    # 3. family is not omni_flash -> 400
    res = client.post("/api/canvas/requests", json={
        "node_id": node_id,
        "type": "gen_video_video_reference",
        "workspace_id": public_id,
        "params": {},
        "spec": {
            "type": "video_reference",
            "prompt": "test",
            "family": "veo",
            "source_media_id": "vid-in-proj",
        }
    })
    assert res.status_code == 400
    assert "chỉ hỗ trợ Omni Flash" in res.json()["detail"]

    # 4. ref_media_ids contains a video -> 400
    core.media.upsert({"id": "vid-2-in-proj", "kind": "video", "workspace_id": public_id})
    res = client.post("/api/canvas/requests", json={
        "node_id": node_id,
        "type": "gen_video_video_reference",
        "workspace_id": public_id,
        "params": {},
        "spec": {
            "type": "video_reference",
            "prompt": "test",
            "family": "omni_flash",
            "source_media_id": "vid-in-proj",
            "ref_media_ids": ["vid-2-in-proj"],
        }
    })
    assert res.status_code == 400
    assert "video_reference chỉ nhận 1 video tham chiếu" in res.json()["detail"]

    # 5. Valid request -> 201
    res = client.post("/api/canvas/requests", json={
        "node_id": node_id,
        "type": "gen_video_video_reference",
        "workspace_id": public_id,
        "params": {},
        "spec": {
            "type": "video_reference",
            "prompt": "đổi màu áo nhân vật",
            "family": "omni_flash",
            "source_media_id": "vid-in-proj",
            "ref_media_ids": ["img-in-proj"],
            "aspect": "9:16",
            "count": 1,
        }
    })
    assert res.status_code == 201
    body = res.json()
    assert body["status"] in ("queued", "running")
    req_row = core.db.one("SELECT job_id FROM canvas_requests WHERE id=?", (body["id"],))
    job = core.jobs.get(req_row["job_id"])
    assert job["spec"]["type"] == "video_reference"
    assert job["spec"]["source_media_id"] == "vid-in-proj"
    assert job["spec"]["model"] == "abra_edit"

