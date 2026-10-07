"""Media records and the local copies Flow Hub keeps of them.

Flow hands back signed CDN urls that expire, so finished media is downloaded
into data/media/. The server tries the url itself first; if Flow wants the
browser session for it, the worker fetches the bytes and ships them over.
"""
from __future__ import annotations

import base64
import logging
import mimetypes
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import httpx

from .db import DB, now

if TYPE_CHECKING:
    from .events import EventHub
    from .workers import WorkerHub

log = logging.getLogger("flowhub.media")

EXT_BY_MIME = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
               "video/mp4": ".mp4", "video/webm": ".webm"}


def sniff_mime(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:3] == b"GIF":
        return "image/gif"
    if data[4:8] == b"ftyp":
        return "video/mp4"
    if data[:4] == b"\x1aE\xdf\xa3":
        return "video/webm"
    return "application/octet-stream"


class MediaStore:
    def __init__(self, db: DB, media_dir: Path, events: "EventHub", hub: "WorkerHub"):
        self.db = db
        self.dir = media_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.events = events
        self.hub = hub
        self._downloading: set[str] = set()

    def upsert(self, item: dict) -> dict:
        existing = self.get(item["id"])
        if existing is None:
            row = {"created_at": now(), "url_at": now() if item.get("url") else None, **item}
            self.db.insert("media", row)
        else:
            changes = {k: v for k, v in item.items() if v is not None and k != "id"}
            if item.get("url"):
                changes["url_at"] = now()
            self.db.update("media", "id", item["id"], changes)
        row = self.get(item["id"])
        self.events.publish("media", {"id": item["id"]})
        return row

    def get(self, media_id: str) -> Optional[dict]:
        return self.db.one("SELECT * FROM media WHERE id=?", (media_id,))

    def list(self, kind: Optional[str] = None, source: Optional[str] = None, limit: int = 200,
             offset: int = 0) -> list[dict]:
        where, args = [], []
        if kind:
            where.append("kind=?")
            args.append(kind)
        if source:
            where.append("source=?")
            args.append(source)
        sql = "SELECT * FROM media" + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        return self.db.all(sql, args + [limit, offset])

    def delete(self, media_id: str) -> None:
        row = self.get(media_id)
        if row and row.get("local_path"):
            try:
                Path(row["local_path"]).unlink(missing_ok=True)
            except OSError:
                pass
        self.db.execute("DELETE FROM media WHERE id=?", (media_id,))

    def local_file(self, media_id: str) -> Optional[Path]:
        row = self.get(media_id)
        if row and row.get("local_path") and Path(row["local_path"]).is_file():
            return Path(row["local_path"])
        return None

    def save_bytes(self, media_id: str, data: bytes, mime: Optional[str] = None) -> Path:
        mime = mime if mime and mime != "application/octet-stream" else sniff_mime(data)
        ext = EXT_BY_MIME.get(mime) or mimetypes.guess_extension(mime) or ".bin"
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in media_id)
        path = self.dir / f"{safe}{ext}"
        path.write_bytes(data)
        self.db.update("media", "id", media_id, {"local_path": str(path), "mime": mime, "size": len(data)})
        self.events.publish("media", {"id": media_id, "local": True})
        return path

    async def download(self, media_id: str) -> Optional[Path]:
        """Keep a local copy. Best effort: a failure leaves the remote url in place."""
        if media_id in self._downloading or self.local_file(media_id):
            return self.local_file(media_id)
        row = self.get(media_id)
        url = (row or {}).get("url")
        if not url:
            return None
        self._downloading.add(media_id)
        try:
            try:
                async with httpx.AsyncClient(timeout=180, follow_redirects=True) as client:
                    resp = await client.get(url)
                if resp.status_code == 200 and resp.content:
                    mime = resp.headers.get("content-type", "").split(";")[0].strip() or None
                    return self.save_bytes(media_id, resp.content, mime)
                log.info("direct download of %s answered %s; asking a worker", media_id, resp.status_code)
            except httpx.HTTPError as exc:
                log.info("direct download of %s failed (%s); asking a worker", media_id, exc)
            worker = self.hub.pick()
            if worker is None:
                return None
            result = await self.hub.fetch(worker, url)
            if result.get("b64"):
                return self.save_bytes(media_id, base64.b64decode(result["b64"]), result.get("mime"))
            log.warning("worker could not fetch %s: %s", media_id, result.get("error"))
            return None
        finally:
            self._downloading.discard(media_id)
