"""Character builder: a frontal studio headshot prompt, used later as a reference.

A "character" is just an image generate with this prompt; its media id then
feeds later shots as a reference image so the person stays the same.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Optional

_FILE = Path(__file__).parent / "data" / "character_presets.json"


@lru_cache(maxsize=1)
def presets() -> dict:
    return json.loads(_FILE.read_text(encoding="utf-8"))


def build_character_prompt(gender: Optional[str], country: Optional[str], vibe: Optional[str],
                           extras: str = "") -> str:
    p = presets()
    g = next((x["tag"] for x in p["genders"] if x["key"] == gender), None)
    c = next((x["tag"] for x in p["countries"] if x["key"] == country), None)
    subject = " ".join(x for x in (c, g) if x) or "person"
    vibe_tokens = next((v["tokens"] for v in p["vibes"] if v["key"] == (vibe or "clean")), [])
    parts = [
        f"Studio portrait headshot of a {subject} character",
        "subject directly faces the camera, head perfectly straight with zero tilt and zero turn",
        "shoulders square to camera, axially symmetric pose, nose centered, both eyes equally visible at the same height",
        *vibe_tokens,
        (extras or "").strip() or None,
        "head and shoulders framing, centered composition, sharp focus on face",
        "strictly front-on orientation, no head tilt, no head turn, no profile angle, no three-quarter view, no over-the-shoulder pose",
        "no glasses, no hat, no mask, no occlusion, nothing covering the face",
        "photorealistic, ultra-detailed, consistent character reference",
    ]
    return ", ".join(x for x in parts if x)
