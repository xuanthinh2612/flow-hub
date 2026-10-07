"""The model catalog: which wire ids exist, per mode, as data — not code.

Rows are concrete wire ids (`veo_3_1_t2v_fast_portrait`) grouped in families
(`veo_3_1_fast`) with the attributes that select them (aspect, duration,
resolution). A job names a family plus attributes and the catalog resolves the
wire id. When Flow's page uses a key we have never seen, the Observation store
adds it here (status `verified`, source `observed`) and raises an alert, so a
new model is usable the moment it shows up in traffic.

status: verified   — seen in Flow's own traffic (or confirmed working)
        unverified — from older captures, not yet seen on the current build
        disabled   — never picked by the resolver
"""
from __future__ import annotations

import re
from typing import Any, Optional

from .db import DB, now

MODES = {
    "image": "Ảnh (ogiZ0b)",
    "t2v": "Text → Video (YhhmEf)",
    "i2v": "Ảnh → Video (eb1hJf)",
    "first_last": "Ảnh đầu + cuối (nprQif)",
    "r2v": "Ingredients (MZZa6b)",
}

_V = "verified"
_U = "unverified"
_OBS = "Thấy trên Flow 07/10/2026"
_OLD = "Từ capture cũ (Flowboard 09/2026)"


def _seed_rows() -> list[dict]:
    rows: list[dict] = []

    def add(mode, family, label, key, *, aspect=None, duration=None, resolution=None, status=_U, note=_OLD,
            default=False, sort=100):
        rows.append(dict(mode=mode, family=family, family_label=label, key=key, aspect=aspect,
                         duration=duration, resolution=resolution, status=status, note=note,
                         is_default=1 if default else 0, sort=sort))

    add("image", "beluga", "BELUGA", "BELUGA", status=_V, note=_OBS, default=True, sort=10)
    add("image", "nano_banana_pro", "Nano Banana Pro", "GEM_PIX_2", sort=20)
    add("image", "nano_banana_2", "Nano Banana 2", "NARWHAL", sort=30)
    add("image", "nano_banana_2_lite", "Nano Banana 2 Lite", "HARBOR_SEAL", sort=40)

    add("t2v", "veo_3_1_fast", "Veo 3.1 Fast", "veo_3_1_t2v_fast", aspect="landscape", status=_V, note=_OBS,
        default=True, sort=10)
    add("t2v", "veo_3_1_fast", "Veo 3.1 Fast", "veo_3_1_t2v_fast_portrait", aspect="portrait", status=_V,
        note=_OBS, sort=10)
    add("t2v", "veo_3_1_lite", "Veo 3.1 Lite", "veo_3_1_t2v_lite", status=_V,
        note=_OBS + " (16:9; 9:16 dùng chung key, chưa thấy)", sort=20)
    for duration in (4, 6, 8, 10):
        for res in ("720p", "360p"):
            key = f"abra_t2v_{duration}s" + ("_360p" if res == "360p" else "")
            seen = duration == 8
            add("t2v", "omni_flash", "Omni Flash", key, duration=duration, resolution=res,
                status=_V if seen else _U, note=_OBS if seen else "Suy ra từ quy luật tên", sort=30)

    add("i2v", "veo_3_1_lite", "Veo 3.1 Lite", "veo_3_1_i2v_lite", default=True, sort=10)
    add("i2v", "veo_3_1_fast_ultra", "Veo 3.1 Fast (Ultra)", "veo_3_1_i2v_s_fast_ultra", sort=20)
    add("i2v", "veo_3_1_lite_low", "Veo 3.1 Lite Low Priority (Ultra)", "veo_3_1_i2v_lite_low_priority", sort=30)
    for duration in (4, 6, 8, 10):
        for res in ("720p", "360p"):
            sfx = "_360p" if res == "360p" else ""
            add("i2v", "omni_flash", "Omni Flash", f"abra_i2v_{duration}s{sfx}", duration=duration, resolution=res,
                sort=40)
            add("first_last", "omni_flash", "Omni Flash", f"omni_flash_i2v_{duration}s_first_last{sfx}",
                duration=duration, resolution=res, default=True, sort=10)
            add("r2v", "omni_flash", "Omni Flash", f"abra_r2v_{duration}s{sfx}", duration=duration,
                resolution=res, default=True, sort=10)
    return rows


_OMNI = re.compile(r"^(?:abra_(?:t2v|i2v|r2v)|omni_flash_i2v)_(\d+)s(?:_first_last)?(_360p)?$")


def infer_family(mode: str, key: str, aspect: Optional[str]) -> dict:
    """Best guess at where a newly seen key belongs."""
    m = _OMNI.match(key)
    if m:
        return {"family": "omni_flash", "family_label": "Omni Flash", "duration": int(m.group(1)),
                "resolution": "360p" if m.group(2) else "720p", "aspect": None}
    if key.endswith("_portrait"):
        base = key[: -len("_portrait")]
        return {"family": base, "family_label": base, "aspect": "portrait", "duration": None, "resolution": None}
    family = key.lower()
    return {"family": family, "family_label": key, "aspect": None, "duration": None, "resolution": None}


class Catalog:
    def __init__(self, db: DB):
        self.db = db

    def seed(self) -> None:
        """Insert seed rows that are missing; never overwrite what the user edited."""
        t = now()
        for row in _seed_rows():
            self.db.insert("models", {**row, "source": "seed", "first_seen": t, "last_seen": None}, ignore=True)

    # ── queries ──
    def rows(self, mode: Optional[str] = None) -> list[dict]:
        if mode:
            return self.db.all("SELECT * FROM models WHERE mode=? ORDER BY sort, family, duration, resolution, key",
                               (mode,))
        return self.db.all("SELECT * FROM models ORDER BY mode, sort, family, duration, resolution, key")

    def families(self, mode: Optional[str] = None) -> list[dict]:
        groups: dict[tuple, dict] = {}
        for row in self.rows(mode):
            g = groups.setdefault((row["mode"], row["family"]), {
                "mode": row["mode"], "family": row["family"], "label": row["family_label"] or row["family"],
                "default": False, "variants": [], "sort": row["sort"]})
            g["default"] = g["default"] or bool(row["is_default"])
            g["variants"].append(row)
        return sorted(groups.values(), key=lambda g: (g["mode"], g["sort"], g["label"]))

    def default_family(self, mode: str) -> Optional[str]:
        fams = [f for f in self.families(mode) if any(v["status"] != "disabled" for v in f["variants"])]
        for f in fams:
            if f["default"]:
                return f["family"]
        return fams[0]["family"] if fams else None

    def resolve(self, mode: str, family: Optional[str] = None, aspect: Optional[str] = None,
                duration: Optional[int] = None, resolution: Optional[str] = None) -> dict:
        """Pick the wire id for a family + attributes. Raises ValueError with what exists."""
        family = family or self.default_family(mode)
        rows = [r for r in self.rows(mode) if r["family"] == family and r["status"] != "disabled"]
        if not rows:
            raise ValueError(f"không có model nào cho mode={mode} family={family}")
        wanted = {"aspect": aspect, "duration": duration, "resolution": resolution}
        best, best_score = None, -1
        for row in rows:
            score = {"verified": 30, "unverified": 10}.get(row["status"], 0)
            ok = True
            for attr, want in wanted.items():
                have = row[attr]
                if have is None:
                    score += 1                      # generic: fits any value
                elif want is None:
                    score += 2 if (attr, have) in (("duration", 8), ("resolution", "720p"), ("aspect", "landscape")) else 0
                elif have == want:
                    score += 5
                else:
                    ok = False
                    break
            if ok and score > best_score:
                best, best_score = row, score
        if best is None:
            options = ", ".join(sorted({r["key"] for r in rows}))
            raise ValueError(f"family {family} không có biến thể khớp {wanted}; có: {options}")
        return best

    # ── what the page used ──
    def observe(self, mode: str, key: str, aspect: Optional[str]) -> Optional[str]:
        """Record a key Flow's page used. Returns 'new' / 'verified' / None (already known)."""
        t = now()
        row = self.db.one("SELECT * FROM models WHERE mode=? AND key=?", (mode, key))
        if row is None:
            guess = infer_family(mode, key, aspect)
            self.db.insert("models", {"mode": mode, "key": key, "status": "verified", "source": "observed",
                                      "note": "Tự thêm từ Observation", "first_seen": t, "last_seen": t,
                                      "sort": 200, **guess}, ignore=True)
            return "new"
        changes: dict[str, Any] = {"last_seen": t}
        upgraded = row["status"] == "unverified"
        if upgraded:
            changes["status"] = "verified"
        self.db.update("models", "id", row["id"], changes)
        return "verified" if upgraded else None

    # ── edits ──
    def create(self, values: dict) -> int:
        allowed = {"mode", "family", "family_label", "key", "aspect", "duration", "resolution", "status", "note", "sort"}
        row = {k: v for k, v in values.items() if k in allowed}
        if row.get("mode") not in MODES or not row.get("key"):
            raise ValueError("cần mode hợp lệ và key")
        row.setdefault("family", row["key"].lower())
        row.setdefault("family_label", row["family"])
        row.setdefault("status", "unverified")
        return self.db.insert("models", {**row, "source": "manual", "first_seen": now()})

    def update(self, model_id: int, values: dict) -> None:
        allowed = {"family", "family_label", "aspect", "duration", "resolution", "status", "note", "sort"}
        self.db.update("models", "id", model_id, {k: v for k, v in values.items() if k in allowed})

    def delete(self, model_id: int) -> None:
        self.db.execute("DELETE FROM models WHERE id=?", (model_id,))

    def set_default(self, mode: str, family: str) -> None:
        self.db.execute("UPDATE models SET is_default=0 WHERE mode=?", (mode,))
        self.db.execute("UPDATE models SET is_default=1 WHERE mode=? AND family=?", (mode, family))
