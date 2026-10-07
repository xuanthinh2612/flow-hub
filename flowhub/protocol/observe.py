"""Reading what Flow's own page sends: decode, summarise, compare, templatise.

Everything here is pure (no I/O) so it can be unit-tested against captured
traffic. The Observation store calls into it on every request the extension
reports.
"""
from __future__ import annotations

import base64
import json
import re
from typing import Any, Optional

from . import batch as fb

MAX_STRING = 5000      # longer strings (upload base64) are shortened when stored
MAX_RESPONSE = 60000   # response text / each parsed payload kept up to this

UUID_UPPER = re.compile(r"^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$")
UUID_LOWER = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SNAKE_KEY = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$")
UPPER_KEY = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{4,}$")
USER_AGENT = re.compile(r"^Mozilla/\d")

#: RPCs whose body Flow Hub builds itself — the ones worth a builder check.
BUILT_RPCS = {fb.RPC_GEN_IMAGE, fb.RPC_GEN_VIDEO, fb.RPC_GEN_VIDEO_TEXT, fb.RPC_GEN_VIDEO_FIRST_LAST,
              fb.RPC_GEN_VIDEO_REFERENCES}


# ── decoding ────────────────────────────────────────────────────────────────

def shrink(value: Any, state: Optional[dict] = None) -> Any:
    """Deep copy with over-long strings shortened (marks state['cut'])."""
    if isinstance(value, str):
        if len(value) <= MAX_STRING:
            return value
        if state is not None:
            state["cut"] = True
        return f"‹{len(value)} ký tự, đã rút gọn: {value[:48]}…›"
    if isinstance(value, list):
        return [shrink(v, state) for v in value]
    if isinstance(value, dict):
        return {k: shrink(v, state) for k, v in value.items()}
    return value


def decode_freq(freq: Optional[str]) -> list[dict]:
    """`f.req` → [{rpcid, tag, size, inner | raw, shortened}] (one call can batch several RPCs)."""
    if not freq:
        return []
    try:
        outer = json.loads(freq)
    except json.JSONDecodeError:
        return [{"rpcid": "?", "raw": freq[:MAX_STRING], "size": len(freq)}]
    items = outer[0] if isinstance(outer, list) and outer and isinstance(outer[0], list) else []
    out = []
    for item in items:
        if not isinstance(item, list) or not item:
            continue
        rpcid = str(item[0])
        inner_str = item[1] if len(item) > 1 else None
        entry: dict[str, Any] = {"rpcid": rpcid, "tag": item[3] if len(item) > 3 else None,
                                 "size": len(inner_str) if isinstance(inner_str, str) else 0}
        try:
            state: dict = {}
            entry["inner"] = shrink(json.loads(inner_str), state)
            if state.get("cut"):
                entry["shortened"] = True
        except (TypeError, json.JSONDecodeError):
            entry["raw"] = inner_str[:MAX_STRING] if isinstance(inner_str, str) else None
        out.append(entry)
    return out


def decode_response(text: str) -> dict:
    out: dict[str, Any] = {"size": len(text), "raw": text[:MAX_RESPONSE], "rpcs": []}
    try:
        parsed = fb.parse_envelope(text)
    except Exception as exc:  # noqa: BLE001 — a diagnostic, never fatal
        out["parse_error"] = str(exc)
        return out
    for result in parsed:
        entry: dict[str, Any] = {"rpcid": result.rpcid}
        if not result.ok:
            entry["error"] = result.error
            entry["error_text"] = fb.describe_error(result.error)
        encoded = fb.dumps(result.data)
        if len(encoded) <= MAX_RESPONSE:
            entry["data"] = shrink(result.data)
        else:
            entry["data_size"] = len(encoded)
        out["rpcs"].append(entry)
    return out


def redact_headers(headers: Any) -> list[dict]:
    out = []
    for h in headers or []:
        name = str(h.get("name", ""))
        value = h.get("value", "")
        lower = name.lower()
        if lower == "cookie":
            value = f"‹{len(str(value).split(';'))} cookie — đã ẩn›"
        elif lower == "authorization":
            value = "‹đã ẩn›"
        out.append({"name": name, "value": value})
    return out


# ── summaries ───────────────────────────────────────────────────────────────

def _is_prompt_block(node: list) -> bool:
    return (len(node) == 1 and isinstance(node[0], list) and len(node[0]) == 1
            and isinstance(node[0][0], list) and len(node[0][0]) == 1 and isinstance(node[0][0][0], str))


def summarize(rpcs: list[dict]) -> dict:
    """Model-ish keys and the most prompt-like text. JSON inside strings
    (MEDIA_GENERATION_SETTINGS) is opened up too. Prompt rank: a [[["…"]]]
    block, then a JSON "text" field, then other free text (not a user agent)."""
    keys: dict[str, None] = {}
    prompts: list[tuple[int, str]] = []

    def visit(node: Any) -> None:
        if isinstance(node, str):
            if node.startswith("‹"):
                return
            if node[:1] in ("{", "[") and len(node) < 20000:
                try:
                    visit(json.loads(node))
                    return
                except json.JSONDecodeError:
                    pass
            if len(node) <= 120 and (SNAKE_KEY.match(node) or UPPER_KEY.match(node)):
                keys[node] = None
            elif len(node) >= 3 and re.search(r"\s", node) and not USER_AGENT.match(node):
                prompts.append((1, node))
        elif isinstance(node, list):
            if _is_prompt_block(node):
                prompts.append((3, node[0][0][0]))
            for v in node:
                visit(v)
        elif isinstance(node, dict):
            for k, v in node.items():
                if k == "text" and isinstance(v, str):
                    prompts.append((2, v))
                visit(v)

    for rpc in rpcs:
        visit(rpc.get("inner"))
    prompts.sort(key=lambda p: -p[0])
    return {"keys": list(keys), "prompt": prompts[0][1][:200] if prompts else None}


def find_context(node: Any) -> Optional[list]:
    """The `[null, 22, …, projectId, …, [token, 1]]` block, if the body has one."""
    if isinstance(node, list):
        if len(node) == 11 and node[1] == fb.SURFACE_ID and isinstance(node[10], list) and node[10] \
                and isinstance(node[10][0], str):
            return node
        for v in node:
            found = find_context(v)
            if found is not None:
                return found
    return None


def carries_captcha(inner: Any) -> bool:
    ctx = find_context(inner)
    return bool(ctx and isinstance(ctx[10][0], str) and len(ctx[10][0]) > 100)


# ── reCAPTCHA bodies (protobuf) ─────────────────────────────────────────────

def _varint(data: bytes, pos: int) -> tuple[int, int]:
    value = shift = 0
    while pos < len(data) and shift < 64:
        b = data[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, pos
        shift += 7
    raise ValueError("bad varint")


def _printable(chunk: bytes) -> bool:
    return bool(chunk) and all(0x20 <= b < 0x7F for b in chunk)


def _proto_strings(data: bytes, depth: int = 0, out: Optional[list] = None) -> list[str]:
    out = [] if out is None else out
    pos = 0
    while pos < len(data):
        key, pos = _varint(data, pos)
        wire = key & 7
        if key >> 3 == 0:
            raise ValueError("field 0")
        if wire == 0:
            _, pos = _varint(data, pos)
        elif wire == 1:
            pos += 8
        elif wire == 5:
            pos += 4
        elif wire == 2:
            length, pos = _varint(data, pos)
            if pos + length > len(data):
                raise ValueError("overrun")
            chunk = data[pos:pos + length]
            pos += length
            if _printable(chunk):
                out.append(chunk.decode("ascii"))
            elif depth < 4:
                try:
                    _proto_strings(chunk, depth + 1, out)
                except ValueError:
                    pass
        else:
            raise ValueError(f"wire type {wire}")
    if pos != len(data):
        raise ValueError("trailing bytes")
    return out


def _printable_runs(data: bytes, minimum: int = 4) -> list[str]:
    return [m.decode("ascii") for m in re.findall(rb"[\x20-\x7e]{%d,}" % minimum, data)]


def recaptcha_strings(body_b64: Optional[str], limit: int = 80) -> list[str]:
    """String fields of a reCAPTCHA mint request. The action travels in here."""
    if not body_b64:
        return []
    try:
        data = base64.b64decode(body_b64)
    except (ValueError, TypeError):
        return []
    try:
        strings = _proto_strings(data)
    except ValueError:
        strings = _printable_runs(data)
    out = []
    for s in strings:
        if len(s) < 4:
            continue
        out.append(f"{s[:40]}…({len(s)} ký tự)" if len(s) > 160 else s)
    return out[:limit]


def action_candidates(strings: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for s in strings:
        if re.match(r"^[A-Za-z][A-Za-z0-9_/]{2,60}$", s) and ("_" in s or "hijack" in s.lower()) \
                and not re.match(r"^[A-Za-z0-9_-]{30,}$", s):
            seen[s] = None
    return list(seen)


# ── model keys in a request ─────────────────────────────────────────────────

MODE_BY_RPC = {
    fb.RPC_GEN_IMAGE: "image",
    fb.RPC_GEN_VIDEO_TEXT: "t2v",
    fb.RPC_GEN_VIDEO: "i2v",
    fb.RPC_GEN_VIDEO_FIRST_LAST: "first_last",
    fb.RPC_GEN_VIDEO_REFERENCES: "r2v",
}


def _video_item(inner: Any) -> Optional[list]:
    try:
        item = inner[0][0]
        return item if isinstance(item, list) else None
    except (TypeError, IndexError, KeyError):
        return None


def model_uses(rpcid: str, inner: Any) -> list[dict]:
    """[{mode, key, aspect}] for each model a generate request names."""
    out = []
    try:
        if rpcid == fb.RPC_GEN_IMAGE:
            for item in inner[1] or []:
                if isinstance(item, list) and len(item) > 5 and isinstance(item[5], str):
                    out.append({"mode": "image", "key": item[5], "aspect": None})
        elif rpcid in MODE_BY_RPC:
            item = _video_item(inner)
            if item is None:
                return out
            key_slot, aspect_slot = (2, 3) if rpcid == fb.RPC_GEN_VIDEO_REFERENCES else (1, 2)
            key = item[key_slot] if len(item) > key_slot else None
            aspect = item[aspect_slot] if len(item) > aspect_slot else None
            if isinstance(key, str):
                out.append({"mode": MODE_BY_RPC[rpcid], "key": key,
                            "aspect": {1: "portrait", 2: "landscape"}.get(aspect)})
    except (TypeError, IndexError, KeyError):
        pass
    return out


# ── builder check: rebuild an observed request and compare ─────────────────

def _normalize(node: Any) -> Any:
    """Make two bodies comparable: client uuids and captcha tokens vary per call."""
    if isinstance(node, str):
        if UUID_UPPER.match(node):
            return "<UUID>"
        return node
    if isinstance(node, list):
        ctx = node if (len(node) == 11 and node[1] == fb.SURFACE_ID and isinstance(node[10], list)) else None
        out = [_normalize(v) for v in node]
        if ctx is not None and out[10] and isinstance(out[10][0], str):
            out[10] = ["<CAPTCHA>"] + out[10][1:]
        return out
    return node


def _diff(a: Any, b: Any, path: str = "", out: Optional[list] = None, limit: int = 12) -> list:
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append({"path": path or "/", "observed": f"list[{len(a)}]", "built": f"list[{len(b)}]"})
        for i in range(min(len(a), len(b))):
            _diff(a[i], b[i], f"{path}[{i}]", out, limit)
        return out
    if a != b:
        out.append({"path": path or "/", "observed": a, "built": b})
    return out


def rebuild(rpcid: str, inner: Any) -> Optional[str]:
    """The f.req Flow Hub's builder would send for the same inputs, or None."""
    ctx = find_context(inner)
    project = ctx[5] if ctx else None
    if rpcid == fb.RPC_GEN_IMAGE:
        item = inner[1][0]
        inputs = item[2] or []
        refs = [x[0] for x in inputs if isinstance(x, list) and len(x) > 4 and x[4] == fb.REF_TYPE_IMAGE]
        base = next((x[0] for x in inputs if isinstance(x, list) and len(x) > 4 and x[4] == fb.BASE_TYPE_IMAGE), None)
        return fb.image_request(item[8][0][0][0], project, item[4], item[5], seed=item[3],
                                ref_media_ids=refs or None, base_media_id=base)
    item = _video_item(inner)
    if item is None:
        return None
    prompt = item[0][2][0][0][0]
    if rpcid == fb.RPC_GEN_VIDEO_TEXT:
        return fb.text_video_request(prompt, project, item[2], item[1])
    if rpcid == fb.RPC_GEN_VIDEO:
        frame = item[4]
        if item[1].startswith("abra_i2v"):
            return fb.omni_first_frame_request(prompt, project, frame[1], item[2], item[1], crop=frame[5])
        return fb.veo_video_request(prompt, project, frame[1], item[2], item[1], crop=frame[5])
    if rpcid == fb.RPC_GEN_VIDEO_FIRST_LAST:
        return fb.first_last_request(prompt, project, item[4][1], item[5][1], item[2], item[1],
                                     start_crop=item[4][5], end_crop=item[5][5])
    if rpcid == fb.RPC_GEN_VIDEO_REFERENCES:
        return fb.reference_video_request(prompt, project, [r[1] for r in item[1]], item[3], item[2])
    return None


def builder_check(rpcid: str, inner: Any) -> dict:
    """Rebuild the observed request with Flow Hub's builder and diff the two."""
    if rpcid not in BUILT_RPCS:
        return {"supported": False, "reason": f"Flow Hub không tự dựng body cho {rpcid}"}
    try:
        built_freq = rebuild(rpcid, inner)
    except (TypeError, IndexError, KeyError, AttributeError, ValueError) as exc:
        return {"supported": True, "ok": False, "error": f"không trích được tham số: {exc!r}",
                "diffs": [{"path": "/", "observed": "cấu trúc lạ", "built": "-"}]}
    if built_freq is None:
        return {"supported": False, "reason": "không nhận ra cấu trúc"}
    built = fb.decode_envelope(built_freq)[0][1]
    a, b = _normalize(inner), _normalize(built)
    diffs = _diff(a, b)
    return {"supported": True, "ok": not diffs, "diffs": diffs, "built": b}


# ── templates ───────────────────────────────────────────────────────────────

def templatize(inner: Any) -> tuple[Any, list[str]]:
    """Turn an observed body into a template: prompt, project, client uuids,
    media ids, seed and the captcha token become placeholders."""
    ctx = find_context(inner)
    project = ctx[5] if ctx else None
    media_ids: dict[str, str] = {}
    variables: dict[str, None] = {}

    def walk(node: Any, parent: Any = None, index: int = -1) -> Any:
        if isinstance(node, list):
            if _is_prompt_block(node):
                variables["prompt"] = None
                return [[["{{prompt}}"]]]
            is_ctx = len(node) == 11 and node[1] == fb.SURFACE_ID and isinstance(node[10], list)
            out = [walk(v, node, i) for i, v in enumerate(node)]
            if is_ctx:
                out[10] = [fb.CAPTCHA_SLOT] + out[10][1:]
            return out
        if isinstance(node, str):
            if project and node == project:
                variables["project_id"] = None
                return "{{project_id}}"
            if UUID_UPPER.match(node):
                return "{{uuid}}"
            if UUID_LOWER.match(node):
                name = media_ids.setdefault(node, f"media_{len(media_ids) + 1}")
                variables[name] = None
                return "{{" + name + "}}"
        if isinstance(node, int) and not isinstance(node, bool) and node > 100000 and parent is not None:
            # The image seed (slot 3 of an ogiZ0b item) is the only large number Flow sends.
            if index == 3 and isinstance(parent, list) and len(parent) >= 14:
                variables["seed"] = None
                return "{{seed}}"
        return node

    return walk(inner), list(variables)


def render_template(template: Any, values: dict) -> Any:
    """Fill a template. `{{uuid}}` is fresh per occurrence; `{{seed}}` defaults to random."""
    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, str) and node.startswith("{{") and node.endswith("}}"):
            name = node[2:-2]
            if name == "uuid":
                return fb.client_uuid()
            if name == "seed":
                seed = values.get("seed")
                return int(seed) if seed not in (None, "") else fb.random_seed()
            if name in values and values[name] not in (None, ""):
                return values[name]
            raise ValueError(f"thiếu giá trị cho {{{{{name}}}}}")
        return node
    return walk(template)
