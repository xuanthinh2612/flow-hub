"""End-to-end checks for `POST /api/boards/import-project`.

The fixture below is the sample file from the feature request, verbatim — it is
the contract the importer has to satisfy.
"""
import base64
import json

import pytest
from fastapi.testclient import TestClient

import flowhub.main
from flowhub.config import Config

SAMPLE_PROJECT = {
    "format": "flow-hub-canvas-project",
    "format_version": 1,
    "project": {"name": "Video ca nhạc 1"},
    "nodes": [
        {
            "id": "node-001",
            "type": "character",
            "prompt": "Cô gái nhật bản xinh đẹp",
            "generation": {
                "backend": "flow",
                "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE",
                "model": {"family": "image", "id": "BELUGA"},
                "resolution": None,
                "duration_s": None,
                "operation": "gen_image",
            },
            "properties": {
                "charCountry": "jp",
                "charVibe": "douyin",
                "charGender": "female",
                "charExtras": "tóc ngắn ngang vai",
            },
        },
        {
            "id": "node-002",
            "type": "video",
            "prompt": (
                "Cô gái đi dạo chơi ở công viên. Camera: locked-off static frame, no zoom and no pan. "
                "Keep the full subject and any product clearly visible in the frame for the entire clip. "
                "Background and crop must not change.. Camera: locked-off static frame, no zoom and no pan. "
                "Keep the full subject and any product clearly visible in the frame for the entire clip. "
                "Background and crop must not change."
            ),
            "generation": {
                "backend": "flow",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "model": {"family": "veo", "quality": "lite", "id": "veo_3_1_i2v_lite"},
                "resolution": None,
                "duration_s": None,
                "camera": "static",
                "operation": "gen_video",
                "video_mode": "i2v",
            },
            "properties": {"charVibe": "clean"},
        },
        {
            "id": "node-003",
            "type": "character",
            "prompt": "Studio portrait headshot of a person character, consistent character reference",
            "generation": {
                "backend": "flow",
                "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE",
                "model": {"family": "image", "id": "BELUGA"},
                "resolution": None,
                "duration_s": None,
                "operation": "gen_image",
            },
            "properties": {
                "charCountry": "vn",
                "charVibe": "clean",
                "charGender": "female",
                "charExtras": "tóc dài",
            },
        },
        {
            "id": "node-004",
            "type": "video",
            "prompt": "Cô gái gặp một con hổ.",
            "generation": {
                "backend": "flow",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "model": {"family": "omni_flash", "id": "abra_r2v_6s"},
                "resolution": "720p",
                "duration_s": 6,
                "camera": "static",
                "operation": "gen_video_omni",
                "video_mode": "i2v",
            },
            "properties": {"charVibe": "clean"},
        },
        {
            "id": "node-005",
            "type": "video",
            "prompt": "tô cái hóa thành một con sư tử",
            "generation": {
                "backend": "flow",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "model": {"family": "veo", "quality": "lite", "id": "veo_3_1_i2v_lite"},
                "resolution": None,
                "duration_s": None,
                "camera": "dynamic",
                "video_mode": "i2v",
            },
            "properties": {"charVibe": "clean"},
        },
        {
            "id": "node-006",
            "type": "character",
            "prompt": "Studio portrait headshot of a person character, consistent character reference",
            "generation": {
                "backend": "flow",
                "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE",
                "model": {"family": "image", "id": "NANO_BANANA_2"},
                "resolution": None,
                "duration_s": None,
            },
            "properties": {
                "charCountry": "jp",
                "charVibe": "douyin",
                "charGender": "female",
            },
        },
    ],
    "edges": [
        {"source": "node-001", "target": "node-002", "relation": "canvas"},
        {"source": "node-002", "target": "node-004", "relation": "canvas"},
        {"source": "node-004", "target": "node-005", "relation": "canvas"},
        {"source": "node-006", "target": "node-005", "relation": "canvas"},
    ],
}


@pytest.fixture()
def client(tmp_path):
    config = Config(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path / "import-data",
        worker_token="test-token",
        api_key="test-key",
        auth="off",
    )
    app = flowhub.main.create_app(config)
    with TestClient(app) as test_client:
        yield test_client
    app.state.core.db._conn.close()


def _import(client, payload):
    return client.post("/api/boards/import-project", json=payload)


def _detail(client, board_id):
    return client.get(f"/api/boards/{board_id}").json()


def test_import_rebuilds_the_whole_project(client):
    response = _import(client, SAMPLE_PROJECT)
    assert response.status_code == 201, response.text
    body = response.json()

    # The name comes from project.name, not from the file name.
    assert body["board"]["name"] == "Video ca nhạc 1"
    assert body["imported"] == {"nodes": 6, "edges": 4}

    detail = _detail(client, body["board"]["id"])
    assert detail["board"]["name"] == "Video ca nhạc 1"
    assert len(detail["nodes"]) == 6
    assert len(detail["edges"]) == 4

    by_short_id = {node["short_id"]: node for node in detail["nodes"]}
    assert set(by_short_id) == {f"node-{i:03d}" for i in range(1, 7)}
    assert {node["type"] for node in detail["nodes"]} == {"character", "video"}

    # Prompts survive byte for byte, including the repeated camera block.
    assert by_short_id["node-002"]["data"]["generation"]["prompt"] == SAMPLE_PROJECT["nodes"][1]["prompt"]
    assert by_short_id["node-005"]["data"]["generation"]["prompt"] == "tô cái hóa thành một con sư tử"

    # Generation settings are projected onto the runtime's camelCase keys.
    first = by_short_id["node-001"]["data"]["generation"]
    assert first["backend"] == "flow"
    assert first["aspectRatio"] == "IMAGE_ASPECT_RATIO_SQUARE"
    assert first["model"] == {"family": "image", "id": "BELUGA"}
    assert first["operation"] == "gen_image"
    assert "aspect_ratio" not in first

    # null is not the same as missing: node-001 has resolution: null, node-005
    # has no operation key at all, node-006 has resolution: null but no camera.
    assert "resolution" in by_short_id["node-001"]["data"]["generation"]
    assert by_short_id["node-001"]["data"]["generation"]["resolution"] is None
    assert "resolution" in by_short_id["node-006"]["data"]["generation"]
    assert by_short_id["node-006"]["data"]["generation"]["resolution"] is None
    assert "operation" not in by_short_id["node-006"]["data"]["generation"]

    # node-004 is the only node with real Omni settings.
    fourth = by_short_id["node-004"]["data"]["generation"]
    assert fourth["model"] == {"family": "omni_flash", "id": "abra_r2v_6s"}
    assert fourth["resolution"] == "720p"
    assert fourth["duration"] == 6
    assert fourth["operation"] == "gen_video_omni"
    assert fourth["videoMode"] == "i2v"
    assert fourth["camera"] == "static"

    # node-005 has no operation key at all — it must not be invented.
    assert "operation" not in by_short_id["node-005"]["data"]["generation"]

    # Properties are restored both as the file's own grouping and as the
    # character keys the generation dialog reads.
    assert by_short_id["node-001"]["data"]["properties"] == SAMPLE_PROJECT["nodes"][0]["properties"]
    assert by_short_id["node-001"]["data"]["generation"]["charCountry"] == "jp"
    assert by_short_id["node-001"]["data"]["generation"]["charExtras"] == "tóc ngắn ngang vai"
    assert by_short_id["node-006"]["data"]["generation"]["charCountry"] == "jp"
    assert "charExtras" not in by_short_id["node-006"]["data"]["generation"]

    # The original node payload is preserved verbatim, unknown fields included.
    assert by_short_id["node-001"]["data"]["importSource"]["id"] == "node-001"
    assert by_short_id["node-001"]["data"]["importSource"]["node"] == SAMPLE_PROJECT["nodes"][0]

    # Edges are recreated and rewired to the new row ids, in file order.
    edges = detail["edges"]
    assert [(e["source_id"], e["target_id"]) for e in edges] == [
        (by_short_id["node-001"]["id"], by_short_id["node-002"]["id"]),
        (by_short_id["node-002"]["id"], by_short_id["node-004"]["id"]),
        (by_short_id["node-004"]["id"], by_short_id["node-005"]["id"]),
        (by_short_id["node-006"]["id"], by_short_id["node-005"]["id"]),
    ]
    assert all(e["board_id"] == body["board"]["id"] for e in edges)

    # No generation was run: every node comes back idle and media-less.
    assert all(node["status"] == "idle" for node in detail["nodes"])
    assert all("mediaId" not in node["data"] for node in detail["nodes"])
    boards = client.get("/api/boards").json()
    assert boards[0]["video_count"] == 0
    assert boards[0]["image_count"] == 0


def test_imported_project_survives_a_reload(client):
    board = _import(client, SAMPLE_PROJECT).json()["board"]
    detail = _detail(client, board["id"])
    assert len(detail["nodes"]) == 6
    assert len(detail["edges"]) == 4
    assert detail["nodes"][0]["data"]["generation"]["prompt"] == SAMPLE_PROJECT["nodes"][0]["prompt"]


def test_import_lays_the_canvas_out_without_overlap(client):
    board = _import(client, SAMPLE_PROJECT).json()["board"]
    nodes = _detail(client, board["id"])["nodes"]

    # The file carries no coordinates, so the importer places the cards itself.
    assert all(node["x"] > 0 and node["y"] > 0 for node in nodes)

    boxes = [(node["x"], node["y"]) for node in nodes]
    assert len(set(boxes)) == len(boxes), "two nodes share the same origin"

    # Nodes at the same graph depth share a row and spread horizontally.
    # Dependency depth advances downward, so this chain advances top to bottom.
    by_short_id = {node["short_id"]: node for node in nodes}
    assert by_short_id["node-001"]["y"] < by_short_id["node-002"]["y"] < by_short_id["node-004"]["y"]
    assert by_short_id["node-004"]["y"] < by_short_id["node-005"]["y"]
    assert by_short_id["node-006"]["y"] == by_short_id["node-001"]["y"]
    assert by_short_id["node-006"]["x"] != by_short_id["node-001"]["x"]


def test_import_keeps_existing_projects_working(client):
    existing = client.post("/api/boards", json={"name": "Project cũ"}).json()
    node = client.post("/api/nodes", json={
        "board_id": existing["id"], "type": "image", "x": 10, "y": 20,
        "data": {"title": "Gốc"},
    }).json()

    imported = _import(client, SAMPLE_PROJECT).json()["board"]

    boards = client.get("/api/boards").json()
    assert {board["name"] for board in boards} == {"Project cũ", "Video ca nhạc 1"}

    detail = _detail(client, existing["id"])
    assert [item["data"]["title"] for item in detail["nodes"]] == ["Gốc"]
    assert detail["nodes"][0]["id"] == node["id"]

    # The imported board is a separate project with its own nodes.
    assert imported["id"] != existing["id"]
    assert len(_detail(client, imported["id"])["nodes"]) == 6


@pytest.mark.parametrize("mutate, expected", [
    (lambda doc: doc.update(format="other"), "format"),
    (lambda doc: doc.update(format_version=2), "format_version"),
    (lambda doc: doc["project"].update(name="  "), "project.name"),
    (lambda doc: doc.update(project={}), "project"),
    (lambda doc: doc.update(nodes={}), "nodes"),
    (lambda doc: doc.update(edges={}), "edges"),
    (lambda doc: doc["nodes"][1].update(id="node-001"), "trùng"),
    (lambda doc: doc["nodes"][0].pop("id"), "id"),
    (lambda doc: doc["nodes"][0].update(type="hologram"), "type"),
    (lambda doc: doc["nodes"][0].update(generation="flow"), "generation"),
    (lambda doc: doc["nodes"][0].update(properties="jp"), "properties"),
    (lambda doc: doc["edges"][0].update(source="node-999"), "không có node"),
    (lambda doc: doc["edges"][0].update(target="node-999"), "không có node"),
    (lambda doc: doc["edges"][0].pop("source"), "source"),
    (lambda doc: doc["edges"][0].update(relation=7), "relation"),
    (lambda doc: doc["nodes"][0].update(x="10"), "x"),
    (lambda doc: doc["nodes"][0].update(assets=[{"name": "a.png"}]), "data_base64"),
    (lambda doc: doc["nodes"][0].update(assets=[{"data_base64": "!!!"}]), "base64"),
])
def test_invalid_files_are_rejected_without_writing_anything(client, mutate, expected):
    doc = json.loads(json.dumps(SAMPLE_PROJECT))
    mutate(doc)

    response = _import(client, doc)

    assert response.status_code == 400, response.text
    assert expected in response.json()["detail"]
    # Nothing was created — no half-imported project.
    assert client.get("/api/boards").json() == []


def test_non_object_json_is_rejected(client):
    assert _import(client, [1, 2, 3]).status_code == 400
    assert _import(client, "nope").status_code == 400
    assert client.get("/api/boards").json() == []


def test_import_rolls_back_when_a_later_node_is_invalid(client):
    doc = json.loads(json.dumps(SAMPLE_PROJECT))
    doc["nodes"][4]["type"] = "not-a-node"

    response = _import(client, doc)

    assert response.status_code == 400
    assert client.get("/api/boards").json() == []


# 1x1 PNG, enough to prove the bytes really reach disk.
PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)


def _asset_project(media_id):
    doc = json.loads(json.dumps(SAMPLE_PROJECT))
    doc["nodes"] = [{
        "id": "asset-1",
        "type": "visual_asset",
        "assets": [{
            "media_id": media_id,
            "name": "reference.png",
            "mime_type": "image/png",
            "data_base64": PNG_BASE64,
        }],
    }]
    doc["edges"] = []
    return doc


def test_import_restores_reference_assets(client):
    board = _import(client, _asset_project("ref-1")).json()["board"]
    nodes = _detail(client, board["id"])["nodes"]

    assert len(nodes) == 1
    node = nodes[0]
    assert node["type"] == "visual_asset"
    assert node["status"] == "done"
    assert node["data"]["mediaId"] == "ref-1"
    assert node["data"]["mediaIds"] == ["ref-1"]

    # The bytes really landed on disk and are served back.
    media = client.get("/api/media").json()
    assert [item["id"] for item in media] == ["ref-1"]
    assert media[0]["workspace_id"] == board["public_id"]
    assert client.get("/api/media/ref-1/file").content == base64.b64decode(PNG_BASE64)


def test_import_reuses_the_file_media_id_only_when_it_is_free(client):
    # Occupy the id directly in the media store.
    client.app.state.core.media.upsert({"id": "ref-1", "kind": "image", "source": "manual"})

    board = _import(client, _asset_project("ref-1")).json()["board"]
    node = _detail(client, board["id"])["nodes"][0]

    assert node["data"]["mediaId"] != "ref-1"
    assert node["data"]["mediaId"].startswith("import-")
