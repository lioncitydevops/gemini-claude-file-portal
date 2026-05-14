"""Local web portal for documents + Gemini/Claude prompt workflows."""

from __future__ import annotations

import argparse
import html
import mimetypes
import shutil
import socketserver
import subprocess
from datetime import datetime
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

MAX_SCRAPE_CHARS = 12_000


DEFAULT_ALLOWED_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".txt",
    ".ppt",
    ".pptx",
}


def _safe_filename(raw_name: str) -> str:
    base_name = Path(raw_name).name.strip()
    cleaned = base_name.replace("/", "_").replace("\\", "_")
    return cleaned or "uploaded_file"


def _format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.2f} MB"


class FilePortalHandler(BaseHTTPRequestHandler):
    server: "FilePortalServer"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._serve_home()
            return
        if parsed.path == "/download":
            self._serve_download(parsed.query)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Route not found.")

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/upload":
            self._handle_upload()
            return
        if self.path == "/delete":
            self._handle_delete()
            return
        if self.path == "/ai":
            self._handle_ai()
            return
        if self.path == "/scrape":
            self._handle_scrape()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Route not found.")

    def _serve_home(
        self,
        message: str = "",
        is_error: bool = False,
        ai_result: str = "",
        ai_mode: str = "debate",
        ai_prompt: str = "",
        ai_error: bool = False,
        scrape_result: str = "",
        scrape_url: str = "",
        scrape_error: bool = False,
    ) -> None:
        history_rows = []
        for entry in reversed(self.server.chat_history[-20:]):
            history_rows.append(
                "<tr>"
                f"<td>{html.escape(entry['time'])}</td>"
                f"<td>{html.escape(entry['mode'])}</td>"
                f"<td>{html.escape(entry['prompt_preview'])}</td>"
                f"<td><a href='/download?name={quote(entry['file_name'])}'>Download .md</a></td>"
                "</tr>"
            )
        history_table = (
            "".join(history_rows)
            if history_rows
            else "<tr><td colspan='4'>No AI runs yet.</td></tr>"
        )

        rows = []
        for item in sorted(self.server.upload_dir.iterdir(), key=lambda p: p.name.lower()):
            if not item.is_file():
                continue
            name = item.name
            size = _format_size(item.stat().st_size)
            href = f"/download?name={quote(name)}"
            rows.append(
                f"<tr><td>{html.escape(name)}</td><td>{html.escape(size)}</td><td>"
                f"<a href='{href}'>Download</a> "
                f"<form action='/delete' method='post' style='display:inline'>"
                f"<input type='hidden' name='name' value='{html.escape(name)}' />"
                "<button type='submit' onclick=\"return confirm('Delete this file?');\">Delete</button>"
                "</form></td></tr>"
            )
        table_rows = "".join(rows) if rows else "<tr><td colspan='3'>No files uploaded yet.</td></tr>"

        alert = ""
        if message:
            css_class = "error" if is_error else "ok"
            alert = f"<p class='{css_class}'>{html.escape(message)}</p>"

        ai_alert = ""
        if ai_result:
            ai_class = "error" if ai_error else "ok"
            ai_alert = (
                f"<h3>AI Result</h3><p class='{ai_class}'>Mode: {html.escape(ai_mode)}</p>"
                "<pre style='white-space: pre-wrap; background: #f7f7f7; border: 1px solid #ddd; padding: 10px;'>"
                f"{html.escape(ai_result)}</pre>"
            )

        scrape_section = ""
        if scrape_result:
            scrape_class = "error" if scrape_error else "ok"
            escaped_content = html.escape(scrape_result)
            # Use a data attribute so the JS button can copy it without XSS risk
            scrape_section = (
                f"<h3>Scrape Result</h3>"
                f"<p class='{scrape_class}'>Source: {html.escape(scrape_url)}</p>"
                "<pre id='scrape-result' style='white-space: pre-wrap; background: #f7f7f7; border: 1px solid #ddd; "
                f"padding: 10px; max-height: 300px; overflow-y: auto;'>{escaped_content}</pre>"
                "<button type='button' onclick=\"document.getElementById('prompt').value = "
                "document.getElementById('scrape-result').textContent;\" "
                "style='margin-top:8px;'>Send to AI Prompt</button>"
            )

        extensions = ", ".join(sorted(self.server.allowed_extensions))
        body = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Gemini Claude File Portal</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; }}
    .card {{ max-width: 980px; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 12px; }}
    th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
    th {{ background: #f3f3f3; }}
    .ok {{ color: #0a7d24; }}
    .error {{ color: #b00020; }}
    .meta {{ color: #555; font-size: 0.95rem; }}
    .dropzone {{ border: 2px dashed #aaa; border-radius: 8px; padding: 20px; margin: 10px 0; background: #fafafa; }}
    .dropzone.dragover {{ border-color: #0a66c2; background: #eef6ff; }}
    .two-col {{ display: grid; grid-template-columns: 1fr; gap: 20px; }}
  </style>
</head>
<body>
  <div class="card">
    <h2>Document + AI Portal</h2>
    <p class="meta">Allowed extensions: {html.escape(extensions)}</p>
    {alert}
    <form action="/upload" method="post" enctype="multipart/form-data">
      <div id="dropzone" class="dropzone">Drag and drop files here, or use file picker</div>
      <input id="file-input" type="file" name="file" multiple required />
      <p class="meta" id="file-count">No files selected</p>
      <button type="submit">Upload</button>
    </form>

    <h3>Web Scraper</h3>
    <p class="meta">Fetch and extract text from any public URL. Optionally target elements with a CSS selector.</p>
    <form action="/scrape" method="post">
      <label for="scrape_url">URL</label><br />
      <input type="url" id="scrape_url" name="url" required
        style="width:100%; padding:8px; margin:4px 0 12px; border:1px solid #ddd; border-radius:4px; font-size:1rem;"
        placeholder="https://example.com" /><br />
      <label for="scrape_selector">CSS Selector <span class="meta">(optional — e.g. article, .content, h1)</span></label><br />
      <input type="text" id="scrape_selector" name="selector"
        style="width:100%; padding:8px; margin:4px 0 12px; border:1px solid #ddd; border-radius:4px; font-size:1rem;"
        placeholder="Leave blank to extract all body text" /><br />
      <button type="submit">Scrape</button>
    </form>
    {scrape_section}

    <h3>AI Prompt</h3>
    <form action="/ai" method="post">
      <label for="mode">Mode</label>
      <select id="mode" name="mode">
        <option value="gemini" {"selected" if ai_mode == "gemini" else ""}>Gemini</option>
        <option value="claude" {"selected" if ai_mode == "claude" else ""}>Claude</option>
        <option value="debate" {"selected" if ai_mode == "debate" else ""}>Gemini vs Claude (debate)</option>
        <option value="orchestrate" {"selected" if ai_mode == "orchestrate" else ""}>Orchestrate</option>
      </select>
      <br /><br />
      <textarea id="prompt" name="prompt" rows="6" style="width:100%;" required>{html.escape(ai_prompt)}</textarea>
      <br /><br />
      <button type="submit">Run AI</button>
    </form>
    {ai_alert}
    <h3>Chat History</h3>
    <table>
      <thead><tr><th>Time</th><th>Mode</th><th>Prompt</th><th>Output</th></tr></thead>
      <tbody>{history_table}</tbody>
    </table>

    <h3>Available Files</h3>
    <table>
      <thead><tr><th>Name</th><th>Size</th><th>Action</th></tr></thead>
      <tbody>{table_rows}</tbody>
    </table>
  </div>

  <script>
    const input = document.getElementById("file-input");
    const dropzone = document.getElementById("dropzone");
    const fileCount = document.getElementById("file-count");
    const updateCount = () => {{
      const n = input.files ? input.files.length : 0;
      fileCount.textContent = n === 0 ? "No files selected" : `${{n}} file(s) selected`;
    }};
    ["dragenter", "dragover"].forEach((evt) => {{
      dropzone.addEventListener(evt, (e) => {{
        e.preventDefault(); e.stopPropagation(); dropzone.classList.add("dragover");
      }});
    }});
    ["dragleave", "drop"].forEach((evt) => {{
      dropzone.addEventListener(evt, (e) => {{
        e.preventDefault(); e.stopPropagation(); dropzone.classList.remove("dragover");
      }});
    }});
    dropzone.addEventListener("drop", (e) => {{
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {{
        input.files = e.dataTransfer.files; updateCount();
      }}
    }});
    input.addEventListener("change", updateCount);
  </script>
</body>
</html>
"""
        encoded = body.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _handle_upload(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._serve_home("Expected multipart form upload.", is_error=True)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0:
            self._serve_home("Upload body is empty.", is_error=True)
            return

        body = self.rfile.read(content_length)
        pseudo_message = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
        msg = BytesParser(policy=policy.default).parsebytes(pseudo_message)

        saved_files: list[str] = []
        blocked: list[str] = []
        for part in msg.iter_parts():
            if part.get_content_disposition() != "form-data":
                continue
            if part.get_param("name", header="content-disposition") != "file":
                continue
            name = _safe_filename(part.get_filename() or "")
            data = part.get_payload(decode=True) or b""
            if not name:
                continue
            if Path(name).suffix.lower() not in self.server.allowed_extensions:
                blocked.append(name)
                continue
            with (self.server.upload_dir / name).open("wb") as target:
                target.write(data)
            saved_files.append(name)

        if not saved_files and not blocked:
            self._serve_home("No files were submitted.", is_error=True)
            return
        if blocked and not saved_files:
            self._serve_home(f"Blocked file(s): {', '.join(blocked)}", is_error=True)
            return
        if blocked:
            self._serve_home(f"Uploaded {len(saved_files)} file(s). Blocked: {', '.join(blocked)}")
            return
        self._serve_home(f"Uploaded {len(saved_files)} file(s).")

    def _handle_delete(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "application/x-www-form-urlencoded" not in content_type:
            self._serve_home("Invalid delete request.", is_error=True)
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode("utf-8", errors="ignore")
        filename = _safe_filename(parse_qs(raw).get("name", [""])[0])
        if not filename:
            self._serve_home("Missing file name for deletion.", is_error=True)
            return
        target = self.server.upload_dir / filename
        if not target.exists():
            self._serve_home(f"File not found: {filename}", is_error=True)
            return
        target.unlink()
        self._serve_home(f"Deleted: {filename}")

    def _handle_ai(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "application/x-www-form-urlencoded" not in content_type:
            self._serve_home("Invalid AI request.", is_error=True)
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode("utf-8", errors="ignore")
        params = parse_qs(raw)
        mode = params.get("mode", ["debate"])[0].strip().lower()
        prompt = params.get("prompt", [""])[0].strip()
        if not prompt:
            self._serve_home("Prompt cannot be empty.", is_error=True, ai_mode=mode)
            return
        try:
            result = self._run_ai(mode, prompt)
            saved_path = self.server.save_ai_output(mode=mode, prompt=prompt, result=result)
            self.server.chat_history.append(
                {
                    "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "mode": mode,
                    "prompt_preview": (prompt[:80] + "...") if len(prompt) > 80 else prompt,
                    "file_name": saved_path.name,
                }
            )
            self._serve_home("AI request completed.", ai_result=result, ai_mode=mode, ai_prompt=prompt)
        except Exception as exc:
            self._serve_home("AI request failed.", is_error=True, ai_result=str(exc), ai_mode=mode, ai_prompt=prompt, ai_error=True)

    def _handle_scrape(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "application/x-www-form-urlencoded" not in content_type:
            self._serve_home("Invalid scrape request.", is_error=True)
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode("utf-8", errors="ignore")
        params = parse_qs(raw)
        url = params.get("url", [""])[0].strip()
        selector = params.get("selector", [""])[0].strip()
        if not url:
            self._serve_home("URL is required.", is_error=True)
            return
        try:
            content = self._run_scrape(url, selector)
            self._serve_home(f"Scraped: {url}", scrape_result=content, scrape_url=url)
        except Exception as exc:
            self._serve_home(f"Scrape failed: {exc}", is_error=True, scrape_error=True, scrape_url=url)

    def _run_scrape(self, url: str, selector: str = "") -> str:
        try:
            from scrapling.fetchers import Fetcher  # type: ignore[import]
            page = Fetcher.fetch(url, stealthy_headers=True)
            if selector:
                elements = page.css(selector)
                text = "\n".join(el.text.strip() for el in elements if el.text and el.text.strip())
            else:
                body_els = page.css("body")
                text = body_els[0].text.strip() if body_els else ""
        except ImportError:
            # scrapling not installed — fall back to urllib
            import re
            import urllib.request
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw_html = resp.read().decode("utf-8", errors="replace")
            text = re.sub(r"<[^>]+>", " ", raw_html)
            text = re.sub(r"\s+", " ", text).strip()
        return (text[:MAX_SCRAPE_CHARS] or "(no content extracted)")

    def _run_ai(self, mode: str, prompt: str) -> str:
        if mode == "gemini":
            return self._run_command(["gemini", "--skip-trust", "-p", prompt])
        if mode == "claude":
            return self._run_command(["claude", "-p", "--output-format", "text", prompt])
        if mode == "debate":
            g = self._run_command(["gemini", "--skip-trust", "-p", f"Take a position and justify: {prompt}"])
            c = self._run_command(["claude", "-p", "--output-format", "text", f"Critique and improve this response:\n{g}"])
            return f"Gemini:\n{g}\n\nClaude:\n{c}"
        if mode == "orchestrate":
            plan = self._run_command(["gemini", "--skip-trust", "-p", f"Create a practical plan: {prompt}"])
            draft = self._run_command(["claude", "-p", "--output-format", "text", f"Execute this plan:\n{plan}"])
            review = self._run_command(["gemini", "--skip-trust", "-p", f"Review and improve:\n{draft}"])
            final = self._run_command(["claude", "-p", "--output-format", "text", f"Produce final answer:\n{review}"])
            return f"Plan:\n{plan}\n\nDraft:\n{draft}\n\nReview:\n{review}\n\nFinal:\n{final}"
        raise ValueError("Unsupported mode.")

    def _run_command(self, args: list[str]) -> str:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=240,
            check=False,
        )
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        combined = out
        if err:
            combined = f"{combined}\n\n[stderr]\n{err}".strip()
        if proc.returncode != 0:
            raise RuntimeError(combined or f"Command failed with code {proc.returncode}")
        return combined or "(empty response)"

    def _serve_download(self, query: str) -> None:
        filename = _safe_filename(unquote(parse_qs(query).get("name", [""])[0]))
        if not filename:
            self.send_error(HTTPStatus.BAD_REQUEST, "File name is required.")
            return
        path = self.server.upload_dir / filename
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File does not exist.")
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        with path.open("rb") as source:
            shutil.copyfileobj(source, self.wfile)


class FilePortalServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], upload_dir: Path, allowed_extensions: set[str]):
        self.upload_dir = upload_dir
        self.allowed_extensions = allowed_extensions
        self.ai_output_dir = upload_dir / "ai_outputs"
        self.ai_output_dir.mkdir(parents=True, exist_ok=True)
        self.chat_history: list[dict[str, str]] = []
        super().__init__(server_address, FilePortalHandler)

    def save_ai_output(self, mode: str, prompt: str, result: str) -> Path:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        file_name = f"ai-{mode}-{stamp}.md"
        output_path = self.ai_output_dir / file_name
        content = (
            f"# AI Output ({mode})\n\n"
            f"Time: {datetime.now().isoformat(timespec='seconds')}\n\n"
            f"## Prompt\n\n{prompt}\n\n"
            f"## Result\n\n{result}\n"
        )
        output_path.write_text(content, encoding="utf-8")
        return output_path


def run_server(host: str, port: int, upload_dir: Path, allowed_extensions: set[str]) -> None:
    upload_dir.mkdir(parents=True, exist_ok=True)
    with FilePortalServer((host, port), upload_dir=upload_dir, allowed_extensions=allowed_extensions) as httpd:
        print(f"File portal running on http://{host}:{port}")
        print(f"Storage directory: {upload_dir.resolve()}")
        httpd.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a local file and AI portal.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--upload-dir", default=".uploaded_documents")
    parser.add_argument("--allow", default=",".join(sorted(DEFAULT_ALLOWED_EXTENSIONS)))
    args = parser.parse_args()

    allowed = {ext.strip().lower() for ext in args.allow.split(",") if ext.strip()}
    normalized = {ext if ext.startswith(".") else f".{ext}" for ext in allowed}
    if not normalized:
        raise ValueError("At least one allowed extension is required.")
    run_server(args.host, args.port, Path(args.upload_dir), normalized)


if __name__ == "__main__":
    main()
