"""`python -m flowhub` — start the server."""
import logging

import uvicorn

from .config import load_config
from .main import create_app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load_config()
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="info",
                ws_max_size=128 * 1024 * 1024)   # media bytes may come back over the worker socket


if __name__ == "__main__":
    main()
