from __future__ import annotations

import json
from unittest.mock import MagicMock, patch
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


def test_upscale_video_request_builder():
    """Verify upscale_video_request shape, rpcid and parameters."""
    req_str = fb.upscale_video_request(
        source_media_id="vid-source-123",
        project_id="proj-456",
        aspect=fb.VIDEO_LANDSCAPE,
        model=fb.VIDEO_UPSCALER_MODEL,
        clip_id="clip-789",
    )
    env = fb.decode_envelope(req_str)
    assert len(env) == 1
    rpcid, inner = env[0]
    assert rpcid == fb.RPC_UPSCALE_VIDEO
    assert rpcid == "p0UkFb"

    # inner: [[request], context, trailing]
    assert len(inner) == 3
    request = inner[0][0]
    assert request[0] == [None, "vid-source-123"]
    assert request[2] == fb.VIDEO_LANDSCAPE
    assert request[4][1] == "clip-789"
    assert request[6] == fb.VIDEO_LANDSCAPE
    assert len(request) >= 32
    assert request[31] == "veo_3_1_upsampler_1080p"
    assert inner[1][5] == "proj-456"
    assert isinstance(inner[2], list)

    # Test observe.rebuild on this inner payload
    fb.set_uuid_factory(lambda: "00000000-0000-0000-0000-000000000000")
    try:
        rebuilt = ob.rebuild(rpcid, inner)
        assert rebuilt is not None
        rebuilt_env = fb.decode_envelope(rebuilt)
        assert rebuilt_env[0][0] == fb.RPC_UPSCALE_VIDEO
        assert rebuilt_env[0][1][0][0][0] == [None, "vid-source-123"]
        assert rebuilt_env[0][1][0][0][31] == "veo_3_1_upsampler_1080p"
    finally:
        fb.reset_uuid_factory()


def test_jobs_normalize_and_plan_upscale(tmp_path):
    cfg = make_config(tmp_path / "data")
    core = flowhub.main.Core(cfg)

    # Missing source_media_id -> ValueError
    with pytest.raises(ValueError, match="upscale_video cần source_media_id"):
        core.jobs.normalize({"type": "upscale_video"})

    # Valid normalize
    spec = core.jobs.normalize({
        "type": "upscale_video",
        "source_media_id": "vid-abc",
        "aspect": "16:9",
        "project_id": "proj-xyz",
    })
    assert spec["type"] == "upscale_video"
    assert spec["source_media_id"] == "vid-abc"
    assert spec["model"] == fb.VIDEO_UPSCALER_MODEL

    # plan() generates call with RPC_UPSCALE_VIDEO
    calls = core.jobs.plan({"type": "upscale_video", "spec": spec}, "proj-xyz")
    assert len(calls) == 1
    assert calls[0].rpcid == fb.RPC_UPSCALE_VIDEO
    assert calls[0].captcha == fb.CAPTCHA_VIDEO


def test_media_resolution_storage_and_cleanup(tmp_path):
    cfg = make_config(tmp_path / "data")
    core = flowhub.main.Core(cfg)

    mid = "test-media-vid-1"
    core.media.upsert({
        "id": mid,
        "kind": "video",
        "mime": "video/mp4",
        "project_id": "proj-1",
    })

    # Save 720p bytes
    bytes_720 = b"fake 720p video data"
    path_720 = core.media.save_bytes(mid, bytes_720, "video/mp4", resolution="720p")
    assert "_720p.mp4" in str(path_720)
    assert path_720.exists()
    assert path_720.read_bytes() == bytes_720

    m_row = core.media.get(mid)
    assert m_row["local_path_720p"] == str(path_720)
    assert m_row["local_path"] == str(path_720)

    # Save 1080p bytes
    bytes_1080 = b"fake 1080p high-res video data"
    path_1080 = core.media.save_bytes(mid, bytes_1080, "video/mp4", resolution="1080p")
    assert "_1080p.mp4" in str(path_1080)
    assert path_1080.exists()
    assert path_1080.read_bytes() == bytes_1080

    m_row = core.media.get(mid)
    assert m_row["local_path_1080p"] == str(path_1080)
    # Default local_path should prefer 1080p
    assert m_row["local_path"] == str(path_1080)

    # Resolution-specific resolution lookups
    assert core.media.local_file(mid, resolution="720p") == path_720
    assert core.media.local_file(mid, resolution="1080p") == path_1080
    assert core.media.local_file(mid) == path_1080  # auto prefers 1080p

    # Delete 720p specifically
    core.media.delete_resolution(mid, "720p")
    assert not path_720.exists()
    assert path_1080.exists()
    m_row = core.media.get(mid)
    assert m_row["local_path_720p"] is None
    assert m_row["local_path_1080p"] == str(path_1080)
    assert m_row["local_path"] == str(path_1080)

    # Delete entire media
    core.media.delete(mid)
    assert not path_1080.exists()
    assert core.media.get(mid) is None


def test_auto_upscale_settings_and_cleanup_logic(tmp_path):
    cfg = make_config(tmp_path / "data")
    core = flowhub.main.Core(cfg)

    # Verify settings defaults
    settings = core.settings.all()
    assert settings["auto_upscale_1080p"] is True
    assert settings["delete_720p_after_upscale"] is False

    mid = "test-video-auto-up"
    core.media.upsert({
        "id": mid,
        "kind": "video",
        "mime": "video/mp4",
        "project_id": "proj-1",
    })

    # Mock jobs.create to test _trigger_auto_upscale
    with patch.object(core.jobs, "create", return_value={"id": "job-upscale-999"}) as mock_create:
        core.jobs._trigger_auto_upscale(mid, "proj-1")
        mock_create.assert_called_once()
        call_kwargs = mock_create.call_args[0][0]
        assert call_kwargs["type"] == "upscale_video"
        assert call_kwargs["source_media_id"] == mid

    m_row = core.media.get(mid)
    assert m_row["upscale_status"] == "running"
    assert m_row["upscale_job_id"] == "job-upscale-999"

    # Test when auto_upscale_1080p is False
    core.settings.set("auto_upscale_1080p", False)
    with patch.object(core.jobs, "create") as mock_create2:
        core.jobs._trigger_auto_upscale("other-mid", "proj-1")
        mock_create2.assert_not_called()

    # Test _download_1080p_and_cleanup with delete_720p_after_upscale True vs False
    p720 = core.media.save_bytes(mid, b"720p", "video/mp4", resolution="720p")
    p1080 = core.media.save_bytes(mid, b"1080p", "video/mp4", resolution="1080p")
    assert p720.exists()
    assert p1080.exists()

    import asyncio
    from unittest.mock import AsyncMock

    # With delete_720p_after_upscale = False (default)
    with patch.object(core.media, "download", new_callable=AsyncMock) as mock_dl:
        mock_dl.return_value = p1080
        asyncio.run(core.jobs._download_1080p_and_cleanup(mid, "https://example.com/video1080.mp4", "worker-1"))
    assert p720.exists()  # Kept!

    # Now set delete_720p_after_upscale = True
    core.settings.set("delete_720p_after_upscale", True)
    with patch.object(core.media, "download", new_callable=AsyncMock) as mock_dl2:
        mock_dl2.return_value = p1080
        asyncio.run(core.jobs._download_1080p_and_cleanup(mid, "https://example.com/video1080.mp4", "worker-1"))
    assert not p720.exists()  # Deleted!
    assert p1080.exists()  # 1080p preserved!


def test_api_resolution_endpoints(tmp_path):
    cfg = make_config(tmp_path / "data")
    app = flowhub.main.create_app(cfg)
    client = TestClient(app)
    core = app.state.core

    mid = "api-test-vid"
    core.media.upsert({
        "id": mid,
        "kind": "video",
        "mime": "video/mp4",
        "project_id": "proj-1",
    })

    p720 = core.media.save_bytes(mid, b"vid-720p-bytes", "video/mp4", resolution="720p")
    p1080 = core.media.save_bytes(mid, b"vid-1080p-bytes", "video/mp4", resolution="1080p")

    # Fetch 720p via API
    resp720 = client.get(f"/api/media/{mid}/file?resolution=720p&download=true")
    assert resp720.status_code == 200
    assert resp720.content == b"vid-720p-bytes"
    assert f'filename="{mid}_720p.mp4"' in resp720.headers.get("content-disposition", "")

    # Fetch 1080p via API
    resp1080 = client.get(f"/api/media/{mid}/file?resolution=1080p&download=true")
    assert resp1080.status_code == 200
    assert resp1080.content == b"vid-1080p-bytes"
    assert f'filename="{mid}_1080p.mp4"' in resp1080.headers.get("content-disposition", "")

    # Fetch default (falls back to 1080p since it is highest quality)
    resp_def = client.get(f"/api/media/{mid}/file")
    assert resp_def.status_code == 200
    assert resp_def.content == b"vid-1080p-bytes"

    # Trigger manual upscale endpoint
    with patch.object(core.jobs, "create", return_value={"id": "job-manual-up", "status": "queued"}):
        resp_up = client.post(f"/api/media/{mid}/upscale")
        assert resp_up.status_code == 200
        data = resp_up.json()
        assert data["status"] == "queued"
        assert data["id"] == "job-manual-up"

    # Fetch 1080p when it does not exist yet (should return 404, not fallback to 720p remote url)
    mid_no_1080 = "api-test-no-1080"
    core.media.upsert({
        "id": mid_no_1080,
        "kind": "video",
        "mime": "video/mp4",
        "project_id": "proj-1",
        "url": "https://example.com/720p.mp4",
    })
    resp_not_ready = client.get(f"/api/media/{mid_no_1080}/file?resolution=1080p")
    assert resp_not_ready.status_code == 404


def test_export_project_media_resolution(tmp_path):
    import io
    import zipfile

    cfg = make_config(tmp_path / "data")
    app = flowhub.main.create_app(cfg)
    client = TestClient(app)
    core = app.state.core

    pub_id = "test-export-proj"
    board_id = core.db.insert("canvas_boards", {
        "name": "Test Export Project",
        "public_id": pub_id,
        "project_id": "default",
        "created_at": 1000,
    })

    # Create video node in board
    core.db.insert("canvas_nodes", {
        "board_id": board_id,
        "type": "video",
        "short_id": "v1",
        "status": "done",
        "data": json.dumps({"title": "Intro Scene", "mediaId": "vid-proj-1"}),
    })

    # Upsert video and image media
    core.media.upsert({
        "id": "vid-proj-1",
        "kind": "video",
        "mime": "video/mp4",
        "workspace_id": pub_id,
    })
    core.media.upsert({
        "id": "img-proj-1",
        "kind": "image",
        "mime": "image/png",
        "workspace_id": pub_id,
    })

    # Save files to project directory
    core.media.save_bytes("vid-proj-1", b"fake-720p-video", "video/mp4", workspace_id=pub_id, resolution="720p")
    core.media.save_bytes("vid-proj-1", b"fake-1080p-video", "video/mp4", workspace_id=pub_id, resolution="1080p")
    core.media.save_bytes("img-proj-1", b"fake-png-image", "image/png", workspace_id=pub_id)

    # 1. Export 720p
    resp_720 = client.get(f"/api/projects/{pub_id}/media.zip?resolution=720p")
    assert resp_720.status_code == 200
    assert "test-export-proj-media-720p.zip" in resp_720.headers.get("content-disposition", "")
    with zipfile.ZipFile(io.BytesIO(resp_720.content)) as zf:
        names = zf.namelist()
        # Should include image and 720p video
        assert any("720p" in n for n in names)
        assert not any("1080p" in n for n in names)
        assert any(n.endswith(".png") for n in names)

    # 2. Export 1080p
    resp_1080 = client.get(f"/api/projects/{pub_id}/media.zip?resolution=1080p")
    assert resp_1080.status_code == 200
    assert "test-export-proj-media-1080p.zip" in resp_1080.headers.get("content-disposition", "")
    with zipfile.ZipFile(io.BytesIO(resp_1080.content)) as zf:
        names = zf.namelist()
        # Should include image and 1080p video, not 720p
        assert any("1080p" in n for n in names)
        assert not any("720p" in n for n in names)
        assert any(n.endswith(".png") for n in names)

    # 3. Export all
    resp_all = client.get(f"/api/projects/{pub_id}/media.zip")
    assert resp_all.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp_all.content)) as zf:
        names = zf.namelist()
        assert any("720p" in n for n in names)
        assert any("1080p" in n for n in names)
        assert any(n.endswith(".png") for n in names)
