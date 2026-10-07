"""Contract tests: Flow Hub's builders must reproduce, byte for byte, the
requests Flow's own UI sent (tests/fixtures/observed_requests.json, captured
with the extension's Observation on 2026-10-07)."""
import json
from pathlib import Path

import pytest

from flowhub.protocol import batch as fb
from flowhub.protocol import observe as ob

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "observed_requests.json").read_text(encoding="utf-8"))


def uuids_in_order(node, out=None):
    out = [] if out is None else out
    if isinstance(node, str) and ob.UUID_UPPER.match(node):
        out.append(node)
    elif isinstance(node, list):
        for v in node:
            uuids_in_order(v, out)
    return out


def case_id(case):
    uses = ob.model_uses(case["rpcid"], case["inner"])
    extra = f"x{len(uses)}" if case["rpcid"] == "ogiZ0b" else uses[0]["aspect"]
    return f"{case['rpcid']}-{uses[0]['key']}-{extra}"


@pytest.mark.parametrize("case", FIXTURES, ids=case_id)
def test_builder_reproduces_observed_request_exactly(case):
    """Same inputs + the page's own client uuids → the identical body."""
    queue = uuids_in_order(case["inner"])
    fb.set_uuid_factory(lambda: queue.pop(0))
    try:
        built = ob.rebuild(case["rpcid"], case["inner"])
    finally:
        fb.reset_uuid_factory()
    assert queue == [], "every client uuid of the page consumed in the same order"
    assert fb.decode_envelope(built)[0][1] == case["inner"]
    assert fb.dumps(fb.decode_envelope(built)[0][1]) == fb.dumps(case["inner"])


@pytest.mark.parametrize("case", FIXTURES[:3])
def test_builder_check_reports_match(case):
    result = ob.builder_check(case["rpcid"], case["inner"])
    assert result["supported"] and result["ok"], result.get("diffs")


def test_builder_check_reports_drift():
    case = json.loads(json.dumps(FIXTURES[0]))
    case["inner"][2][1] = 1          # pretend Flow changed the trailing [uuid, 2]
    result = ob.builder_check(case["rpcid"], case["inner"])
    assert result["ok"] is False and result["diffs"][0]["path"] == "[2][1]"


def test_model_uses_and_summary():
    t2v = next(c for c in FIXTURES if c["rpcid"] == "YhhmEf" and c["inner"][0][0][1].endswith("_portrait"))
    assert ob.model_uses("YhhmEf", t2v["inner"]) == [
        {"mode": "t2v", "key": "veo_3_1_t2v_fast_portrait", "aspect": "portrait"}]
    img = next(c for c in FIXTURES if c["rpcid"] == "ogiZ0b")
    assert ob.model_uses("ogiZ0b", img["inner"]) == [{"mode": "image", "key": "BELUGA", "aspect": None}]
    summary = ob.summarize([{"rpcid": "ogiZ0b", "inner": img["inner"]}])
    assert summary["keys"] == ["BELUGA"] and summary["prompt"] == "ảnh pháo hóa đẹp tại nhật bản"


def test_template_round_trip():
    case = next(c for c in FIXTURES if c["rpcid"] == "ogiZ0b")
    template, variables = ob.templatize(case["inner"])
    assert set(variables) == {"prompt", "project_id", "seed"}
    rendered = ob.render_template(template, {"prompt": "một con mèo", "project_id": "P", "seed": 42})
    item = rendered[1][0]
    assert item[8] == [[["một con mèo"]]] and item[3] == 42 and item[7][5] == "P"
    assert item[7][10] == [fb.CAPTCHA_SLOT, 1]
    assert ob.UUID_UPPER.match(item[12]) and item[12] != case["inner"][1][0][12]


def test_parsers():
    env = lambda rpcid, payload: ")]}'\n\n99\n" + fb.dumps([["wrb.fr", rpcid, fb.dumps(payload), None, None, None, "generic"]])
    err = ")]}'\n\n192\n" + fb.dumps([["wrb.fr", "YhhmEf", None, None, None,
                                        [7, None, [["type.googleapis.com/google.rpc.ErrorInfo", ["PUBLIC_ERROR_UNUSUAL_ACTIVITY"]]]], "generic"]])
    with pytest.raises(fb.RpcError, match="PUBLIC_ERROR_UNUSUAL_ACTIVITY.*code 7"):
        fb.first_payload(err, "YhhmEf")
    ops = fb.read_operations(fb.first_payload(env("jwpduf", [None, 50, [["A", "P", "S", "CAE"], ["B", "P", "S", None]]]), "jwpduf"))
    assert [(o.operation_id, o.done) for o in ops] == [("A", True), ("B", False)]
    sub = fb.read_video_submit([None, 50, [["OP", "P", "S", None]]])
    assert sub["operation_id"] == "OP" and sub["media_id"] is None
    assert fb.read_media_urls([["https://flow-content.google/image/M?p", "https://flow-content.google/video/M?v"]]) == \
        ("https://flow-content.google/video/M?v", "https://flow-content.google/image/M?p")


def test_lost_image_found_by_client_id():
    """The workflow record of a real ogiZ0b answer (2026-10-07) carries the request's
    client uuid right after the media id; a listing window ending there is enough."""
    freq = fb.image_request(["x", "y"], "P", 3, "BELUGA", [1, 2])
    inner = fb.decode_envelope(freq)[0][1]
    client_ids = fb.image_client_ids(freq)
    assert client_ids == [inner[4][0], inner[1][0][12], inner[1][0][13], inner[1][1][12], inner[1][1][13]]
    seen = ('[[\\"609d9270-dbfa-420a-8bdf-2f6686941955\\",null,null,[\\"Character posing for studio port…\\",'
            '[1791341692,182642000],null,null,\\"4bc6f909-e3e2-4526-a6e2-b9d4d68a2d4a\\",'
            '\\"DA60BB96-F611-495D-9BB6-0176A9FAAD74\\",[1791341714,')
    assert fb.find_media_ids_before(seen, ["X", "DA60BB96-F611-495D-9BB6-0176A9FAAD74"]) == [
        "4bc6f909-e3e2-4526-a6e2-b9d4d68a2d4a"]
    assert fb.find_media_ids_before(seen, client_ids) == []


def test_image_variants_and_character_shape():
    """Two variants are two items of one call; a Character adds `[id, [0]]` to the trailing ids."""
    inner = fb.decode_envelope(fb.image_request(["a", "b"], "P", 2, "GEM_PIX_2", [5, 6], character_id="c-1"))[0][1]
    assert [it[8] for it in inner[1]] == [[[["a"]]], [[["b"]]]] and [it[3] for it in inner[1]] == [5, 6]
    assert inner[4][1:] == [None, ["c-1", [0]]]
    char = next(c for c in FIXTURES if c["rpcid"] == "ogiZ0b" and len(c["inner"][4]) > 1)
    assert ob.builder_check("ogiZ0b", char["inner"])["ok"]
    with pytest.raises(ValueError, match="one seed per prompt"):
        fb.image_request(["a", "b"], "P", 2, "GEM_PIX_2", 5)


def test_center_crop_matches_the_ui():
    """A 16:9 image under a 9:16 video: the crop Flow's UI sent (nprQif, 2026-10-07)."""
    assert fb.center_crop("16:9", fb.VIDEO_PORTRAIT) == [None, 0.341796875, 1, 0.658203125]
    assert fb.center_crop("9:16", fb.VIDEO_LANDSCAPE) == [0.341796875, None, 0.658203125, 1]
    assert fb.center_crop("1920:1080", fb.VIDEO_LANDSCAPE) == fb.FULL_FRAME_CROP
    assert fb.center_crop(None, fb.VIDEO_PORTRAIT) == fb.FULL_FRAME_CROP
    observed = [c for c in FIXTURES if c["rpcid"] == "nprQif"]
    crops = [frame[5] for c in observed for frame in c["inner"][0][0][4:6]]
    assert [None, 0.341796875, 1, 0.658203125] in crops


def test_recaptcha_action_from_protobuf():
    def varint(n):
        out = bytearray()
        while True:
            b = n & 0x7F
            n >>= 7
            out.append(b | (0x80 if n else 0))
            if not n:
                return bytes(out)
    field = lambda num, s: varint(num * 8 + 2) + varint(len(s)) + s
    body = field(1, b"guXhH0v") + field(2, b"03AF" + b"x" * 300) + field(14, b"VIDEO_GENERATION") + field(15, b"6LdsFiUs")
    import base64
    strings = ob.recaptcha_strings(base64.b64encode(body).decode())
    assert "VIDEO_GENERATION" in strings and ob.action_candidates(strings) == ["VIDEO_GENERATION"]
