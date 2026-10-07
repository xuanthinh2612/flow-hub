"""Process configuration, from environment variables (or a `.env` next to the project).

    FLOWHUB_HOST=127.0.0.1        bind address (0.0.0.0 to reach it from other machines)
    FLOWHUB_PORT=8787
    FLOWHUB_DATA_DIR=./data       SQLite file + downloaded media
    FLOWHUB_WORKER_TOKEN=...      token the extension pairs with (generated if empty)
    FLOWHUB_API_KEY=...           key other servers / the dashboard send as X-API-Key
    FLOWHUB_AUTH=auto             auto | on | off — auto = on unless bound to localhost

Runtime-tunable options (project id, observation, polling…) live in the
database and are edited from the dashboard instead.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
VERSION = "1.0.0"


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass
class Config:
    host: str
    port: int
    data_dir: Path
    worker_token: str
    api_key: str
    auth: str

    @property
    def db_path(self) -> Path:
        return self.data_dir / "flowhub.sqlite3"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def auth_enabled(self) -> bool:
        if self.auth == "on":
            return True
        if self.auth == "off":
            return False
        return self.host not in ("127.0.0.1", "localhost", "::1")


def load_config() -> Config:
    _load_dotenv(BASE_DIR / ".env")
    data_dir = Path(os.environ.get("FLOWHUB_DATA_DIR") or BASE_DIR / "data")
    if not data_dir.is_absolute():
        data_dir = (BASE_DIR / data_dir).resolve()
    return Config(
        host=os.environ.get("FLOWHUB_HOST", "127.0.0.1"),
        port=int(os.environ.get("FLOWHUB_PORT", "8787")),
        data_dir=data_dir,
        worker_token=os.environ.get("FLOWHUB_WORKER_TOKEN", ""),
        api_key=os.environ.get("FLOWHUB_API_KEY", ""),
        auth=os.environ.get("FLOWHUB_AUTH", "auto").lower(),
    )
