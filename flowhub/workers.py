"""The WebSocket gateway to browser workers (the Flow Hub extension).

A worker is one Chrome profile with a signed-in flow.google.com tab. It dials
in to /ws/worker?token=…, says hello, and from then on:

  server → worker   {"type":"rpc", id, rpcid, freq, captcha_action, match (str | [str]), reqid}
                    {"type":"fetch", id, url}            (media bytes fallback)
                    {"type":"config", observe:{enabled, responses}}
  worker → server   {"type":"rpc_result", id, status, text | error, matched}
                    {"type":"fetch_result", id, b64, mime | error}
                    {"type":"status", flow:{tabs, projects}, stats}
                    {"type":"observe", entry:{…}}  /  {"type":"observe_response", url, text}

The worker never decides anything; it runs what it is told inside the page and
reports what it sees. All state lives here, so a worker reconnecting mid-job
loses nothing but the in-flight call.
"""
from __future__ import annotations

import asyncio
import logging
import random
import secrets
import time
import uuid
from typing import TYPE_CHECKING, Any, Optional

from fastapi import WebSocket, WebSocketDisconnect

from .db import DB, now

if TYPE_CHECKING:
    from .events import EventHub
    from .observations import ObservationStore

log = logging.getLogger("flowhub.workers")


class Worker:
    def __init__(self, worker_id: str, ws: WebSocket, hello: dict):
        self.id = worker_id
        self.ws = ws
        self.label = hello.get("label") or worker_id[:8]
        self.version = hello.get("version")
        self.flow: dict = hello.get("flow") or {}
        self.stats: dict = {}
        self.connected_at = now()
        self.last_seen = now()
        self.pending: dict[str, asyncio.Future] = {}
        self._send_lock = asyncio.Lock()
        self._pace_lock = asyncio.Lock()
        self._last_submit = 0.0
        self.active_calls = 0

    def public(self) -> dict:
        return {"id": self.id, "label": self.label, "version": self.version, "online": True,
                "flow": self.flow, "stats": self.stats, "connected_at": self.connected_at,
                "last_seen": self.last_seen, "active_calls": self.active_calls}

    @property
    def projects(self) -> list[str]:
        return [p.get("projectId") for p in self.flow.get("projects") or [] if p.get("projectId")]

    async def send(self, message: dict) -> None:
        async with self._send_lock:
            await self.ws.send_json(message)

    async def call(self, message: dict, timeout: float) -> dict:
        """Send a command and wait for its result (never raises: errors come back as {'error'})."""
        call_id = uuid.uuid4().hex
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[call_id] = future
        self.active_calls += 1
        try:
            await self.send({**message, "id": call_id})
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            return {"error": f"TIMEOUT after {int(timeout)}s"}
        except Exception as exc:  # noqa: BLE001 — socket gone mid-send
            return {"error": f"WORKER_SEND_FAILED: {exc}"}
        finally:
            self.pending.pop(call_id, None)
            self.active_calls -= 1

    def resolve(self, message: dict) -> None:
        future = self.pending.get(message.get("id") or "")
        if future and not future.done():
            future.set_result(message)

    def fail_all(self, reason: str) -> None:
        for future in self.pending.values():
            if not future.done():
                future.set_result({"error": reason})

    async def pace(self, gap_s: float) -> None:
        """Space out generate submits: Flow's UI never fires them back to back."""
        async with self._pace_lock:
            wait = self._last_submit + gap_s + random.uniform(0, 0.6) - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_submit = time.monotonic()


class WorkerHub:
    def __init__(self, db: DB, events: "EventHub", token: str):
        self.db = db
        self.events = events
        self.token = token
        self.workers: dict[str, Worker] = {}
        self.observations: Optional["ObservationStore"] = None
        self._online = asyncio.Event()
        #: _reqid values the server minted, so Observation can tell its own calls apart
        self.own_reqids: dict[str, float] = {}
        self.config_provider = lambda: {}
        self.on_debugger_detached = lambda worker: None

    # ── worker selection ──
    def online(self) -> list[Worker]:
        return list(self.workers.values())

    def pick(self, worker_id: Optional[str] = None) -> Optional[Worker]:
        if worker_id:
            return self.workers.get(worker_id)
        live = [w for w in self.workers.values() if (w.flow.get("tabs") or 0) > 0] or list(self.workers.values())
        return min(live, key=lambda w: w.active_calls) if live else None

    async def wait_for(self, worker_id: Optional[str], timeout: float) -> Optional[Worker]:
        deadline = time.monotonic() + timeout
        while True:
            worker = self.pick(worker_id)
            if worker:
                return worker
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self._online.clear()
            try:
                await asyncio.wait_for(self._online.wait(), timeout=min(remaining, 5))
            except asyncio.TimeoutError:
                pass

    def new_reqid(self) -> int:
        reqid = random.randint(100000, 999999)
        t = time.time()
        self.own_reqids[str(reqid)] = t
        if len(self.own_reqids) > 2000:
            for key, ts in list(self.own_reqids.items()):
                if t - ts > 600:
                    del self.own_reqids[key]
        return reqid

    def all_workers(self) -> list[dict]:
        rows = {r["id"]: r for r in self.db.all("SELECT * FROM workers ORDER BY last_seen DESC")}
        out = []
        for worker in self.workers.values():
            out.append(worker.public())
            rows.pop(worker.id, None)
        for row in rows.values():
            out.append({"id": row["id"], "label": row["label"], "version": row["version"], "online": False,
                        "flow": (row.get("info") or {}).get("flow") or {}, "last_seen": row["last_seen"]})
        return out

    async def broadcast_config(self) -> None:
        for worker in list(self.workers.values()):
            try:
                await worker.send({"type": "config", **self.config_provider()})
            except Exception:  # noqa: BLE001
                pass

    # ── the socket ──
    async def handle(self, ws: WebSocket) -> None:
        token = ws.query_params.get("token", "")
        if not self.token or not secrets.compare_digest(token, self.token):
            await ws.close(code=4401, reason="bad token")
            return
        await ws.accept()
        worker: Optional[Worker] = None
        try:
            while True:
                message = await ws.receive_json()
                kind = message.get("type")
                if kind == "hello":
                    worker = self._register(ws, message)
                    await worker.send({"type": "welcome", "worker_id": worker.id})
                    await worker.send({"type": "config", **self.config_provider()})
                    continue
                if worker is None:
                    continue
                worker.last_seen = now()
                if kind in ("rpc_result", "fetch_result"):
                    worker.resolve(message)
                elif kind == "status":
                    worker.flow = message.get("flow") or worker.flow
                    worker.stats = message.get("stats") or worker.stats
                    self._persist(worker)
                    self.events.publish("worker", worker.public())
                elif kind == "observe" and self.observations is not None:
                    self.observations.ingest(worker.id, message.get("entry") or {})
                elif kind == "observe_response" and self.observations is not None:
                    self.observations.attach_response(message.get("url") or "", message.get("text") or "")
                elif kind == "debugger_detached":
                    self.on_debugger_detached(worker)
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001 — a broken frame must not kill the server
            log.warning("worker socket error: %s", exc)
        finally:
            if worker is not None and self.workers.get(worker.id) is worker:
                del self.workers[worker.id]
                worker.fail_all("WORKER_DISCONNECTED")
                self._persist(worker)
                self.events.publish("worker", {**worker.public(), "online": False})
                log.info("worker %s disconnected", worker.label)

    def _register(self, ws: WebSocket, hello: dict) -> Worker:
        worker_id = str(hello.get("worker_id") or uuid.uuid4())
        old = self.workers.get(worker_id)
        if old is not None:
            old.fail_all("WORKER_RECONNECTED")
        worker = Worker(worker_id, ws, hello)
        self.workers[worker_id] = worker
        existing = self.db.one("SELECT first_seen FROM workers WHERE id=?", (worker_id,))
        self.db.insert("workers", {"id": worker_id, "label": worker.label, "version": worker.version,
                                   "first_seen": existing["first_seen"] if existing else now(),
                                   "last_seen": now(), "info": {"flow": worker.flow}}, replace=True)
        self._online.set()
        self.events.publish("worker", worker.public())
        log.info("worker %s connected (v%s, %s Flow tab)", worker.label, worker.version, worker.flow.get("tabs"))
        return worker

    def _persist(self, worker: Worker) -> None:
        self.db.update("workers", "id", worker.id, {"last_seen": now(), "label": worker.label,
                                                    "info": {"flow": worker.flow, "stats": worker.stats}})

    # ── convenience used by the engine ──
    async def rpc(self, worker: Worker, rpcid: str, freq: str, captcha_action: Optional[str] = None,
                  match: Optional[str | list[str]] = None, timeout: float = 300) -> tuple[int, dict]:
        reqid = self.new_reqid()
        result = await worker.call({"type": "rpc", "rpcid": rpcid, "freq": freq, "captcha_action": captcha_action,
                                    "match": match, "reqid": reqid}, timeout)
        return reqid, result

    async def fetch(self, worker: Worker, url: str, timeout: float = 180) -> dict:
        return await worker.call({"type": "fetch", "url": url}, timeout)
