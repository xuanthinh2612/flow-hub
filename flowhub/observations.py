"""Observation: every batchexecute call (and reCAPTCHA mint) a Flow tab makes.

The extension reports traffic passively (webRequest; responses through
chrome.debugger when enabled). Here each call is decoded, stored, labelled as
the page's own or Flow Hub's (by the _reqid the server minted), and — for the
page's own calls — used to keep Flow Hub current:

* a new RPC id, a new model key, or a new Flow build raises an alert;
* model keys the page uses land in the catalog (status verified);
* the reCAPTCHA action the page mints right before an RPC is learned;
* requests Flow Hub knows how to build are rebuilt and diffed ("builder
  check"); a mismatch means Flow changed the body and raises an alert.
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Optional
from urllib.parse import parse_qs, urlparse

from .db import DB, Settings, now
from .protocol import batch as fb
from .protocol import observe as ob

if TYPE_CHECKING:
    from .catalog import Catalog
    from .events import EventHub
    from .workers import WorkerHub

KNOWN_ACTIONS = {fb.CAPTCHA_IMAGE, fb.CAPTCHA_VIDEO}


class Alerts:
    def __init__(self, db: DB, events: "EventHub"):
        self.db = db
        self.events = events
        self._recent: dict[str, float] = {}

    def raise_(self, kind: str, title: str, detail: str = "", data: Any = None, dedupe: Optional[str] = None,
               window_s: float = 3600) -> None:
        key = dedupe or f"{kind}:{title}"
        t = time.time()
        if t - self._recent.get(key, 0) < window_s:
            return
        self._recent[key] = t
        alert_id = self.db.insert("alerts", {"ts": now(), "kind": kind, "title": title, "detail": detail,
                                             "data": data, "seen": 0})
        self.events.publish("alert", {"id": alert_id, "kind": kind, "title": title})

    def list(self, unseen_only: bool = False, limit: int = 100) -> list[dict]:
        where = "WHERE seen=0" if unseen_only else ""
        return self.db.all(f"SELECT * FROM alerts {where} ORDER BY id DESC LIMIT ?", (limit,))

    def unseen_count(self) -> int:
        return (self.db.one("SELECT COUNT(*) AS n FROM alerts WHERE seen=0") or {"n": 0})["n"]

    def mark_seen(self, alert_id: Optional[int] = None) -> None:
        if alert_id is None:
            self.db.execute("UPDATE alerts SET seen=1")
        else:
            self.db.execute("UPDATE alerts SET seen=1 WHERE id=?", (alert_id,))


class ObservationStore:
    def __init__(self, db: DB, settings: Settings, catalog: "Catalog", events: "EventHub", alerts: Alerts):
        self.db = db
        self.settings = settings
        self.catalog = catalog
        self.events = events
        self.alerts = alerts
        self.hub: Optional["WorkerHub"] = None
        self._pending_responses: dict[str, tuple[str, float]] = {}
        self._last_page_action: dict[Any, tuple[str, float]] = {}
        self._inserts = 0
        for rpcid, name in fb.RPC_NAMES.items():
            self.db.insert("known_rpcs", {"rpcid": rpcid, "name": name, "first_seen": now(), "count": 0},
                           ignore=True)
            self.db.execute("UPDATE known_rpcs SET name=? WHERE rpcid=? AND name IS NULL", (name, rpcid))

    # ── captcha actions ──
    def captcha_action_for(self, rpcid: str) -> Optional[str]:
        row = self.db.one("SELECT captcha_action FROM known_rpcs WHERE rpcid=?", (rpcid,))
        return (row or {}).get("captcha_action") or fb.DEFAULT_CAPTCHA_ACTIONS.get(rpcid)

    # ── ingest ──
    def ingest(self, worker_id: str, entry: dict) -> None:
        if not self.settings.get("observe_enabled"):
            return
        if entry.get("kind") == "recaptcha":
            self._ingest_recaptcha(worker_id, entry)
        else:
            self._ingest_batch(worker_id, entry)
        self._inserts += 1
        if self._inserts % 100 == 0:
            self.prune()

    def _ingest_batch(self, worker_id: str, entry: dict) -> None:
        url = str(entry.get("url") or "")
        parsed = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        params = {k: q.get(k) for k in ("rpcids", "source-path", "bl", "hl", "rt", "_reqid")}
        reqid = params.get("_reqid")
        own = bool(self.hub and reqid and reqid in self.hub.own_reqids)
        rpcs = ob.decode_freq(entry.get("freq"))
        url_rpcids = [x for x in (params.get("rpcids") or "").split(",") if x]
        rpcids = [r["rpcid"] for r in rpcs if r["rpcid"] != "?"] or url_rpcids
        row = {
            "ts": float(entry.get("ts") or time.time() * 1000) / 1000, "worker_id": worker_id,
            "tab_id": entry.get("tab_id"), "kind": "batchexecute", "source": "hub" if own else "page",
            "rpcids": rpcids, "url": url, "path": parsed.path, "params": params,
            "form_keys": entry.get("form_keys") or [], "headers": ob.redact_headers(entry.get("headers")),
            "rpcs": rpcs, "summary": ob.summarize(rpcs), "status": entry.get("status"),
            "duration_ms": entry.get("duration_ms"), "error": entry.get("error"),
            "bl": params.get("bl"), "freq_size": entry.get("freq_size") or len(entry.get("freq") or ""),
            "poll": 1 if rpcids and all(r in fb.POLL_RPCS for r in rpcids) else 0,
        }
        pending = self._pending_responses.pop(url, None)
        if pending:
            row["response"] = ob.decode_response(pending[0])
        if row["source"] == "page":
            row["check_result"] = self._learn(row, entry)
        obs_id = self.db.insert("observations", row)
        self.events.publish("observation", {"id": obs_id, "rpcids": rpcids, "source": row["source"]})

    def _ingest_recaptcha(self, worker_id: str, entry: dict) -> None:
        url = str(entry.get("url") or "")
        parsed = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        strings = ob.recaptcha_strings(entry.get("body_b64"))
        actions = ob.action_candidates(strings)
        ours = entry.get("ours") or None
        ts = float(entry.get("ts") or time.time() * 1000) / 1000
        row = {
            "ts": ts, "worker_id": worker_id, "tab_id": entry.get("tab_id"), "kind": "recaptcha",
            "source": "hub" if ours else "page", "rpcids": ["reCAPTCHA"], "url": url, "path": parsed.path,
            "params": {"k": q.get("k"), "endpoint": parsed.path.rstrip("/").rsplit("/", 1)[-1]},
            "strings": strings, "actions": actions, "requested_action": (ours or {}).get("action"),
            "summary": {"keys": actions, "prompt": None}, "status": entry.get("status"),
            "duration_ms": entry.get("duration_ms"), "error": entry.get("error"), "poll": 0,
        }
        if not ours and actions:
            self._last_page_action[entry.get("tab_id")] = (actions[0], ts)
            for action in actions:
                if action not in KNOWN_ACTIONS:
                    self.alerts.raise_("captcha_action", f"Trang dùng action reCAPTCHA mới: {action}",
                                       "Flow có thể đã đổi action cho một RPC; xem Observation.",
                                       {"action": action}, dedupe=f"captcha:{action}", window_s=86400)
        obs_id = self.db.insert("observations", row)
        self.events.publish("observation", {"id": obs_id, "rpcids": ["reCAPTCHA"], "source": row["source"]})

    def attach_response(self, url: str, text: str) -> None:
        if not url:
            return
        row = self.db.one("SELECT id FROM observations WHERE url=? ORDER BY id DESC LIMIT 1", (url,))
        if row is None:
            self._pending_responses[url] = (text, time.time())
            cutoff = time.time() - 120
            for key, (_, ts) in list(self._pending_responses.items()):
                if ts < cutoff:
                    del self._pending_responses[key]
            return
        self.db.update("observations", "id", row["id"], {"response": ob.decode_response(text)})
        self.events.publish("observation", {"id": row["id"], "response": True})

    # ── learning from the page's own calls ──
    def _learn(self, row: dict, entry: dict) -> Optional[list]:
        build = row.get("bl")
        last = self.settings.get("last_build")
        if build and build != last:
            if last:
                self.alerts.raise_("build", f"Flow đổi build: {build}", f"Trước đó: {last}",
                                   {"from": last, "to": build}, dedupe=f"build:{build}", window_s=10 ** 9)
            self.settings.set("last_build", build)

        checks = []
        t = now()
        for rpc in row["rpcs"]:
            rpcid = rpc["rpcid"]
            known = self.db.one("SELECT * FROM known_rpcs WHERE rpcid=?", (rpcid,))
            if known is None:
                self.db.insert("known_rpcs", {"rpcid": rpcid, "name": None, "first_seen": t, "last_seen": t,
                                              "count": 1}, ignore=True)
                self.alerts.raise_("rpc_new", f"RPC mới: {rpcid}",
                                   f"Trang gọi RPC chưa biết (source-path {row['params'].get('source-path')}).",
                                   {"rpcid": rpcid}, dedupe=f"rpc:{rpcid}", window_s=10 ** 9)
            else:
                self.db.execute("UPDATE known_rpcs SET last_seen=?, count=count+1 WHERE rpcid=?", (t, rpcid))
            inner = rpc.get("inner")
            if inner is None:
                # cut short or undecodable (an upload before extension 1.0.2): the captcha still counts
                if ob.raw_carries_captcha(rpc.get("raw")):
                    self._learn_captcha(rpcid, known, row, entry)
                continue

            for use in ob.model_uses(rpcid, inner):
                outcome = self.catalog.observe(use["mode"], use["key"], use["aspect"])
                if outcome == "new":
                    self.alerts.raise_("model_new", f"Model mới: {use['key']}",
                                       f"Trang dùng {use['key']} ({use['mode']}); đã thêm vào Models.",
                                       use, dedupe=f"model:{use['mode']}:{use['key']}", window_s=10 ** 9)
                elif outcome == "verified":
                    self.alerts.raise_("model_verified", f"Đã xác minh model: {use['key']}",
                                       "Trước đây chưa xác minh, giờ đã thấy trang dùng.", use,
                                       dedupe=f"verified:{use['key']}", window_s=10 ** 9)

            if ob.carries_captcha(inner):
                self._learn_captcha(rpcid, known, row, entry)

            if rpcid in ob.BUILT_RPCS:
                result = ob.builder_check(rpcid, inner)
                result.pop("built", None)
                checks.append({"rpcid": rpcid, **result})
                if result.get("supported") and not result.get("ok"):
                    first = (result.get("diffs") or [{}])[0]
                    self.alerts.raise_("builder_drift", f"Builder lệch với trang: {rpcid}",
                                       f"Khác ở {first.get('path')}: trang={first.get('observed')!r} "
                                       f"hub={first.get('built')!r}", result,
                                       dedupe=f"drift:{rpcid}:{first.get('path')}")
        return checks or None

    def _learn_captcha(self, rpcid: str, known: Optional[dict], row: dict, entry: dict) -> None:
        """The action of the page's latest reCAPTCHA mint (within 8 s) is the one this RPC uses."""
        last_action = self._last_page_action.get(entry.get("tab_id"))
        if not last_action or row["ts"] - last_action[1] >= 8:
            return
        action = last_action[0]
        current = (known or {}).get("captcha_action") or fb.DEFAULT_CAPTCHA_ACTIONS.get(rpcid)
        self.db.execute("UPDATE known_rpcs SET captcha_action=? WHERE rpcid=?", (action, rpcid))
        if current and current != action:
            self.alerts.raise_("captcha_action", f"{rpcid} giờ dùng action {action}",
                               f"Trước đó {current}; Flow Hub sẽ dùng action mới.",
                               {"rpcid": rpcid, "from": current, "to": action},
                               dedupe=f"captcha:{rpcid}:{action}", window_s=10 ** 9)

    # ── queries ──
    LIST_COLUMNS = ("id, ts, worker_id, tab_id, kind, source, rpcids, path, params, summary, status, duration_ms, "
                    "error, actions, requested_action, bl, freq_size, check_result, poll, "
                    "CASE WHEN response IS NULL THEN 0 ELSE 1 END AS has_response")

    def list(self, *, rpcid: Optional[str] = None, source: Optional[str] = None, kind: Optional[str] = None,
             q: Optional[str] = None, hide_polls: bool = False, before_id: Optional[int] = None,
             limit: int = 200) -> list[dict]:
        where, args = [], []
        if rpcid:
            where.append("rpcids LIKE ?")
            args.append(f'%"{rpcid}"%')
        if source:
            where.append("source=?")
            args.append(source)
        if kind:
            where.append("kind=?")
            args.append(kind)
        if hide_polls:
            where.append("poll=0")
        if before_id:
            where.append("id<?")
            args.append(before_id)
        if q:
            where.append("(rpcs LIKE ? OR summary LIKE ? OR strings LIKE ? OR params LIKE ?)")
            args.extend([f"%{q}%"] * 4)
        sql = f"SELECT {self.LIST_COLUMNS} FROM observations"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(min(max(limit, 1), 1000))
        return self.db.all(sql, args)

    def get(self, obs_id: int) -> Optional[dict]:
        return self.db.one("SELECT * FROM observations WHERE id=?", (obs_id,))

    def rpc_counts(self) -> list[dict]:
        return self.db.all("SELECT * FROM known_rpcs ORDER BY count DESC, rpcid")

    def clear(self) -> None:
        self.db.execute("DELETE FROM observations")

    def prune(self) -> None:
        keep = int(self.settings.get("max_observations") or 5000)
        row = self.db.one("SELECT MAX(id) AS m FROM observations")
        if row and row["m"]:
            self.db.execute("DELETE FROM observations WHERE id <= ?", (row["m"] - keep,))
