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

