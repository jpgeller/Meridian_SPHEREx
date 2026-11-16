"""Stream gaze points from the Python eye tracker to the Meridian page, over a local WebSocket.

Meridian connects to this server when opened with ?gaze_ws=PORT, e.g.
    http://localhost:5173/?gaze_ws=8765&input=assist
(input=assist: gaze helps the AI guide and never presses anything; input=gaze: a 0.8 s look presses a
button). The page converts screen pixels to its own pixels, smooths, snaps and times the dwell itself,
so send calibrated, raw points about 30 times a second. Run the browser full-screen (F11 / ctrl-cmd-F).

Standard library only (no `websockets` package needed). Use it from the tracker:

    from meridian_bridge import MeridianBridge
    bridge = MeridianBridge(port=8765, screen_w=2560, screen_h=1600)   # physical pixels of the screen
    bridge.start()                      # serves in a background thread
    ...
    bridge.send_gaze(x, y, confidence)  # each calibrated sample, in the same physical pixels
    bridge.send_gaze(None, None, 0)     # tracking lost (or just stop sending)
    bridge.targets                      # the page's buttons: [{id, x, y, w, h, kind, label}] (page px)

Try it without a tracker (a point circling the screen, then visiting the page's buttons):
    python meridian_bridge.py --fake circle
    python meridian_bridge.py --fake buttons
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import socket
import struct
import threading
import time

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class _Client:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.lock = threading.Lock()

    def send_text(self, text: str) -> bool:
        data = text.encode()
        n = len(data)
        if n < 126:
            head = struct.pack("!BB", 0x81, n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x81, 126, n)
        else:
            head = struct.pack("!BBQ", 0x81, 127, n)
        try:
            with self.lock:
                self.sock.sendall(head + data)
            return True
        except OSError:
            return False


def _read_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


class MeridianBridge:
    def __init__(self, port: int = 8765, screen_w: int | None = None, screen_h: int | None = None, host: str = "127.0.0.1"):
        self.host, self.port = host, port
        self.screen_w, self.screen_h = screen_w, screen_h
        self.clients: list[_Client] = []
        self.targets: list[dict] = []
        self.hello: dict | None = None  # the page's viewport, screen size and input mode
        self.listeners: list = []  # fn(msg) for every other message from the page (calibration: meridian_live.py)
        self.on_connect: list = []  # fn() when a page connects (e.g. to send it the tracker's state)
        self._lock = threading.Lock()
        self._server: socket.socket | None = None

    # --- sending --------------------------------------------------------------------
    def send(self, msg: dict) -> int:
        text = json.dumps(msg, separators=(",", ":"))
        with self._lock:
            clients = list(self.clients)
        sent = 0
        for c in clients:
            if c.send_text(text):
                sent += 1
            else:
                self._drop(c)
        return sent

    def send_gaze(self, x: float | None, y: float | None, confidence: float = 1.0) -> int:
        """One gaze sample in physical screen pixels (None = lost: sends confidence 0)."""
        if x is None or y is None:
            return self.send({"type": "gaze", "x": 0, "y": 0, "confidence": 0})
        msg = {"type": "gaze", "x": round(float(x), 1), "y": round(float(y), 1), "confidence": round(float(confidence), 3), "t": time.time() * 1000}
        if self.screen_w and self.screen_h:
            msg.update(screen_w=self.screen_w, screen_h=self.screen_h)
        return self.send(msg)

    def send_face(self, landmarks: list, **extra) -> int:
        """68 dlib landmarks [[x, y], ...] (+ optional ear, mar, pose, confidence) for the face panel."""
        return self.send({"type": "face", "landmarks": landmarks, **extra})

    def command(self, name: str, **args) -> int:
        """Run a Meridian command by name (e.g. 'zoom_in', 'set_band', band=40)."""
        return self.send({"type": "command", "name": name, "args": args})

    # --- server ---------------------------------------------------------------------
    def start(self) -> "MeridianBridge":
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind((self.host, self.port))
        self._server.listen(4)
        threading.Thread(target=self._accept_loop, daemon=True).start()
        return self

    def _accept_loop(self):
        while True:
            try:
                sock, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(sock,), daemon=True).start()

    def _drop(self, c: _Client):
        with self._lock:
            if c in self.clients:
                self.clients.remove(c)
        try:
            c.sock.close()
        except OSError:
            pass

    def _serve(self, sock: socket.socket):
        try:
            request = b""
            while b"\r\n\r\n" not in request:
                chunk = sock.recv(4096)
                if not chunk:
                    return sock.close()
                request += chunk
            headers = {}
            for line in request.decode(errors="replace").split("\r\n")[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            origin = headers.get("origin", "")
            # only pages served from this machine (the Meridian dev server) may connect
            if origin and not any(origin.startswith(p) for p in ("http://localhost", "http://127.0.0.1", "https://localhost")):
                sock.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                return sock.close()
            key = headers.get("sec-websocket-key")
            if not key:
                sock.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                return sock.close()
            accept = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
            sock.sendall(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n".encode()
            )
        except OSError:
            return
        client = _Client(sock)
        with self._lock:
            self.clients.append(client)
        print(f"[meridian-bridge] page connected ({len(self.clients)} open)")
        try:
            while True:
                b1, b2 = _read_exact(sock, 2)
                opcode, masked, n = b1 & 0x0F, b2 & 0x80, b2 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", _read_exact(sock, 2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", _read_exact(sock, 8))[0]
                mask = _read_exact(sock, 4) if masked else b"\0\0\0\0"
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(_read_exact(sock, n)))
                if opcode == 0x8:  # close
                    break
                if opcode == 0x9:  # ping -> pong
                    with client.lock:
                        sock.sendall(struct.pack("!BB", 0x8A, len(payload)) + payload)
                    continue
                if opcode == 0x1:
                    self._on_message(payload.decode(errors="replace"))
        except (ConnectionError, OSError, struct.error):
            pass
        finally:
            self._drop(client)
            print("[meridian-bridge] page disconnected")

    def viewport_to_screen(self, x: float, y: float) -> tuple[float, float]:
        """Page (viewport CSS) px -> the tracker's physical screen px (inverse of the page's gazeSocket.toViewport)."""
        v = (self.hello or {}).get("viewport", {})
        sx = (self.screen_w / v["screenW"]) if self.screen_w and v.get("screenW") else (v.get("dpr") or 1.0)
        sy = (self.screen_h / v["screenH"]) if self.screen_h and v.get("screenH") else (v.get("dpr") or 1.0)
        return (x + v.get("left", 0)) * sx, (y + v.get("top", 0)) * sy

    def _on_message(self, text: str):
        try:
            msg = json.loads(text)
        except ValueError:
            return
        if msg.get("type") == "targets":
            self.targets = msg.get("items", [])
        elif msg.get("type") == "hello":
            self.hello = msg
            print(f"[meridian-bridge] hello: {msg}")
            for fn in self.on_connect:
                fn()
        else:
            for fn in self.listeners:
                fn(msg)


def _fake(mode: str, port: int, w: int, h: int):
    bridge = MeridianBridge(port=port, screen_w=w, screen_h=h).start()
    print(f"[meridian-bridge] fake '{mode}' gaze on ws://localhost:{port}/  (screen {w}x{h})")
    print(f"open http://localhost:5173/?gaze_ws={port}&input=assist  (full-screen)")
    t0 = time.time()
    k = 0
    while True:
        t = time.time() - t0
        if mode == "buttons" and bridge.targets and bridge.hello:
            # visit each button for 1.5 s; target boxes are in page px, so convert back to screen px
            v = bridge.hello.get("viewport", {})
            sx = w / (v.get("screenW") or w)
            sy = h / (v.get("screenH") or h)
            buttons = [b for b in bridge.targets if b.get("kind") == "button"]
            if buttons:
                b = buttons[int(t / 1.5) % len(buttons)]
                cx = (b["x"] + b["w"] / 2 + v.get("left", 0)) * sx
                cy = (b["y"] + b["h"] / 2 + v.get("top", 0)) * sy
                bridge.send_gaze(cx, cy, 0.9)
        else:
            a = t * 0.6
            bridge.send_gaze(w / 2 + 0.35 * w * math.cos(a), h / 2 + 0.35 * h * math.sin(a), 0.9)
        k += 1
        time.sleep(1 / 30)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--fake", choices=["circle", "buttons"], default="circle")
    ap.add_argument("--screen", default="2560x1600", help="physical screen size the points are in")
    a = ap.parse_args()
    sw, sh = (int(v) for v in a.screen.lower().split("x"))
    _fake(a.fake, a.port, sw, sh)
