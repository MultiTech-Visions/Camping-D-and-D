# 🔥 Campfire Saga

A self-hosted companion app for tabletop RPGs around an actual campfire. It runs on a
**Raspberry Pi 5** with **zero internet** — the Pi broadcasts its own WiFi, everyone's
phone connects, and the Pi can drive a projector for the shared display at night.

It speaks two systems:

- **Campfire Saga** — the homebrew narrative-dice game (the app teaches it at `/learn`).
  The app never rolls dice; the physical dice tray does. The app tracks characters,
  drain, conditions, blue dice, clocks, initiative, and progression.
- **D&D 5e (and friends)** — a phone-friendly character sheet/tracker: abilities with
  auto-modifiers, AC, HP with damage/heal/temp, death saves, spell slots, inspiration,
  conditions. Generic enough for most d20-style games.

Clocks, initiative, the GM screen, and the projector display are **system-agnostic** —
mix Campfire heroes and D&D characters in the same session if you like.

---

## 🚀 Setting it up (no typing required)

**One-time install, at home with internet:**

1. On the Pi, open this page in the browser → green **Code** button → **Download ZIP**.
2. Open the Downloads folder, right-click the ZIP → **Extract Here**, and move the
   folder somewhere comfy (your home folder is perfect).
3. Open the folder and double-click **`INSTALL.sh`** → choose **Execute in Terminal**.
4. Wait for the big "INSTALL COMPLETE" message. Done.

Day to day there are just four files, right in this folder:

| File | What it does |
|---|---|
| **START.sh** | The one button: starts the server, sorts out WiFi (raises the `CampfireSaga` hotspot automatically if there's no WiFi around), and opens the system window with QR codes |
| **STOP.sh** | Everything off: stops the server and the hotspot |
| **UPDATE.sh** | Downloads the newest version from GitHub, self-tests it, restarts only if it was running (needs internet — do it at home) |
| **INSTALL.sh** | One-time setup on a fresh Pi |

The server **never starts on its own** — this Pi has other jobs, so nothing runs at
boot. START.sh when it's game time, STOP.sh when you're done.

## 🏕 At the campsite

1. Power the Pi and double-click **START.sh**. That's it.
2. The system window appears with two QR codes: **scan #1** with a phone camera to
   join the WiFi (`CampfireSaga` / password `tellmeastory`), **scan #2** to open the
   game. (At home, where the Pi already has WiFi, step #1 just says "join the same
   network".) Then turn the Pi's screen off — nobody looks at it again.
3. On their phones, players pick **This is me** or forge a new hero; the GM opens
   **/dm**.
4. At night, HDMI into the projector and tap **"Switch this screen to the projector
   display"** on the system window (or browse to `/display`).

| Page | Who | What |
|---|---|---|
| `/` | everyone | pick or create a character |
| `/play` | players | character sheet + tracker |
| `/dm` | the GM | every character (including secrets), drain/HP controls, initiative, clocks, settings |
| `/display` | the projector | turn order, party roster, visible clocks, drifting embers |
| `/learn` | everyone | how to play Campfire Saga, with the dice cheat sheet |
| `/status` | the Pi itself | the system window START.sh opens: WiFi + game QR codes, who's connected |

## 📜 Logs (when something looks weird)

Every run of every script writes a timestamped log into the **`logs/`** folder, so a
closed terminal window never loses information:

- `logs/server.log` — everything the game server did, across all runs
- `logs/latest-install.log`, `latest-start.log`, `latest-stop.log`,
  `latest-update.log` — the most recent run of each script (older runs stay
  alongside with timestamps in their names)

Open them by double-clicking — they're plain text.

## 🛠 Troubleshooting

- **Phones can't find the page** → make sure they're on the same WiFi as the Pi
  (the system window's left panel tells you which), then scan the game QR again.
- **Install failed at npm** → the Pi was probably offline. Get internet, run Install
  again. (The database module sometimes compiles from source on ARM — the installer
  pre-installs the build tools it needs.)
- **Server won't start** → open `logs/server.log`; the last lines say exactly why.
  The app *fails loud on purpose* — a clear error beats silent corruption.
- **Update broke something** → updates refuse to finish unless the built-in self-test
  passes, and your campaign data (`data/` folder) is never touched by updates.

## 🧱 For developers

Vanilla JS, no frameworks, no build step. Node 18+, Express + `ws` + `better-sqlite3`.
The server is the single source of truth: clients send `{type:"action", op, payload}`
over one WebSocket; the server validates (fail-loud — invalid state throws), persists
to SQLite, and broadcasts role-scoped snapshots (players never receive another
player's `hidden_desire` or `dm_only` clocks — enforced server-side).

```
server.js        entry: Express + ws + logging
config.js        tunable constants (creation points, reward rate default, conditions…)
rules.js         pure rule helpers (diceForRank — THE rank→dice mapping)
db.js            better-sqlite3 schema + prepared statements
state.js         in-memory canonical state, all ops, role-scoped snapshots
ws.js            websocket plumbing: hello/snapshot/action/error
public/          the six pages + shared js (ws-client, dice/clock renderers)
*.sh             the double-click toolkit (INSTALL/START/STOP/UPDATE — all tee
                 their output into logs/); scripts/_lib.sh is the shared plumbing
systemd/         service template (installer fills in user + path)
test/smoke.js    self-test run by install + update against a throwaway DB
```

Run the self-test any time: `node test/smoke.js`.

**Roadmap** (per `HANDOFF.md` phases): Phase 1 (playable core + teaching page) ✅ ·
Phase 2 (initiative + clocks) ✅ · Phase 3 (projector battle map) ✅ · Phase 4 has a
head start (animated glow tokens already render). The map is system-agnostic by
design — tokens and the grid know nothing about game rules.

### The battle map (Phase 3)

All from the GM screen on a phone: **upload** a map image → **calibrate** by tapping
the top-left and bottom-right corners of a clean span of squares and saying how many
cells it covers → the map goes live on the projector. Tokens (players, monsters,
terrain, pulsing glow lights) live in **grid coordinates**; players get a d-pad on
their sheet to walk their own token. The camera is a pure view transform — minimap
tap-to-aim, nudge/zoom/rotate buttons, and named view bookmarks to snap between.
Initiative accepts **anything**, not just characters — type "Goblin Pack" or "The
Ritual" and it slots into the turn order. Switching the map off returns the
projector to campfire mode (roster + clocks + embers).

Art is user-replaceable: drop real dice/symbol images into `public/assets/dice/` and
`public/assets/symbols/` (names like `green.png`, `triumph.png`) and the learn page
upgrades its placeholders automatically.
