import re
from fastapi.testclient import TestClient
import flowhub.main
from flowhub.config import Config


def test_react_frontend_served(tmp_path):
    config = Config(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path / "data",
        worker_token="test-token",
        api_key="test-key",
        auth="off",
    )
    app = flowhub.main.create_app(config)
    client = TestClient(app)

    # 1. Root serves index.html
    res = client.get("/")
    assert res.status_code == 200
    assert 'id="root"' in res.text

    # 2. Extract and verify bundled JS and CSS assets
    js_match = re.search(r'src="(/assets/[^"]+)"', res.text)
    css_match = re.search(r'href="(/assets/[^"]+)"', res.text)
    assert js_match is not None, "JS asset bundle must be linked in index.html"
    assert css_match is not None, "CSS asset bundle must be linked in index.html"

    js_url = js_match.group(1)
    css_url = css_match.group(1)

    res_js = client.get(js_url)
    assert res_js.status_code == 200
    assert len(res_js.content) > 1000

    res_css = client.get(css_url)
    assert res_css.status_code == 200
    assert len(res_css.content) > 1000

    # 3. Verify API endpoints still respond normally
    res_overview = client.get("/api/overview")
    assert res_overview.status_code == 200
    data = res_overview.json()
    assert "workers" in data
    assert "job_counts" in data


def test_canvas_sqlite_crud_and_node_patch(tmp_path):
    config = Config(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path / "canvas-data",
        worker_token="test-token",
        api_key="test-key",
        auth="off",
    )
    app = flowhub.main.create_app(config)
    client = TestClient(app)
    try:
        board = client.post("/api/boards", json={"name": "Canvas"}).json()
        source = client.post("/api/nodes", json={
            "board_id": board["id"], "type": "image", "x": 10, "y": 20,
            "data": {"title": "Source"},
        }).json()
        target = client.post("/api/nodes", json={
            "board_id": board["id"], "type": "video", "x": 30, "y": 40,
            "data": {"title": "Target"},
        }).json()

        patched = client.patch(f"/api/nodes/{source['id']}", json={
            "status": "done", "data": {"mediaId": "MEDIA-1"},
        })
        assert patched.status_code == 200
        assert patched.json()["data"]["mediaId"] == "MEDIA-1"

        edge = client.post("/api/edges", json={
            "board_id": board["id"], "source_id": source["id"], "target_id": target["id"],
        })
        assert edge.status_code == 201
        detail = client.get(f"/api/boards/{board['id']}").json()
        assert detail["nodes"][0]["data"]["mediaId"] == "MEDIA-1"
        assert len(detail["edges"]) == 1
    finally:
        app.state.core.db._conn.close()

