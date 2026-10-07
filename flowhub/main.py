"""Application factory: wires the components and mounts API, worker socket and dashboard."""
from __future__ import annotations

import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from .catalog import Catalog
from .config import VERSION, Config, load_config
from .db import DB, Settings
from .events import EventHub
from .jobs import JobEngine
from .media import MediaStore
from .observations import Alerts, ObservationStore
from .templates import TemplateStore
from .workers import WorkerHub

log = logging.getLogger("flowhub")
WEB_DIR = Path(__file__).parent / "web"


class Core:
    """Every long-lived component, reachable from routes as request.app.state.core."""

    def __init__(self, config: Config):
        self.config = config
        self.db = DB(config.db_path)
        self.settings = Settings(self.db)
        self.worker_token = config.worker_token or self._secret("worker_token")
        self.api_key = config.api_key or self._secret("api_key")
        self.events = EventHub()
        self.catalog = Catalog(self.db)
        self.catalog.seed()
        self.alerts = Alerts(self.db, self.events)
        self.observations = ObservationStore(self.db, self.settings, self.catalog, self.events, self.alerts)
        self.hub = WorkerHub(self.db, self.events, self.worker_token)
        self.hub.observations = self.observations
        self.observations.hub = self.hub
        self.hub.config_provider = self.worker_config
        self.hub.on_debugger_detached = self._debugger_detached
        self.media = MediaStore(self.db, config.media_dir, self.events, self.hub)
        self.templates = TemplateStore(self.db, self.observations)
        self.jobs = JobEngine(self.db, self.settings, self.catalog, self.hub, self.media, self.events,
                              self.observations, self.templates)

    def _secret(self, key: str) -> str:
        value = self.settings.get(key)
        if not value:
            value = secrets.token_urlsafe(24)
            self.settings.set(key, value)
        return value

    def rotate_worker_token(self) -> str:
        self.worker_token = secrets.token_urlsafe(24)
        self.settings.set("worker_token", self.worker_token)
        self.hub.token = self.worker_token
        return self.worker_token

    def worker_config(self) -> dict:
        return {"observe": {"enabled": bool(self.settings.get("observe_enabled")),
                            "responses": bool(self.settings.get("observe_responses"))}}

    def _debugger_detached(self, worker) -> None:
        if self.settings.get("observe_responses"):
            self.settings.set("observe_responses", False)
            self.alerts.raise_("observe", "Đã tắt ghi response",
                               f"Thanh 'đang debug' trên worker {worker.label} bị đóng.")

    def ws_url(self, host_header: Optional[str] = None) -> str:
        host = host_header or f"{self.config.host}:{self.config.port}"
        return f"ws://{host}/ws/worker"


def create_app(config: Optional[Config] = None) -> FastAPI:
    config = config or load_config()
    core = Core(config)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await core.jobs.startup()
        log.info("Flow Hub %s on http://%s:%s  (auth %s)", VERSION, config.host, config.port,
                 "on" if config.auth_enabled else "off")
        log.info("Worker pairing: %s  token=%s", core.ws_url(), core.worker_token)
        if config.auth_enabled:
            log.info("API key: %s", core.api_key)
        yield
        await core.jobs.shutdown()

    app = FastAPI(title="Flow Hub", version=VERSION, lifespan=lifespan,
                  description="Mini server điều khiển Google Flow qua extension worker: tạo ảnh / video, "
                              "quản lý job, quan sát toàn bộ request của trang Flow.")
    app.state.core = core

    from .api import router
    app.include_router(router)

    @app.websocket("/ws/worker")
    async def worker_socket(ws: WebSocket):
        await core.hub.handle(ws)

    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
    return app
