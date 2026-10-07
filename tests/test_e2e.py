"""End-to-end: a real uvicorn server, a fake worker on the WebSocket playing the
part of the extension + Flow, and every job type driven through the REST API."""
from __future__ import annotations

import asyncio
import base64
import json
import socket
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
import websockets

from flowhub.config import Config
from flowhub.main import create_app
from flowhub.protocol import batch as fb

PID = "522d685e-5674-47ae-9d12-b533589db643"
KEY = "test-key"
TOKEN = "test-token"
FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "observed_requests.json").read_text(encoding="utf-8"))
TINY_JPEG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 200).decode()


def env(rpcid, payload):
    chunk = fb.dumps([["wrb.fr", rpcid, fb.dumps(payload), None, None, None, "generic"]])
    return f")]}}'\n\n{len(chunk)}\n{chunk}"


def err_env(rpcid, code=5):
    return ")]}'\n\n40\n" + fb.dumps([["wrb.fr", rpcid, None, None, None, [code], "generic"]])


class FakeFlow:
    """Answers RPCs the way Flow does (shapes from tests/fixtures + observed traffic)."""

    def __init__(self):
        self.calls = []
        self.ops = {}
        self.n = 0
        self.lose_next = None    # "sent" / "unsent": the tab reloads under the next ogiZ0b
        self.lost_images = {}    # client uuid -> media id Flow rendered while the tab reloaded

    def answer(self, msg):
        rpcid, freq = msg["rpcid"], msg["freq"]
        inner = fb.decode_envelope(freq)[0][1]
        self.calls.append({**msg, "inner": inner})
        if rpcid == "ogiZ0b":
            self.n += 1
            if self.lose_next:
                lose, self.lose_next = self.lose_next, None
                if lose == "sent":   # Flow got it and renders it; only the answer is gone
                    self.lost_images[inner[4][0]] = f"{self.n:08d}-1111-2222-3333-555555555555"
                return {"error": "PAGE_UNLOADED: tab reloaded", "sent": lose == "sent"}
            return {"status": 200, "text": env(rpcid, [[f"https://flow-content.google/image/img-{self.n}?sig=1"]])}
        if rpcid in ("eb1hJf", "nprQif", "MZZa6b"):          # old shape: media id only via the listing
            self.n += 1
            op = f"OP-{self.n}"
            self.ops[op] = {"polls": 0, "media": f"{self.n:08d}-1111-2222-3333-444444444444", "as": 0}
            return {"status": 200, "text": env(rpcid, [None, 50, [[op, PID, "SCENE", None]]])}
        if rpcid == "YhhmEf":                                 # page style: one id for jwpduf and as29s
            self.n += 1
            op = f"{self.n:08d}-abf3-470d-cb09-44a1bc73aaaa"
            self.ops[op] = {"polls": 0, "media": op, "as": 0}
            return {"status": 200, "text": env(rpcid, [None, 50, [[op, PID, "SCENE", None]]])}
        if rpcid == "jwpduf":
            records = []
            for (op_id,) in inner[2]:
                o = self.ops[op_id]
                o["polls"] += 1
                records.append([op_id, PID, "SCENE", "CAE" if o["polls"] >= 2 else None])
            return {"status": 200, "text": env(rpcid, [None, 50, records])}
        if rpcid == "Zzl0ze":
            lost = self.lost_images.get(msg.get("match"))
            if lost:   # the window starts ahead of the match, where the media id sits
                return {"status": 200, "matched": True,
                        "text": f'[\\"WF\\",null,null,[\\"t\\",[1,2],null,null,\\"{lost}\\",\\"{msg["match"]}\\",[1,3]]'}
            o = self.ops.get(msg.get("match"))
            if o and o["polls"] >= 2:
                return {"status": 200, "matched": True,
                        "text": f'["{msg["match"]}",null,null,["t",1,null,null,"{o["media"]}","c",true],"{PID}"]'}
            return {"status": 200, "matched": False, "text": ""}
        if rpcid == "as29s":
            mid = inner[0]
            if mid.startswith("UPL") or mid in self.lost_images.values():
                return {"status": 200, "text": env(rpcid, [[f"https://flow-content.google/image/{mid}?u"]])}
            o = next((x for x in self.ops.values() if x["media"] == mid), None)
            if o is None:
                return {"status": 200, "text": err_env(rpcid)}
            o["as"] += 1
            urls = [f"https://flow-content.google/image/{mid}?poster"]
            if o["as"] >= 2:
                urls.append(f"https://flow-content.google/video/{mid}?clip")
            return {"status": 200, "text": env(rpcid, [urls])}
        if rpcid == "maseQ":
            return {"status": 200, "text": env(rpcid, [["UPL-1", PID, "op", "CAE"]])}
        if rpcid == "SPrCad":
            return {"status": 200, "text": env(rpcid, [None, TINY_JPEG])}
        return {"status": 200, "text": err_env(rpcid)}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    port = free_port()
    config = Config(host="127.0.0.1", port=port, data_dir=tmp_path_factory.mktemp("data"), worker_token=TOKEN,
                    api_key=KEY, auth="on")
    app = create_app(config)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)

    flow = FakeFlow()
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    sent_observe = []

    async def worker():
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws/worker?token={TOKEN}") as ws:
            await ws.send(json.dumps({"type": "hello", "worker_id": "w1", "label": "fake", "version": "test",
                                      "flow": {"tabs": 1, "projects": [{"projectId": PID}]}}))
            ready.set()

            async def observe_loop():
                while True:
                    msg = await asyncio.to_thread(lambda: sent_observe.pop(0) if sent_observe else None)
                    if msg:
                        await ws.send(json.dumps(msg))
                    else:
                        await asyncio.sleep(0.05)

            pump = asyncio.ensure_future(observe_loop())
            try:
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg["type"] == "rpc":
                        await ws.send(json.dumps({"type": "rpc_result", "id": msg["id"], **flow.answer(msg)}))
                    elif msg["type"] == "fetch":
                        await ws.send(json.dumps({"type": "fetch_result", "id": msg["id"], "b64": TINY_JPEG,
                                                  "mime": "image/jpeg"}))
            finally:
                pump.cancel()

    async def worker_until_closed():
        try:
            await worker()
        except websockets.ConnectionClosed:
            pass   # the server shutting down at the end of the module

    threading.Thread(target=lambda: loop.run_until_complete(worker_until_closed()), daemon=True).start()
    assert ready.wait(5)
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}", headers={"X-API-Key": KEY}, timeout=30)
    client.patch("/api/settings", json={"poll_interval_s": 0.1, "min_submit_gap_s": 0, "download_media": False})
    yield {"client": client, "flow": flow, "observe": sent_observe, "port": port}
    server.should_exit = True


def wait_job(client, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] not in ("queued", "running", "polling"):
            return job
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} still {job['status']}")


def test_auth_required(stack):
    port = stack["port"]
    assert httpx.get(f"http://127.0.0.1:{port}/api/jobs").status_code == 401
    assert httpx.get(f"http://127.0.0.1:{port}/api/health").status_code == 200
    workers = stack["client"].get("/api/workers").json()
    assert workers[0]["id"] == "w1" and workers[0]["online"]


def test_image_job_with_variants(stack):
    c, flow = stack["client"], stack["flow"]
    job = c.post("/api/jobs", json={"type": "image", "prompt": "một con cáo", "aspect": "9:16", "count": 2,
                                    "seed": 1000, "ref_media_ids": ["REF-1"]}).json()
    job = wait_job(c, job["id"])
    assert job["status"] == "done" and len(job["results"]) == 2
    calls = [x for x in flow.calls if x["rpcid"] == "ogiZ0b"][-2:]
    assert sorted(x["inner"][1][0][3] for x in calls) == [1000, 10973]
    assert all(x["inner"][1][0][5] == "BELUGA" and x["inner"][1][0][4] == 2 for x in calls)   # default family
    assert all(x["captcha_action"] == "IMAGE_GENERATION" and fb.CAPTCHA_SLOT in x["freq"] for x in calls)
    assert all(x["inner"][1][0][7][5] == PID for x in calls)                                      # worker's project
    assert len(job["rpc_log"]) == 2
    assert c.get(f"/api/media/{job['results'][0]['media_id']}").json()["source"] == "image"


def test_image_found_again_when_the_tab_reloads_mid_call(stack):
    """A reload under an in-flight ogiZ0b loses the answer, not the image: Flow
    renders it anyway and the hub finds it in the listing by its client uuid."""
    c, flow = stack["client"], stack["flow"]
    flow.lose_next = "sent"
    job = wait_job(c, c.post("/api/jobs", json={"type": "image", "prompt": "tab bị F5"}).json()["id"])
    assert job["status"] == "done", job["error"]
    media_id = job["results"][0]["media_id"]
    assert media_id in flow.lost_images.values() and job["results"][0]["url"].endswith(f"{media_id}?u")
    assert "PAGE_UNLOADED" in job["warnings"][0] and "đã lấy lại ảnh" in job["warnings"][0]

    before = len(flow.calls)
    flow.lose_next = "unsent"
    job = wait_job(c, c.post("/api/jobs", json={"type": "image", "prompt": "tab bị F5 sớm"}).json()["id"])
    assert job["status"] == "failed" and "Flow chưa nhận" in job["error"]
    assert "Zzl0ze" not in [x["rpcid"] for x in flow.calls[before:]], "nothing to look for: Flow never got it"


def test_t2v_page_style_without_listing(stack):
    c, flow = stack["client"], stack["flow"]
    before = len(flow.calls)
    job = wait_job(c, c.post("/api/jobs", json={"type": "t2v", "prompt": "cô gái nhảy", "aspect": "9:16"}).json()["id"])
    mine = flow.calls[before:]
    assert job["status"] == "done", job["error"]
    assert mine[0]["inner"][0][0][1] == "veo_3_1_t2v_fast_portrait" and mine[0]["inner"][2][1] == 2
    assert "Zzl0ze" not in [x["rpcid"] for x in mine]
    assert job["results"][0]["url"].endswith("?clip")


def test_omni_t2v_360p_and_i2v_listing_fallback(stack):
    c, flow = stack["client"], stack["flow"]
    job = wait_job(c, c.post("/api/jobs", json={"type": "t2v", "prompt": "lá đỏ", "family": "omni_flash",
                                                "duration": 8, "resolution": "360p"}).json()["id"])
    assert job["status"] == "done" and job["model"] == "abra_t2v_8s_360p"
    req = [x for x in flow.calls if x["rpcid"] == "YhhmEf"][-1]["inner"][0][0]
    assert req[5:] == [None, None, [4]]
    before = len(flow.calls)
    job = wait_job(c, c.post("/api/jobs", json={"type": "i2v", "prompt": "đi bộ",
                                                "start_media_ids": ["S1", "S2"]}).json()["id"])
    assert job["status"] == "done" and len(job["results"]) == 2
    assert "Zzl0ze" in [x["rpcid"] for x in flow.calls[before:]]
    jw = [x for x in flow.calls[before:] if x["rpcid"] == "jwpduf"][0]
    assert len(jw["inner"][2]) == 2, "pending operations polled in one jwpduf, like the page"


def test_upload_upscale_and_preview(stack):
    c = stack["client"]
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    job = c.post("/api/uploads", files={"file": ("a.png", png, "image/png")}).json()
    job = wait_job(c, job["id"])
    assert job["status"] == "done" and job["results"][0]["media_id"] == "UPL-1"
    assert c.get("/api/media/UPL-1/file").content == png
    log = c.get(f"/api/jobs/{job['id']}").json()["rpc_log"][0]
    assert "<base64:" in log["body"]
    job = wait_job(c, c.post("/api/jobs", json={"type": "upscale", "media_id": "UPL-1", "resolution": "4K"}).json()["id"])
    assert job["status"] == "done"
    assert c.get(f"/api/media/{job['results'][0]['media_id']}/file").content[:3] == b"\xff\xd8\xff"
    preview = c.post("/api/jobs/preview", json={"type": "t2v", "prompt": "x", "aspect": "16:9"}).json()
    assert preview[0]["rpcid"] == "YhhmEf" and preview[0]["inner"][0][0][1] == "veo_3_1_t2v_fast"


def test_observation_learns_and_templates(stack):
    c, flow = stack["client"], stack["flow"]
    case = json.loads(json.dumps(next(f for f in FIXTURES if f["rpcid"] == "YhhmEf")))
    case["inner"][0][0][1] = "veo_4_0_t2v_new"            # a model Flow just shipped
    token = "0cAFcWeA" + "x" * 1500
    case["inner"][1][10][0] = token
    freq = fb.build_envelope("YhhmEf", case["inner"])
    t = time.time() * 1000
    stack["observe"].append({"type": "observe", "entry": {
        "kind": "recaptcha", "url": "https://www.google.com/recaptcha/enterprise/reload?k=6Ld", "ts": t - 300,
        "tab_id": 7, "status": 200,
        "body_b64": base64.b64encode(b"\x72\x10VIDEO_GENERATION\x7a\x046Lds").decode()}})
    stack["observe"].append({"type": "observe", "entry": {
        "kind": "batchexecute", "ts": t, "tab_id": 7, "status": 200, "duration_ms": 6000, "freq": freq,
        "url": f"https://flow.google.com{fb.BATCH_PATH}?rpcids=YhhmEf&source-path=%2Fproject%2F{PID}&bl=boq_new_build&_reqid=1234567&rt=c",
        "form_keys": ["at", "f.req"], "headers": [{"name": "Cookie", "value": "a=1; b=2"}]}})
    deadline = time.time() + 5
    while time.time() < deadline:
        rows = c.get("/api/observations", params={"rpcid": "YhhmEf", "source": "page"}).json()
        if rows:
            break
        time.sleep(0.1)
    obs = c.get(f"/api/observations/{rows[0]['id']}").json()
    assert obs["headers"][0]["value"].startswith("‹2 cookie")
    assert obs["check_result"][0]["ok"] is True                # same body shape as the builder
    models = c.get("/api/models", params={"mode": "t2v"}).json()["rows"]
    assert any(r["key"] == "veo_4_0_t2v_new" and r["source"] == "observed" for r in models)
    titles = [a["title"] for a in c.get("/api/alerts").json()]
    assert "Model mới: veo_4_0_t2v_new" in titles
    assert c.get("/api/overview").json()["last_build"] == "boq_new_build"   # first build: remembered, no alert
    stack["observe"].append({"type": "observe", "entry": {
        "kind": "batchexecute", "ts": t + 1000, "tab_id": 7, "status": 200, "freq": fb.build_envelope("nzlxg", []),
        "url": f"https://flow.google.com{fb.BATCH_PATH}?rpcids=nzlxg&bl=boq_newer_build&_reqid=7654321&rt=c"}})
    deadline = time.time() + 5
    while time.time() < deadline and not any("đổi build" in a["title"] for a in c.get("/api/alerts").json()):
        time.sleep(0.1)
    assert any(a["title"] == "Flow đổi build: boq_newer_build" for a in c.get("/api/alerts").json())
    recaptcha = c.get("/api/observations", params={"kind": "recaptcha"}).json()[0]
    assert recaptcha["actions"] == ["VIDEO_GENERATION"]

    tpl = c.post(f"/api/observations/{obs['id']}/template", json={}).json()
    assert set(tpl["variables"]) == {"prompt", "project_id"} and tpl["result_kind"] == "video"
    assert tpl["captcha_action"] == "VIDEO_GENERATION"
    before = len(flow.calls)
    job = wait_job(c, c.post("/api/jobs", json={"type": "template", "template_id": tpl["id"],
                                                "prompt": "từ template"}).json()["id"])
    sent = flow.calls[before]
    assert job["status"] == "done", job["error"]
    assert sent["inner"][0][0][0][2] == [[["từ template"]]] and sent["inner"][0][0][1] == "veo_4_0_t2v_new"
    assert sent["inner"][1][10][0] == fb.CAPTCHA_SLOT and sent["inner"][1][5] == PID


def test_raw_rpc_and_validation(stack):
    c = stack["client"]
    out = c.post("/api/rpc", json={"rpcid": "as29s", "inner": ["UPL-1"]}).json()
    assert out["status"] == 200 and out["decoded"]["rpcs"][0]["rpcid"] == "as29s"
    assert c.post("/api/jobs", json={"type": "t2v"}).status_code == 400
    bad = c.post("/api/jobs", json={"type": "t2v", "prompt": "x", "family": "omni_flash", "duration": 12})
    assert bad.status_code == 400 and "không có biến thể" in bad.json()["detail"]
