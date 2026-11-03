import base64
import http.server
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, "..", "assets")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        name = os.path.basename(self.path.split("?name=")[-1])
        if self.path.startswith("/save-png"):
            data = body.split(b",", 1)[1]
            with open(os.path.join(ASSETS, name), "wb") as f:
                f.write(base64.b64decode(data))
        elif self.path.startswith("/save-json"):
            with open(os.path.join(ASSETS, name), "w") as f:
                json.dump(json.loads(body), f, indent=1)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
