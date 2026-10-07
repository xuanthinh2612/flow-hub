"""Templates: a request body captured from Flow's page, re-sendable with new values.

When Flow changes a body before Flow Hub's builder is updated, save one of the
page's own requests as a template from the Observation page and run jobs from
it: prompt, project, client uuids, media ids and seed become placeholders and
the captcha slot is re-minted per call.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .db import DB, now
from .protocol import batch as fb
from .protocol import observe as ob

if TYPE_CHECKING:
    from .observations import ObservationStore

RESULT_KIND_BY_RPC = {fb.RPC_GEN_IMAGE: "image", fb.RPC_GEN_VIDEO: "video", fb.RPC_GEN_VIDEO_TEXT: "video",
                      fb.RPC_GEN_VIDEO_FIRST_LAST: "video", fb.RPC_GEN_VIDEO_REFERENCES: "video"}


def placeholders(node, out: Optional[dict] = None) -> list[str]:
    out = {} if out is None else out
    if isinstance(node, list):
        for v in node:
            placeholders(v, out)
    elif isinstance(node, str) and node.startswith("{{") and node.endswith("}}") and node != "{{uuid}}":
        out[node[2:-2]] = None
    return list(out)


class TemplateStore:
    def __init__(self, db: DB, observations: "ObservationStore"):
        self.db = db
        self.observations = observations

    def list(self) -> list[dict]:
        return self.db.all("SELECT * FROM templates ORDER BY updated_at DESC")

    def get(self, template_id: int) -> Optional[dict]:
        return self.db.one("SELECT * FROM templates WHERE id=?", (template_id,))

    def from_observation(self, obs_id: int, rpc_index: int = 0, name: Optional[str] = None) -> dict:
        obs = self.observations.get(obs_id)
        if obs is None or obs.get("kind") != "batchexecute":
            raise ValueError("observation không tồn tại hoặc không phải batchexecute")
        rpcs = obs.get("rpcs") or []
        if rpc_index >= len(rpcs) or rpcs[rpc_index].get("inner") is None:
            raise ValueError("không có inner JSON ở vị trí này")
        if rpcs[rpc_index].get("shortened"):
            raise ValueError("body đã bị rút gọn khi lưu (chuỗi quá dài) — không dùng làm template được")
        rpcid = rpcs[rpc_index]["rpcid"]
        template, variables = ob.templatize(rpcs[rpc_index]["inner"])
        summary = ob.summarize([rpcs[rpc_index]])
        return self.create({
            "name": name or f"{rpcid} · {', '.join(summary['keys'][:2]) or 'từ Observation'} · #{obs_id}",
            "rpcid": rpcid, "captcha_action": self.observations.captcha_action_for(rpcid)
            if ob.carries_captcha(rpcs[rpc_index]["inner"]) else None,
            "inner": template, "result_kind": RESULT_KIND_BY_RPC.get(rpcid, "raw"), "observation_id": obs_id,
            "note": f"Tạo từ request của trang (build {obs.get('bl')})"})

    def create(self, values: dict) -> dict:
        inner = values.get("inner")
        if not values.get("rpcid") or inner is None:
            raise ValueError("cần rpcid và inner")
        t = now()
        template_id = self.db.insert("templates", {
            "name": values.get("name") or values["rpcid"], "rpcid": values["rpcid"],
            "captcha_action": values.get("captcha_action"), "inner": inner, "variables": placeholders(inner),
            "result_kind": values.get("result_kind") or RESULT_KIND_BY_RPC.get(values["rpcid"], "raw"),
            "observation_id": values.get("observation_id"), "note": values.get("note"),
            "created_at": t, "updated_at": t})
        return self.get(template_id)

    def update(self, template_id: int, values: dict) -> dict:
        allowed = {"name", "rpcid", "captcha_action", "inner", "result_kind", "note"}
        changes = {k: v for k, v in values.items() if k in allowed}
        if "inner" in changes:
            changes["variables"] = placeholders(changes["inner"])
        changes["updated_at"] = now()
        self.db.update("templates", "id", template_id, changes)
        return self.get(template_id)

    def delete(self, template_id: int) -> None:
        self.db.execute("DELETE FROM templates WHERE id=?", (template_id,))

    def render(self, template_id: int, values: dict) -> dict:
        tpl = self.get(template_id)
        if tpl is None:
            raise ValueError("template không tồn tại")
        inner = ob.render_template(tpl["inner"], values)
        return {"rpcid": tpl["rpcid"], "inner": inner, "freq": fb.build_envelope(tpl["rpcid"], inner)}
