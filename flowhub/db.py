"""SQLite storage: one file, one connection, JSON columns as TEXT.

The app is a single asyncio process and every statement here is short, so a
plain sqlite3 connection behind a lock is enough — no ORM, no pool.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY, label TEXT, version TEXT, first_seen REAL, last_seen REAL, info TEXT);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, type TEXT, status TEXT, spec TEXT, model TEXT, prompt TEXT, worker_id TEXT,
  error TEXT, warnings TEXT, ops TEXT, results TEXT, note TEXT,
  created_at REAL, updated_at REAL, finished_at REAL, poll_started_at REAL, timeout_s REAL);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);

CREATE TABLE IF NOT EXISTS rpc_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, worker_id TEXT, rpcid TEXT, captcha_action TEXT,
  reqid INTEGER, body TEXT, status INTEGER, response TEXT, error TEXT, started_at REAL, duration_ms INTEGER);
CREATE INDEX IF NOT EXISTS rpc_log_job ON rpc_log(job_id);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, kind TEXT, url TEXT, poster_url TEXT, url_at REAL, local_path TEXT, mime TEXT,
  size INTEGER, prompt TEXT, model TEXT, source TEXT, job_id TEXT, project_id TEXT, aspect TEXT,
  created_at REAL, note TEXT);
CREATE INDEX IF NOT EXISTS media_created ON media(created_at);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, worker_id TEXT, tab_id INTEGER, kind TEXT, source TEXT,
  rpcids TEXT, url TEXT, path TEXT, params TEXT, form_keys TEXT, headers TEXT, rpcs TEXT, summary TEXT,
  status INTEGER, duration_ms INTEGER, error TEXT, response TEXT, strings TEXT, actions TEXT,
  requested_action TEXT, bl TEXT, freq_size INTEGER, check_result TEXT, poll INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS obs_ts ON observations(ts);
CREATE INDEX IF NOT EXISTS obs_url ON observations(url);

CREATE TABLE IF NOT EXISTS known_rpcs (
  rpcid TEXT PRIMARY KEY, name TEXT, first_seen REAL, last_seen REAL, count INTEGER DEFAULT 0,
  captcha_action TEXT, ignored INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT, family TEXT, family_label TEXT, key TEXT,
  aspect TEXT, duration INTEGER, resolution TEXT, status TEXT, source TEXT, note TEXT,
  is_default INTEGER DEFAULT 0, sort INTEGER DEFAULT 100, first_seen REAL, last_seen REAL,
  UNIQUE(mode, key));

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, kind TEXT, title TEXT, detail TEXT, data TEXT,
  seen INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, rpcid TEXT, captcha_action TEXT, inner TEXT,
  variables TEXT, result_kind TEXT, observation_id INTEGER, note TEXT, created_at REAL, updated_at REAL);
"""

#: Columns stored as JSON text and decoded on the way out.
JSON_COLUMNS = {"info", "spec", "warnings", "ops", "results", "params", "form_keys", "headers", "rpcs",
                "summary", "response", "strings", "actions", "data", "inner", "variables", "check_result",
                "rpcids"}


def _encode(key: str, value: Any) -> Any:
    if key in JSON_COLUMNS and value is not None and not isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return value


def _decode_row(row: sqlite3.Row) -> dict:
    out = {}
    for key in row.keys():
        value = row[key]
        if key in JSON_COLUMNS and isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        out[key] = value
    return out


class DB:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, tuple(params))

    def all(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            return [_decode_row(r) for r in self._conn.execute(sql, tuple(params)).fetchall()]

    def one(self, sql: str, params: Iterable[Any] = ()) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(sql, tuple(params)).fetchone()
            return _decode_row(row) if row else None

    def insert(self, table: str, values: dict, *, replace: bool = False, ignore: bool = False) -> int:
        verb = "INSERT OR REPLACE" if replace else ("INSERT OR IGNORE" if ignore else "INSERT")
        cols = list(values)
        sql = f"{verb} INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})"
        with self._lock:
            cur = self._conn.execute(sql, [_encode(k, values[k]) for k in cols])
            return cur.lastrowid

    def update(self, table: str, key_col: str, key: Any, values: dict) -> None:
        if not values:
            return
        sets = ",".join(f"{k}=?" for k in values)
        with self._lock:
            self._conn.execute(f"UPDATE {table} SET {sets} WHERE {key_col}=?",
                               [_encode(k, v) for k, v in values.items()] + [key])


class Settings:
    """Key/value options editable from the dashboard (stored as JSON)."""

    DEFAULTS: dict[str, Any] = {
        "project_id": "",
        "observe_enabled": True,
        "observe_responses": False,
        "download_media": True,
        "poll_interval_s": 5,
        "min_submit_gap_s": 2,
        "job_timeout_min": 10,
        "wait_worker_s": 120,
        "max_observations": 5000,
        "last_build": "",
    }

    def __init__(self, db: DB):
        self.db = db

    def get(self, key: str) -> Any:
        row = self.db.one("SELECT value FROM settings WHERE key=?", (key,))
        if row is None:
            return self.DEFAULTS.get(key)
        try:
            return json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            return row["value"]

    def set(self, key: str, value: Any) -> None:
        self.db.insert("settings", {"key": key, "value": json.dumps(value, ensure_ascii=False)}, replace=True)

    def all(self) -> dict:
        out = dict(self.DEFAULTS)
        for row in self.db.all("SELECT key, value FROM settings"):
            try:
                out[row["key"]] = json.loads(row["value"])
            except (TypeError, json.JSONDecodeError):
                out[row["key"]] = row["value"]
        return out


def now() -> float:
    return time.time()
