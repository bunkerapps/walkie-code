# Walkie Wake

Wake the Mac from the phone when it's asleep.

A sleeping Mac can't serve Walkie-Code, so it can't wake itself. Walkie Wake is a tiny relay that runs on **any always-on device in the same network that has Python 3**: a Raspberry Pi, a NAS, a home server, an old Android phone with Termux… It serves a page with the Walkie-Code look and a power button. When you tap it, the relay sends a Wake-on-LAN magic packet to the Mac.

```
iPhone ──Tailscale──▶ relay (Python) ──magic packet──▶ Mac (asleep)
   └──────────────Tailscale──────────────────────────▶ Walkie-Code (once awake)
```

It's a separate web app on purpose: the relay never holds the Walkie-Code token.

## How the Mac wakes up

Over Wi-Fi, the magic packet usually gives a **DarkWake**: the Mac is on the network but with the screen off, and falls back asleep within a minute. Walkie-Code handles the rest:

- `GET /api/awake` (no token) reports whether the Mac is *really* awake (graphics on). A DarkWake counts as asleep, so the relay doesn't lie.
- The first authorized request from the phone makes the Mac declare user activity (`caffeinate -u`), which turns the DarkWake into a full wake.

So the flow is: tap the power button in Walkie Wake → open Walkie-Code.

## Setup

1. On the Mac, allow waking for network access, on AC and on battery:
   `sudo pmset -a womp 1`
2. Find the Mac's MAC address (Wi-Fi uses a private address per network; send both it and the hardware one to be safe): `ifconfig en0 | grep ether` and `networksetup -listallhardwareports`.
3. Copy `wake.py` and the `web/` folder to the relay device, plus Walkie-Code's `public/style.css` into `web/` (the page reuses it).
4. Run it:

   ```sh
   WAKE_MACS=aa:bb:cc:dd:ee:ff \
   WAKE_AWAKE=https://<your-mac>.<your-tailnet>.ts.net/api/awake \
   python3 wake.py
   ```

5. Put the relay in your tailnet and open `http://<relay>:8787` on the iPhone. *Share › Add to Home Screen* installs it as its own app.

`deploy.sh` does step 3 over USB for an Android phone with Termux (`adb`); on other devices, `scp` works just as well.

## Configuration

| Variable | What it does |
| --- | --- |
| `WAKE_MACS` | Comma-separated MAC addresses to wake (required) |
| `WAKE_AWAKE` | Walkie-Code's `/api/awake` URL. The best way to know if the Mac is awake |
| `WAKE_HOST` / `WAKE_CHECK` | Fallback: IP and TCP port probed when `WAKE_AWAKE` isn't set. A DarkWake answers it too |
| `WAKE_PORT` | Port of the relay (default `8787`) |
| `WAKE_URL` | Optional: where to send the browser once the Mac is awake. Only handed to Tailscale clients |

## Notes

- Keep the relay running across reboots with whatever the device offers: a systemd unit on a Raspberry Pi, Termux:Boot on Android, etc.
- Wake-on-LAN over Wi-Fi depends on the Mac and the router; Ethernet is more reliable.
