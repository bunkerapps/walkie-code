#!/usr/bin/env python3
"""Share-to-TV bridge for Walkie-Code.

Any video link shared from the phone (an X live or replay, YouTube, Twitch,
anything yt-dlp understands) goes straight to a Chromecast, with no Mac in the
middle: this tiny server runs on an always-on device in the same LAN (a
Raspberry Pi, an old Android phone with Termux...) and hands the link to catt.
The Chromecast pulls and plays the stream itself, sound included, so the
device only works for the few seconds it takes to resolve the link.
Standard library only; catt and yt-dlp must be installed.

A video from the phone's gallery works too: the shortcut converts it to H.264
(classic Chromecasts can't play the iPhone's HEVC) and uploads it here; this
server keeps it and serves it to the Chromecast over the LAN.

Endpoints (all but /v/ need the X-Tele-Token header):
  POST /cast    body: the link, as plain text or JSON {"url": "..."}
  POST /video   body: the video file itself; only the last one is kept
  POST /stop, /pause, /play
  GET  /status
  GET  /v/<id>.mp4  the uploaded video, for the Chromecast (unguessable id)

Nothing piles up on the device: the video is deleted when the TV stops playing
it (it ends, gets stopped or something else is cast), on /stop and on restart.

Config (env vars):
  TELE_TOKEN   shared secret for the phone shortcut (required)
  TELE_DEVICE  Chromecast name, as `catt scan` shows it (default Chromecast)
  TELE_CATT    catt binary (default catt)
  TELE_PORT    port this server listens on (default 8791)
  TELE_LAN_IP  this device's LAN address, as the Chromecast sees it (auto)
  TELE_VIDEOS  where uploaded videos go (default ./videos)
  TELE_MAX_MB  biggest video accepted (default 4096)
"""
import hmac
import json
import os
import re
import secrets
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("TELE_TOKEN", "")
DEVICE = os.environ.get("TELE_DEVICE", "Chromecast")
CATT = os.environ.get("TELE_CATT", "catt")
PORT = int(os.environ.get("TELE_PORT", "8791"))
MAX_BODY = 8192
LAN_IP = os.environ.get("TELE_LAN_IP", "")
VIDEOS = os.environ.get("TELE_VIDEOS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos"))
MAX_VIDEO = int(os.environ.get("TELE_MAX_MB", "4096")) * 1024 * 1024
CHUNK = 1024 * 1024

# One catt at a time: two casts racing for the same TV leave it in a weird state.
lock = threading.Lock()


def catt(*args, timeout=90):
    with lock:
        done = subprocess.run(
            [CATT, "-d", DEVICE, *args], capture_output=True, text=True, timeout=timeout
        )
    return done.returncode, (done.stdout + done.stderr).strip()


def lan_ip():
    if LAN_IP:
        return LAN_IP
    # The mDNS group only exists on the LAN, so the route to it skips VPNs like Tailscale.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect(("224.0.0.251", 5353))
        return sock.getsockname()[0]


def video_path(name):
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.mp4", name):
        return None
    full = os.path.join(VIDEOS, name)
    return full if os.path.isfile(full) else None


def clear_videos(keep=None):
    if not os.path.isdir(VIDEOS):
        return
    for old in os.listdir(VIDEOS):
        if old != keep:
            try:
                os.remove(os.path.join(VIDEOS, old))
            except OSError:
                pass


current = {"name": None}  # the video the TV should be playing


def watch(name, every=30):
    # The Chromecast asks for the file bit by bit, so it can only go once the TV lets go of it.
    time.sleep(every)
    misses = 0
    while current["name"] == name:
        try:
            _, out = catt("info", timeout=20)
        except subprocess.TimeoutExpired:
            out = ""
        playing = name in out and re.search(r"player_state: (PLAYING|PAUSED|BUFFERING)", out)
        misses = 0 if playing else misses + 1
        # Two misses in a row: one bad answer from the TV doesn't delete a video mid-show.
        if misses >= 2:
            if current["name"] == name:
                current["name"] = None
                clear_videos()
                print(f"video {name} ya no está en la tele: borrado", flush=True)
            return
        time.sleep(every)


def link_from(body, ctype):
    text = body.decode("utf-8", "replace").strip()
    if "json" in ctype:
        try:
            text = str(json.loads(text).get("url", "")).strip()
        except (ValueError, AttributeError):
            return None
    # The share sheet sometimes sends "some title https://..." instead of the bare link.
    found = re.search(r"https?://\S+", text)
    return found.group(0) if found else None


def title_of(output):
    found = re.search(r'Playing "(.+?)" on', output)
    return found.group(1) if found else None


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        given = self.headers.get("X-Tele-Token", "")
        if TOKEN and hmac.compare_digest(given.encode(), TOKEN.encode()):
            return True
        self.reply(401, {"error": "Token inválido.", "text": "Token inválido."})
        return False

    def do_GET(self):
        if self.path.startswith("/v/"):
            return self.serve_video(self.path[3:])
        if not self.allowed():
            return
        if self.path != "/status":
            return self.reply(404, {"error": "No existe."})
        code, out = catt("status", timeout=20)
        self.reply(200 if code == 0 else 502, {"status": out, "device": DEVICE})

    def do_POST(self):
        if not self.allowed():
            return
        if self.path == "/video":
            return self.upload_video()
        size = int(self.headers.get("Content-Length") or 0)
        if size > MAX_BODY:
            return self.reply(413, {"error": "Demasiado largo.", "text": "Eso no parece un link."})
        body = self.rfile.read(size)
        try:
            if self.path == "/cast":
                link = link_from(body, self.headers.get("Content-Type", ""))
                if not link:
                    return self.reply(400, {"error": "Sin link.", "text": "No encontré un link para mandar a la tele."})
                code, out = catt("cast", link)
                if code != 0:
                    last = out.splitlines()[-1] if out else "catt falló"
                    return self.reply(502, {"error": last, "text": f"No se pudo: {last}"})
                title = title_of(out)
                return self.reply(200, {"title": title, "text": f"En la tele: {title}" if title else "Listo, en la tele."})
            actions = {"/stop": ("stop", "Listo, apagué el video."), "/pause": ("pause", "En pausa."), "/play": ("play", "Sigue.")}
            if self.path in actions:
                command, text = actions[self.path]
                code, out = catt(command, timeout=20)
                if command == "stop":
                    current["name"] = None
                    clear_videos()
                return self.reply(200 if code == 0 else 502, {"text": text if code == 0 else out})
            self.reply(404, {"error": "No existe."})
        except subprocess.TimeoutExpired:
            self.reply(504, {"error": "Tardó demasiado.", "text": "La tele tardó demasiado en contestar."})

    def body_chunks(self):
        # Shortcuts may send the file with a Content-Length or in chunks: both are read the same way.
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return
                left = size
                while left:
                    data = self.rfile.read(min(CHUNK, left))
                    if not data:
                        return
                    left -= len(data)
                    yield data
                self.rfile.readline()
        else:
            left = int(self.headers.get("Content-Length") or 0)
            while left:
                data = self.rfile.read(min(CHUNK, left))
                if not data:
                    return
                left -= len(data)
                yield data

    def upload_video(self):
        if int(self.headers.get("Content-Length") or 0) > MAX_VIDEO:
            return self.reply(413, {"error": "Muy grande.", "text": "El video es demasiado grande."})
        os.makedirs(VIDEOS, exist_ok=True)
        name = secrets.token_urlsafe(16) + ".mp4"
        partial = os.path.join(VIDEOS, name + ".part")
        received = 0
        hevc = False
        tail = b""
        out = None
        try:
            out = open(partial, "wb")
            for data in self.body_chunks():
                # hvc1/hev1 in the file means HEVC, which classic Chromecasts can't decode.
                hevc = hevc or b"hvc1" in tail + data or b"hev1" in tail + data
                tail = data[-3:]
                received += len(data)
                if received > MAX_VIDEO:
                    out.close()
                    os.remove(partial)
                    return self.reply(413, {"error": "Muy grande.", "text": "El video es demasiado grande."})
                out.write(data)
            out.close()
        except OSError:
            # The phone gave up mid-upload (or the disk is full): nothing half-written stays behind.
            if out:
                out.close()
            clear_videos(keep=current["name"])
            raise
        if received == 0:
            os.remove(partial)
            return self.reply(400, {"error": "Vacío.", "text": "No llegó ningún video."})
        # Only the last video stays: the phone is not a media library.
        clear_videos(keep=name + ".part")
        os.rename(partial, os.path.join(VIDEOS, name))
        current["name"] = name
        link = f"http://{lan_ip()}:{PORT}/v/{name}"
        try:
            code, out = catt("cast", "--force-default", link)
        except subprocess.TimeoutExpired:
            code, out = None, ""
        if code != 0:
            current["name"] = None
            clear_videos()
            if code is None:
                return self.reply(504, {"error": "Tardó demasiado.", "text": "La tele tardó demasiado en contestar."})
            last = out.splitlines()[-1] if out else "catt falló"
            return self.reply(502, {"error": last, "text": f"No se pudo: {last}"})
        threading.Thread(target=watch, args=(name,), daemon=True).start()
        mb = received / 1024 / 1024
        text = f"En la tele: tu video ({mb:.1f} MB)."
        if hevc:
            text += " Ojo: vino en HEVC; si la tele no lo muestra, en el atajo elegí 1080p (no HEVC)."
        return self.reply(200, {"text": text, "hevc": hevc})

    def serve_video(self, name):
        full = video_path(name)
        if not full:
            self.send_response(404)
            self.end_headers()
            return
        total = os.path.getsize(full)
        start, end = 0, total - 1
        # The Chromecast asks for byte ranges to buffer and seek.
        wanted = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if wanted and (wanted.group(1) or wanted.group(2)):
            if wanted.group(1):
                start = int(wanted.group(1))
                end = min(int(wanted.group(2) or end), total - 1)
            else:
                start = max(0, total - int(wanted.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{total}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as src:
            src.seek(start)
            left = end - start + 1
            try:
                while left:
                    data = src.read(min(CHUNK, left))
                    if not data:
                        break
                    self.wfile.write(data)
                    left -= len(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_HEAD(self):
        if self.path.startswith("/v/"):
            return self.serve_video(self.path[3:])
        self.send_response(404)
        self.end_headers()

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("TELE_TOKEN is required")
    clear_videos()  # whatever a previous run left behind
    print(f"tele bridge on :{PORT} -> {DEVICE}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
