#!/usr/bin/env python3
"""Wake-on-LAN relay for Walkie-Code.

A sleeping Mac can't serve the walkie web, so this tiny server runs on an
always-on device in the same LAN with Python 3 (a Raspberry Pi, a NAS, an old
Android phone with Termux...) and sends the magic packet for it. Standard library only.

Config (env vars):
  WAKE_MACS   comma-separated MAC addresses to wake (required)
  WAKE_HOST   IP of the Mac, used to report if it's awake (optional)
  WAKE_CHECK  TCP port probed on WAKE_HOST (default 22)
  WAKE_AWAKE  Walkie-Code /api/awake URL. Better than the TCP probe: a Mac in
              DarkWake (half awake, screen off) answers TCP but reports false here.
  WAKE_PORT   port this server listens on (default 8787)
  WAKE_URL    where to send the browser once the Mac is awake (optional).
              It may carry the walkie token (?t=...), so it's only handed to
              Tailscale clients, never to plain LAN visitors.
"""
import ipaddress
import json
import os
import socket
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MACS = [m.strip() for m in os.environ.get("WAKE_MACS", "").split(",") if m.strip()]
HOST = os.environ.get("WAKE_HOST", "")
CHECK = int(os.environ.get("WAKE_CHECK", "22"))
PORT = int(os.environ.get("WAKE_PORT", "8787"))
URL = os.environ.get("WAKE_URL", "")
AWAKE_URL = os.environ.get("WAKE_AWAKE", "")
TAILNET = ipaddress.ip_network("100.64.0.0/10")

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}


def magic_packet(mac):
    raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    if len(raw) != 6:
        raise ValueError(f"bad MAC: {mac}")
    return b"\xff" * 6 + raw * 16


def wake():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for mac in MACS:
            packet = magic_packet(mac)
            for port in (7, 9):
                sock.sendto(packet, ("255.255.255.255", port))


def awake():
    if AWAKE_URL:
        try:
            with urllib.request.urlopen(AWAKE_URL, timeout=4) as res:
                return bool(json.load(res).get("awake"))
        except (OSError, ValueError):
            return False
    if not HOST:
        return None
    try:
        with socket.create_connection((HOST, CHECK), timeout=1.5):
            return True
    except OSError:
        return False


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/status":
            state = awake()
            return self.send(200, '{"awake":%s}' % ("null" if state is None else str(state).lower()), "application/json")
        name = "index.html" if path == "/" else path.lstrip("/")
        ext = os.path.splitext(name)[1]
        file = os.path.join(WEB, name)
        if "/" in name or ext not in TYPES or not os.path.isfile(file):
            return self.send(404, "not found", "text/plain")
        with open(file, "rb") as f:
            data = f.read()
        if name == "index.html":
            url = URL if ipaddress.ip_address(self.client_address[0]) in TAILNET else ""
            data = data.replace(b"__WALKIE_URL__", json.dumps(url).encode())
        self.send(200, data, TYPES[ext])

    def do_POST(self):
        if self.path != "/wake":
            return self.send(404, "not found", "text/plain")
        try:
            wake()
            self.send(200, '{"ok":true}', "application/json")
        except OSError as err:
            self.send(500, '{"ok":false,"error":"%s"}' % err, "application/json")


if __name__ == "__main__":
    if not MACS:
        raise SystemExit("Set WAKE_MACS, e.g. WAKE_MACS=aa:bb:cc:dd:ee:ff")
    print(f"Wake relay on :{PORT} for {', '.join(MACS)}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
