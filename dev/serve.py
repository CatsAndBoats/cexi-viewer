"""Dev server for the CEXI Model Viewer frontend.

Serves ui/ statically plus the /fs endpoints the browser fallback in
backend.js uses (list/read restricted to the FFXI game directory), so the
viewer can be developed in a normal browser without the Tauri shell.

Usage: python dev/serve.py [port]
"""
import json
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

UI_DIR = Path(__file__).resolve().parent.parent / "ui"
# CEXI_GAME_DIR overrides the install path (non-Windows dev boxes, alt clients).
GAME_DIR = Path(os.environ.get("CEXI_GAME_DIR") or r"D:\cexi\catseyexi-client\Game\FINAL FANTASY XI")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/fs/default":
            return self._text(str(GAME_DIR))
        if url.path == "/fs/list":
            return self._list(parse_qs(url.query).get("path", [""])[0])
        if url.path == "/fs/read":
            return self._read(parse_qs(url.query).get("path", [""])[0])
        if url.path == "/fs/vgmstream":
            return self._vgmstream(parse_qs(url.query).get("path", [""])[0])
        return super().do_GET()

    def _vgmstream(self, raw):
        import subprocess, tempfile, os
        vgm = r"D:\xidata\AltanaListener_Windows\Dependencies\vgmstream-cli.exe"
        try:
            src = self._resolve(raw)
            out = os.path.join(tempfile.gettempdir(), "cexi_vgm_dev.wav")
            subprocess.run([vgm, "-i", "-o", out, str(src)], check=True, capture_output=True)
            body = open(out, "rb").read()
            os.remove(out)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._error(e)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/fs/mesh-export":
            try:
                import subprocess, json as _json
                length = int(self.headers.get("Content-Length", 0))
                body = _json.loads(self.rfile.read(length))
                cexi = body.get("cexiPath") or r"C:\Users\Josh\.local\bin\cexi.exe"
                cmd = [cexi, "mesh", "export", body["datPath"], "--output", body["outputDir"], *body.get("args", [])]
                r = subprocess.run(cmd, capture_output=True, text=True)
                out = (r.stdout or "") + (r.stderr or "")
                if r.returncode != 0:
                    self.send_response(500)
                else:
                    self.send_response(200)
                b = out.strip().encode()
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
            except Exception as e:
                self._error(e)
            return
        if url.path == "/fs/write":
            try:
                raw = parse_qs(url.query).get("path", [""])[0]
                p = self._resolve_any(raw)
                length = int(self.headers.get("Content-Length", 0))
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(self.rfile.read(length))
                return self._text("ok")
            except Exception as e:
                return self._error(e)
        # Dev helper: POST /capture with a data-URL body saves a screenshot
        # next to this script for automated visual verification.
        if urlparse(self.path).path == "/capture":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode()
            b64 = body.split("base64,", 1)[1]
            import base64
            out = Path(__file__).resolve().parent / "capture.jpg"
            out.write_bytes(base64.b64decode(b64))
            return self._text(str(out))
        self.send_response(404)
        self.end_headers()

    def _resolve(self, raw):
        # The frontend joins paths Windows-style; accept those on POSIX dev boxes.
        if os.sep != "\\":
            raw = raw.replace("\\", "/")
        p = Path(raw).resolve()
        if not p.is_relative_to(GAME_DIR):
            raise PermissionError(f"outside game dir: {p}")
        return p

    def _resolve_any(self, raw):
        # Export destinations are user-chosen folders outside the game dir.
        return Path(raw).resolve()

    def _list(self, raw):
        try:
            p = self._resolve(raw)
            entries = [{"name": e.name, "isDir": e.is_dir()} for e in p.iterdir()]
            body = json.dumps(entries).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._error(e)

    def _read(self, raw):
        try:
            body = self._resolve(raw).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._error(e)

    def _text(self, text):
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, e):
        body = str(e).encode()
        self.send_response(500)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"serving {UI_DIR} + game dir {GAME_DIR} on http://127.0.0.1:{port}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
