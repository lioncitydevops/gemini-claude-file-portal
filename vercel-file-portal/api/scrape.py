"""Vercel Python serverless function — web scraper using Scrapling."""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler

MAX_CONTENT_CHARS = 12_000


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", 0))
            body: dict = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._respond(400, {"error": "Invalid request body."})
            return

        url = (body.get("url") or "").strip()
        selector = (body.get("selector") or "").strip()

        if not url:
            self._respond(400, {"error": "URL is required."})
            return

        try:
            content = _scrape(url, selector)
            self._respond(200, {"content": content, "url": url})
        except Exception as exc:
            self._respond(500, {"error": str(exc)})

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def _respond(self, status: int, data: dict) -> None:
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(payload)

    def _cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


def _scrape(url: str, selector: str = "") -> str:
    from scrapling.fetchers import Fetcher  # type: ignore[import]

    page = Fetcher.fetch(url, stealthy_headers=True)

    if selector:
        elements = page.css(selector)
        text = "\n".join(el.text.strip() for el in elements if el.text and el.text.strip())
    else:
        body_els = page.css("body")
        text = body_els[0].text.strip() if body_els else ""

    return text[:MAX_CONTENT_CHARS] or "(no content extracted)"
