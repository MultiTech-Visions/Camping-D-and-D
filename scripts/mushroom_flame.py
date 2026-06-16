#!/usr/bin/env python3
"""
Campfire flame animation for the "mushroom" BLE LED prop (the projector stand).

Spawned by the Node server (mushroom.js) when the GM toggles the mushroom lamp
on; killed (SIGTERM) when toggled off. Connects to the Magic Lantern controller
and drives an organic fire flicker — deep embers up through orange flames to the
occasional bright lick — until asked to stop, then turns the light off.

Defensive by design: auto-reconnects on a dropped link, prints status lines for
the server log, exits 0 on a clean stop and non-zero only on a real failure
(e.g. bleak missing) so the server can surface "no light" to the GM.

Protocol: service FFF0 / write char FFF3, write-without-response, 0x7e..0xef
frames — the same Magic Lantern protocol as the standalone led_tester.

Usage: mushroom_flame.py [MAC]   (MAC defaults to the known controller)
"""

import asyncio
import random
import signal
import sys

try:
    from bleak import BleakClient, BleakScanner
except Exception as exc:                       # bleak not installed → fail clearly
    print(f"flame: bleak unavailable ({exc!r}) — run: sudo apt install python3-bleak",
          flush=True)
    sys.exit(3)

ADDRESS = sys.argv[1] if len(sys.argv) > 1 else "BE:28:55:00:10:24"
WRITE_CHAR_UUID = "0000fff3-0000-1000-8000-00805f9b34fb"

_stop = asyncio.Event()


def _frame_color(r, g, b):
    return bytes([0x7E, 0x07, 0x05, 0x03, r & 0xFF, g & 0xFF, b & 0xFF, 0x10, 0xEF])


def _frame_on():
    return bytes([0x7E, 0x04, 0x04, 0xF0, 0x00, 0x01, 0xFF, 0x00, 0xEF])


def _frame_off():
    return bytes([0x7E, 0x04, 0x04, 0x00, 0x00, 0x00, 0xFF, 0x00, 0xEF])


def _lerp(a, b, t):
    return a + (b - a) * t


# Fire gradient by "heat" 0..1: dark ember red → blood red → orange → amber →
# bright yellow-white lick. Intensity (overall brightness) rides on top.
_STOPS = [
    (0.00, (40, 0, 0)),
    (0.22, (120, 10, 0)),
    (0.45, (200, 40, 0)),
    (0.65, (255, 75, 0)),
    (0.82, (255, 120, 15)),
    (1.00, (255, 195, 60)),
]


def _heat_to_rgb(h):
    for i in range(len(_STOPS) - 1):
        h0, c0 = _STOPS[i]
        h1, c1 = _STOPS[i + 1]
        if h <= h1:
            t = (h - h0) / (h1 - h0) if h1 > h0 else 0.0
            return tuple(int(_lerp(c0[k], c1[k], t)) for k in range(3))
    return _STOPS[-1][1]


async def _flame(client):
    """Drive the flicker until stop is requested or the link drops.

    Returns normally on a detected drop (so main() reconnects). Notes on this
    controller, learned the hard way:
      * FFF3 is write-WITHOUT-response only; an acknowledged write (response=
        True) is rejected by BlueZ as 'Write not permitted'. Never use it.
      * Under a fast continuous colour stream the controller powers its output
        down. A modest cadence plus a periodic re-assert of the On frame keeps
        it lit through a long session.
      * A real disconnect surfaces via client.is_connected; we reconnect."""
    await client.write_gatt_char(WRITE_CHAR_UUID, _frame_on(), response=False)
    heat = 0.5
    elapsed = 0.0
    last_on = 0.0
    while not _stop.is_set():
        if not client.is_connected:
            print("flame: link dropped — reconnecting", flush=True)
            return

        # Random walk with occasional flares (a gust catching) and dips.
        heat += random.uniform(-0.10, 0.10)
        if random.random() < 0.07:
            heat += random.uniform(0.20, 0.45)        # flare up
        if random.random() < 0.07:
            heat -= random.uniform(0.20, 0.40)        # settle down
        heat = max(0.06, min(1.0, heat))

        r, g, b = _heat_to_rgb(heat)
        # Extra brightness flicker layered on the colour.
        flick = random.uniform(0.78, 1.0)
        r, g, b = int(r * flick), int(g * flick), int(b * flick)

        # Re-assert On every few seconds so the controller keeps its output up.
        if elapsed - last_on >= 4.0:
            await client.write_gatt_char(WRITE_CHAR_UUID, _frame_on(),
                                         response=False)
            last_on = elapsed

        await client.write_gatt_char(WRITE_CHAR_UUID, _frame_color(r, g, b),
                                     response=False)

        # Gentle, irregular cadence reads as fire without overrunning the radio.
        dt = random.uniform(0.18, 0.30)
        elapsed += dt
        await _sleep_or_stop(dt)


async def _sleep_or_stop(seconds):
    try:
        await asyncio.wait_for(_stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


async def main():
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _stop.set)
        except NotImplementedError:
            pass

    backoff = 1.0
    while not _stop.is_set():
        try:
            dev = await BleakScanner.find_device_by_address(ADDRESS, timeout=8.0)
            if dev is None:
                print("flame: light not found (in range? powered?) — retrying",
                      flush=True)
                await _sleep_or_stop(backoff)
                backoff = min(backoff * 1.6, 8.0)
                continue
            async with BleakClient(dev, timeout=20.0) as client:
                print("flame: connected", flush=True)
                backoff = 1.0
                await _flame(client)
                # Stop requested: leave the prop dark.
                try:
                    await client.write_gatt_char(WRITE_CHAR_UUID, _frame_off(),
                                                 response=False)
                except Exception:
                    pass
        except Exception as exc:
            print(f"flame: link error ({exc!r}) — reconnecting", flush=True)
            await _sleep_or_stop(backoff)
            backoff = min(backoff * 1.6, 8.0)

    print("flame: stopped", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
