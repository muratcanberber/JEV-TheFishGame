"""Local bridge: exposes the laya-mlx decision agent over HTTP for the fish game.

Run with the laya-mlx venv:
    ~/.../laya-mlx/.venv/bin/python laya-bridge.py

Endpoint: POST http://127.0.0.1:8791/predict
Body:     {"state": {...}, "questions": {...}}
Response: {"model": "laya-rl-agent", "answers": {...}, "usage": {...}}
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

from laya_mlx import load

PORT = 8791

print("laya modeli yükleniyor...")
agent = load("aac6fef/laya-multilingual-mlx")
print("laya hazır → http://127.0.0.1:%d/predict" % PORT)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/predict":
            self.send_response(404)
            self.end_headers()
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            res = agent.predict(body.get("state", {}), body.get("questions", {}))
            out = json.dumps(res).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        except Exception as e:  # noqa: BLE001
            msg = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def log_message(self, *a):  # sessiz
        pass


# tek iş parçacıklı: MLX predict aynı anda tek çağrı güvenli olsun
HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
