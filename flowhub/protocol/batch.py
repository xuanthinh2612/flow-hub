"""Google Flow batchexecute codec: request builders and response readers.

Every Flow call goes to one endpoint, issued from inside a signed-in
flow.google.com tab (the cookie, the per-page ``at`` token and the single-use
reCAPTCHA only exist there):

    POST /_/AiSandboxAngularFrontend/data/batchexecute?rpcids=<rpcid>&...
    body: f.req=[[[rpcid, "<inner JSON>", null, "generic"]]]&at=<page token>

This module only builds ``f.req`` and reads responses; the browser extension
runs the request in the page. It is the one place in Flow Hub that knows the
wire format, so a Flow update means editing this file (or saving a template
from the Observation page) and nothing else.

Builders marked VERIFIED reproduce byte-for-byte requests captured from Flow's
own UI on 2026-10-07 (build boq_labs-ai-sandbox-frontend_20261005.07_p0); see
tests/test_protocol.py. The others come from older captures (eb1hJf, SPrCad,
maseQ past its first two slots).
"""
from __future__ import annotations

import json
import random
import re
import uuid
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Callable, Optional, Union

BATCH_PATH = "/_/AiSandboxAngularFrontend/data/batchexecute"
MEDIA_HOST = "flow-content.google"

RPC_GEN_IMAGE = "ogiZ0b"
RPC_GEN_VIDEO = "eb1hJf"            # image-to-video: Veo, Omni first frame
RPC_GEN_VIDEO_TEXT = "YhhmEf"       # text-to-video
RPC_GEN_VIDEO_FIRST_LAST = "nprQif"   # first + last frame: Omni, Veo Fast, Veo Lite
RPC_GEN_VIDEO_REFERENCES = "MZZa6b"  # ingredients: Omni, Veo Fast
RPC_OPERATION = "jwpduf"
RPC_PROJECT_MEDIA = "Zzl0ze"
RPC_MEDIA = "as29s"
RPC_UPLOAD_IMAGE = "maseQ"
RPC_UPSCALE_IMAGE = "SPrCad"

#: Human names for the RPCs we know. Anything else in the Observation log is
#: flagged as new, which is usually the first sign that Flow changed.
RPC_NAMES: dict[str, str] = {
    RPC_GEN_IMAGE: "Tạo / sửa ảnh",
    RPC_GEN_VIDEO: "Video từ ảnh (Veo / Omni)",
    RPC_GEN_VIDEO_TEXT: "Text → video",
    RPC_GEN_VIDEO_FIRST_LAST: "Video ảnh đầu + cuối",
    RPC_GEN_VIDEO_REFERENCES: "Video Ingredients",
    RPC_OPERATION: "Poll operation",
    RPC_PROJECT_MEDIA: "Danh sách media project",
    RPC_MEDIA: "URL media",
    RPC_UPLOAD_IMAGE: "Upload ảnh",
    RPC_UPSCALE_IMAGE: "Upscale ảnh",
    # Seen from Flow's UI on 2026-10-07; responses not captured, names guessed.
    "ngNC2": "Đọc project (sau mỗi jwpduf)",
    "nzlxg": "Không tham số (đoán: credits / trạng thái)",
    "WuwhI": "Telemetry (sự kiện UI)",
    "o30O0e": "Hồ sơ người dùng (People API)",
    "mrlkwd": "Đọc project (khi mở)",
    "C4BZMd": "Tạo Nhân vật (Character) trống",
    "rzMKMb": "Sửa Nhân vật (field mask, vd. personality_notes)",
    "eAenfb": "Trang Nhân vật: gợi ý theo chữ đang gõ (đoán)",
}

#: Read-only calls that Flow's page fires constantly.
POLL_RPCS = {RPC_OPERATION, RPC_PROJECT_MEDIA, RPC_MEDIA, "ngNC2", "nzlxg"}

CAPTCHA_IMAGE = "IMAGE_GENERATION"
CAPTCHA_VIDEO = "VIDEO_GENERATION"
CAPTCHA_UPLOAD = "UPLOAD_IMAGE"

#: Default reCAPTCHA action per RPC. The Observation page learns the action the
#: page itself mints right before each RPC and that learned value wins.
DEFAULT_CAPTCHA_ACTIONS: dict[str, str] = {
    RPC_GEN_IMAGE: CAPTCHA_IMAGE,
    RPC_UPLOAD_IMAGE: CAPTCHA_UPLOAD,   # seen 2026-10-07: one mint per uploaded file
    RPC_UPSCALE_IMAGE: CAPTCHA_IMAGE,   # UNVERIFIED: the context carries a captcha slot
    RPC_GEN_VIDEO: CAPTCHA_VIDEO,
    RPC_GEN_VIDEO_TEXT: CAPTCHA_VIDEO,
    RPC_GEN_VIDEO_FIRST_LAST: CAPTCHA_VIDEO,
    RPC_GEN_VIDEO_REFERENCES: CAPTCHA_VIDEO,
}

#: The extension swaps a freshly minted reCAPTCHA token in for this marker.
CAPTCHA_SLOT = "__CAPTCHA__"

SURFACE_ID = 22
STATUS_DONE = "CAE"
OUTCOME_COMPLAINT = 4

#: Frame crop box `[top, left, bottom, right]` (fractions, zero sent as null)
#: when the image already has the video's shape.
FULL_FRAME_CROP = [None, None, 1, 1]

REF_TYPE_IMAGE = 1    # a reference image
BASE_TYPE_IMAGE = 2   # the image being edited

#: Image aspect codes. 1 is square here, while for video 1 is portrait.
IMAGE_ASPECTS: dict[str, int] = {"1:1": 1, "9:16": 2, "16:9": 3, "3:4": 4, "4:3": 5}
VIDEO_PORTRAIT = 1
VIDEO_LANDSCAPE = 2
VIDEO_ASPECTS: dict[str, int] = {"9:16": VIDEO_PORTRAIT, "16:9": VIDEO_LANDSCAPE}

VIDEO_RATIOS: dict[int, Fraction] = {VIDEO_PORTRAIT: Fraction(9, 16), VIDEO_LANDSCAPE: Fraction(16, 9)}

IMAGE_UPSCALE_RESOLUTIONS = {"2K": 1, "4K": 2}


def center_crop(image_aspect: Optional[str], video_aspect: int) -> list:
    """The centred, video-shaped window over a frame image, as the UI computes it:
    a 16:9 image under a 9:16 video is `[null, 0.341796875, 1, 0.658203125]`.
    Full frame when the image's aspect ("16:9", …) is unknown or already fits."""
    try:
        w, h = (int(x) for x in str(image_aspect).split(":"))
        src = Fraction(w, h)
    except (TypeError, ValueError, ZeroDivisionError):
        return list(FULL_FRAME_CROP)
    dst = VIDEO_RATIOS.get(video_aspect)
    if dst is None or src == dst:
        return list(FULL_FRAME_CROP)
    if src > dst:   # wider than the video: trim the sides
        left = (1 - dst / src) / 2
        return [None, float(left), 1, float(1 - left)]
    top = (1 - src / dst) / 2
    return [float(top), None, float(1 - top), 1]


class FlowError(RuntimeError):
    """Something Flow (or the bridge to it) answered that is not a result."""


class RpcError(FlowError):
    """A batchexecute envelope came back with its error slot set."""

    def __init__(self, rpcid: str, detail: Any):
        self.rpcid = rpcid
        self.detail = detail
        super().__init__(f"{rpcid}: {describe_error(detail)}")


def describe_error(detail: Any) -> str:
    """`[7, null, [["type.googleapis.com/google.rpc.ErrorInfo", ["PUBLIC_ERROR_…"]]]]` → readable."""
    reasons = [s for s in _walk_strings(detail) if s.startswith("PUBLIC_ERROR") or s.isupper()]
    code = detail[0] if isinstance(detail, list) and detail and isinstance(detail[0], int) else None
    text = ", ".join(dict.fromkeys(reasons)) or json.dumps(detail, ensure_ascii=False)[:200]
    return f"{text} (code {code})" if code is not None else text


# ── envelope codec ───────────────────────────────────────────────────────────

def dumps(value: Any) -> str:
    """Compact JSON exactly as the page serialises it (and as JSON.stringify does)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def build_envelope(rpcid: str, inner: Any) -> str:
    return dumps([[[rpcid, dumps(inner), None, "generic"]]])


def decode_envelope(freq: str) -> list[tuple[str, Any]]:
    """`f.req` → [(rpcid, inner)]. One page call can batch several RPCs."""
    outer = json.loads(freq)
    return [(item[0], json.loads(item[1])) for item in outer[0]]


@dataclass(frozen=True)
class RpcResult:
    rpcid: str
    data: Any
    error: Any = None

    @property
    def ok(self) -> bool:
        return self.error is None


def parse_envelope(text: str) -> list[RpcResult]:
    """Unwrap the `)]}'` sentinel and the length-prefixed chunks.

    The chunk lengths can disagree with the payload by a byte or two once
    escapes are involved, so chunks are found by scanning, not by the prefix.
    """
    if not text:
        return []
    body = text.split("\n", 1)[1] if text.startswith(")]}'") else text
    decoder = json.JSONDecoder()
    results: list[RpcResult] = []
    index = 0
    while index < len(body):
        start = body.find("[", index)
        if start == -1:
            break
        try:
            chunk, end = decoder.raw_decode(body, start)
        except json.JSONDecodeError:
            index = start + 1
            continue
        index = end
        for entry in chunk if isinstance(chunk, list) else []:
            if not isinstance(entry, list) or not entry or entry[0] != "wrb.fr":
                continue
            rpcid = entry[1] if len(entry) > 1 else "?"
            payload = entry[2] if len(entry) > 2 else None
            if payload is None:
                results.append(RpcResult(rpcid, None, entry[5] if len(entry) > 5 else True))
                continue
            results.append(RpcResult(rpcid, json.loads(payload) if isinstance(payload, str) else payload))
    return results


def first_payload(text: str, rpcid: str) -> Any:
    results = parse_envelope(text)
    for result in results:
        if result.rpcid != rpcid:
            continue
        if not result.ok:
            raise RpcError(rpcid, result.error)
        return result.data
    raise FlowError(f"{rpcid}: no {rpcid} envelope in response ({len(results)} others)")


# ── request builders ─────────────────────────────────────────────────────────

_uuid_factory: Callable[[], str] = lambda: str(uuid.uuid4()).upper()


def set_uuid_factory(factory: Callable[[], str]) -> None:
    """Test hook: make client uuids deterministic."""
    global _uuid_factory
    _uuid_factory = factory


def reset_uuid_factory() -> None:
    set_uuid_factory(lambda: str(uuid.uuid4()).upper())


def client_uuid() -> str:
    return _uuid_factory()


def random_seed() -> int:
    """Flow's UI sends a random 31-bit seed (e.g. 1561556092)."""
    return random.randint(1, 2_147_400_000)


def context(project_id: Optional[str]) -> list:
    """The surface / project / captcha block every generate call repeats."""
    return [None, SURFACE_ID, None, None, None, project_id, None, None, None, None, [CAPTCHA_SLOT, 1]]


def prompt_block(prompt: str) -> list:
    return [None, None, [[[prompt]]]]


def frame_block(media_id: str, crop: Optional[list] = None) -> list:
    return [None, media_id, None, None, None, FULL_FRAME_CROP if crop is None else crop]


def client_ids() -> list:
    first = client_uuid()
    second = client_uuid()
    return [None, None, None, None, first, second]


def image_request(prompts: Union[str, list[str]], project_id: str, aspect: int, model: str,
                  seeds: Union[int, list[int], None] = None, ref_media_ids: Optional[list[str]] = None,
                  base_media_id: Optional[str] = None, character_id: Optional[str] = None) -> str:
    """Image generate / edit (ogiZ0b). VERIFIED for BELUGA, HARBOR_SEAL and
    GEM_PIX_2, every aspect, 1/2/4 variants and a reference image.

    Variants travel in ONE call, one item each (own prompt, seed and client
    uuids) under a single captcha, as the page sends 2 or 4 images. Slot 4 of an
    item is the aspect, not a count. ``base_media_id`` makes it an edit: input
    type 2, references type 1. ``character_id`` files the images under one of
    Flow's Characters: the trailing ids become `[uuid, null, [character_id, [0]]]`
    (VERIFIED, HARBOR_SEAL from the character page).
    """
    if aspect not in (1, 2, 3, 4, 5):
        raise ValueError(f"image aspect must be 1-5, got {aspect}")
    prompts = [prompts] if isinstance(prompts, str) else list(prompts)
    if seeds is None:
        seeds = [random_seed() for _ in prompts]
    elif isinstance(seeds, int):
        seeds = [seeds]
    if not prompts or len(seeds) != len(prompts):
        raise ValueError("image_request needs one seed per prompt")
    inputs = []
    if base_media_id:
        inputs.append([base_media_id, None, None, None, BASE_TYPE_IMAGE])
    inputs.extend([mid, None, None, None, REF_TYPE_IMAGE] for mid in (ref_media_ids or []) if mid != base_media_id)
    items = []
    for prompt, seed in zip(prompts, seeds):
        first, second = client_uuid(), client_uuid()
        items.append([None, None, inputs or None, seed, aspect, model, None, context(project_id),
                      [[[prompt]]], None, None, None, first, second])
    ids = [client_uuid()] + ([None, [character_id, [0]]] if character_id else [])
    return build_envelope(RPC_GEN_IMAGE, [None, items, 1, context(project_id), ids])


def text_video_request(prompt: str, project_id: str, aspect: int, model: str) -> str:
    """Text-to-video (YhhmEf). VERIFIED for veo_3_1_t2v_fast(_portrait),
    veo_3_1_t2v_lite and abra_t2v_8s(_360p): trailing `[uuid, 2]`, and a 360p
    model carries the low-resolution option slot two places after the ids."""
    request = [prompt_block(prompt), model, aspect, None, client_ids()]
    if model.endswith("_360p"):
        request.extend([None, None, [4]])
    return build_envelope(RPC_GEN_VIDEO_TEXT, [[request], context(project_id), [client_uuid(), 2]])


def veo_video_request(prompt: str, project_id: str, source_media_id: str, aspect: int, model: str,
                      crop: Optional[list] = None) -> str:
    """Veo image-to-video (eb1hJf). UNVERIFIED on the current build."""
    request = [prompt_block(prompt), model, aspect, None, frame_block(source_media_id, crop), client_ids()]
    return build_envelope(RPC_GEN_VIDEO, [[request], context(project_id), [client_uuid(), 2]])


def omni_first_frame_request(prompt: str, project_id: str, source_media_id: str, aspect: int, model: str,
                             crop: Optional[list] = None) -> str:
    """Omni Flash first-frame (eb1hJf, abra_i2v_<N>s[_360p]). UNVERIFIED."""
    request = [prompt_block(prompt), model, aspect, None, frame_block(source_media_id, crop), client_ids()]
    if model.endswith("_360p"):
        request.extend([None, None, None, [4]])
    return build_envelope(RPC_GEN_VIDEO, [[request], context(project_id), [client_uuid(), 2]])


def first_last_request(prompt: str, project_id: str, start_media_id: str, end_media_id: str, aspect: int,
                       model: str, start_crop: Optional[list] = None, end_crop: Optional[list] = None) -> str:
    """First + last frame (nprQif). VERIFIED for omni_flash_i2v_8s_first_last,
    veo_3_1_i2v_s_fast_fl and veo_3_1_interpolation_lite. A 360p Omni key's
    extra option slot is not known yet, so such a key is refused rather than
    sent without it."""
    if model.endswith("_360p"):
        raise ValueError(f"{model}: chưa biết vị trí tuỳ chọn 360p của nprQif — tạo thử 1 video đầu+cuối 360p "
                         "trên Flow (Observation sẽ ghi lại) hoặc dùng 720p / template")
    request = [prompt_block(prompt), model, aspect, None, frame_block(start_media_id, start_crop),
               frame_block(end_media_id, end_crop), client_ids()]
    return build_envelope(RPC_GEN_VIDEO_FIRST_LAST, [[request], context(project_id), [client_uuid(), 2]])


def reference_video_request(prompt: str, project_id: str, reference_media_ids: list[str], aspect: int,
                            model: str) -> str:
    """Ingredients / reference-to-video (MZZa6b). VERIFIED for abra_r2v_6s_360p
    and veo_3_1_r2v_fast_landscape, one reference image."""
    refs = [str(mid) for mid in reference_media_ids if mid]
    if not refs:
        raise ValueError("reference-to-video needs at least one reference image")
    request = [prompt_block(prompt), [[None, mid] for mid in refs], model, aspect, None, client_ids()]
    if model.endswith("_360p"):
        request.extend([None, None, None, None, None, [4]])
    return build_envelope(RPC_GEN_VIDEO_REFERENCES, [[request], context(project_id), [client_uuid(), 2]])


def i2v_request(prompt: str, project_id: str, source_media_id: str, aspect: int, model: str,
                crop: Optional[list] = None) -> str:
    """eb1hJf, picking the Omni or Veo shape from the model key."""
    if model.startswith("abra_i2v"):
        return omni_first_frame_request(prompt, project_id, source_media_id, aspect, model, crop)
    return veo_video_request(prompt, project_id, source_media_id, aspect, model, crop)


def upload_request(image_b64: str, project_id: str, mime_type: str, file_name: str) -> str:
    """Put a local image into the project (maseQ). Bare base64, carries a captcha."""
    first, second = client_uuid(), client_uuid()
    return build_envelope(RPC_UPLOAD_IMAGE, [context(project_id), image_b64, mime_type, 1, None, None, None,
                                             None, file_name, None, first, second])


def upscale_request(media_id: str, resolution: str = "2K") -> str:
    """FlowService.UpsampleImage (SPrCad). Note the project slot is null."""
    key = str(resolution).strip().upper().removeprefix("UPSAMPLE_IMAGE_RESOLUTION_")
    if key not in IMAGE_UPSCALE_RESOLUTIONS:
        raise ValueError("upscale resolution must be 2K or 4K")
    return build_envelope(RPC_UPSCALE_IMAGE, [media_id, IMAGE_UPSCALE_RESOLUTIONS[key], context(None)])


def operation_request(operation_ids: list[str]) -> str:
    """Poll one or several operations in one call, as the page does."""
    return build_envelope(RPC_OPERATION, [None, None, [[op] for op in operation_ids]])


def media_request(media_id: str) -> str:
    return build_envelope(RPC_MEDIA, [media_id])


def project_media_request(project_id: str) -> str:
    return build_envelope(RPC_PROJECT_MEDIA, [f"projects/{project_id}", None, None, None, [1]])


# ── response readers ─────────────────────────────────────────────────────────

def _walk_strings(node: Any):
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for item in node:
            yield from _walk_strings(item)


def read_images(payload: Any) -> list[tuple[str, str]]:
    """Signed CDN urls come back inline on the image call: [(media_id, url)]."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for text in _walk_strings(payload):
        if MEDIA_HOST + "/image/" not in text:
            continue
        media_id = text.split("/image/", 1)[1].split("?", 1)[0]
        if media_id not in seen:
            seen.add(media_id)
            out.append((media_id, text))
    return out


@dataclass
class Operation:
    operation_id: str
    project_id: Optional[str]
    status: Optional[str]
    complaint: Optional[str]

    @property
    def done(self) -> bool:
        return self.status == STATUS_DONE


def _operation_complaint(record: list) -> Optional[str]:
    """`[4, [null, "Media not found."], …]` in the detail block. A complaint, never a verdict."""
    detail = record[5] if len(record) > 5 else None
    if not isinstance(detail, list) or len(detail) <= 8:
        return None
    block = detail[8]
    if not isinstance(block, list) or not block or block[0] != OUTCOME_COMPLAINT:
        return None
    return next(_walk_strings(block), "operation failed without a message")


def read_operations(payload: Any) -> list[Operation]:
    """`[null, 50, [[opId, projectId, sceneId, status, _, detail], …]]`."""
    records = payload[2] if isinstance(payload, list) and len(payload) > 2 else None
    out = []
    for record in records if isinstance(records, list) else []:
        if not isinstance(record, list) or not record or not isinstance(record[0], str):
            continue
        out.append(Operation(
            operation_id=record[0],
            project_id=record[1] if len(record) > 1 and isinstance(record[1], str) else None,
            status=record[3] if len(record) > 3 and isinstance(record[3], str) else None,
            complaint=_operation_complaint(record),
        ))
    return out


def read_video_submit(payload: Any) -> dict:
    """Any video submit: an operation record (slot 2) and/or, on the older t2v
    shape, a media record (slot 3). The page polls jwpduf and then asks as29s
    with that same id, so the operation id doubles as the media id candidate."""
    ops = read_operations(payload)
    media = None
    records = payload[3] if isinstance(payload, list) and len(payload) > 3 else None
    record = records[0] if isinstance(records, list) and records else None
    if isinstance(record, list) and record and isinstance(record[0], str):
        media = {
            "media_id": record[0],
            "project_id": record[1] if len(record) > 1 and isinstance(record[1], str) else None,
            "workflow_id": record[2] if len(record) > 2 and isinstance(record[2], str) else record[0],
            "status": record[3] if len(record) > 3 and isinstance(record[3], str) else None,
        }
    if not ops and not media:
        raise FlowError(f"video submit carried neither an operation nor a media record: {dumps(payload)[:300]}")
    op = ops[0] if ops else None
    return {
        "operation_id": op.operation_id if op else media["workflow_id"],
        "project_id": (op.project_id if op else None) or (media or {}).get("project_id"),
        "status": (op.status if op else None) or (media or {}).get("status"),
        "media_id": (media or {}).get("media_id"),
    }


def read_media_urls(payload: Any) -> tuple[Optional[str], Optional[str]]:
    """as29s → (video url, image/poster url)."""
    video = image = None
    for text in _walk_strings(payload):
        if not text.startswith("https://"):
            continue
        if MEDIA_HOST + "/video/" in text and video is None:
            video = text
        elif MEDIA_HOST + "/image/" in text and image is None:
            image = text
    return video, image


def read_uploaded_media_id(payload: Any) -> str:
    record = payload[0] if isinstance(payload, list) and payload else None
    media_id = record[0] if isinstance(record, list) and record else None
    if not isinstance(media_id, str) or not media_id:
        raise FlowError("upload response carried no media id")
    return media_id


def read_upscaled_image(payload: Any) -> str:
    encoded = payload[1] if isinstance(payload, list) and len(payload) > 1 else None
    if not isinstance(encoded, str) or len(encoded) < 100:
        raise FlowError("upscale response carried no encoded image")
    return encoded


_MEDIA_SLOT = re.compile(r'null,null,\\?"([0-9a-fA-F-]{36})\\?"')


def find_media_id_in_text(text: str, operation_id: str) -> Optional[str]:
    """Media id of an operation inside the (windowed) project-listing text."""
    start = text.find(operation_id)
    if start == -1:
        return None
    match = _MEDIA_SLOT.search(text, start, start + 800)
    return match.group(1) if match else None


def image_client_ids(freq: str) -> list[str]:
    """Client uuids of an ogiZ0b body: the request's trailing `[uuid]` first,
    then the two of every item.

    Flow keeps the request's uuid on the workflow right after the media id
    (`[workflowId,null,null,[title,[ts],null,null,"<media id>","<client uuid>",…]]`,
    seen for a one-image call), which is how an image whose response was lost
    is found again in the listing. Which uuid each image of a multi-item call
    carries is not known yet, so all of them are looked for.
    """
    inner = decode_envelope(freq)[0][1]
    out: list[str] = []
    ids = inner[4] if isinstance(inner, list) and len(inner) > 4 else None
    if isinstance(ids, list) and ids and isinstance(ids[0], str):
        out.append(ids[0])
    for item in (inner[1] if isinstance(inner, list) and len(inner) > 1 and isinstance(inner[1], list) else []):
        if isinstance(item, list):
            out.extend(x for x in item[12:14] if isinstance(x, str))
    return out


def find_media_ids_before(text: str, client_ids: list[str]) -> list[str]:
    """Media ids stored just ahead of any of a request's client uuids in the
    (windowed) listing text, in the order they appear."""
    if not client_ids:
        return []
    marker = "|".join(re.escape(c) for c in client_ids)
    found = re.findall(r'\\?"([0-9a-fA-F-]{36})\\?",\\?"(?:' + marker + ")", text)
    return list(dict.fromkeys(found))
