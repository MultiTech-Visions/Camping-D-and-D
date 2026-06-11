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
3. Open the folder and double-click **`INSTALL - DOUBLE CLICK ME.sh`** → choose
   **Execute in Terminal**.
4. Wait for the big "INSTALL COMPLETE" message. Done.

The installer puts these icons on your Desktop:

| Icon | What it does |
|---|---|
| 🔥 **Start Campfire Saga** | Starts/restarts the server and shows the address for phones |
| 🛑 **Stop Campfire Saga** | Stops the server |
| ⬇ **Update Campfire Saga** | Downloads the newest version from GitHub and restarts (needs internet — do it at home) |
| 📶 **Campsite WiFi Hotspot** | Toggles the Pi's own WiFi network (`CampfireSaga` / password `tellmeastory`) |
| 📽 **Projector Display** | Opens the shared display full-screen for the HDMI projector |

The server **never starts on its own** — this Pi has other jobs, so nothing runs at
boot. Double-click 🔥 Start when it's game time, 🛑 Stop when you're done.

## 🏕 At the campsite

1. Power the Pi and double-click **🔥 Start Campfire Saga**.
2. Double-click **📶 Campsite WiFi Hotspot**. Phones join WiFi **CampfireSaga**
   (password **tellmeastory**).
3. Phones browse to **http://10.42.0.1:3000** (the Hotspot window shows the exact
   address). Players pick **This is me** or forge a new hero; the GM opens **/dm**.
4. At night, HDMI into the projector and double-click **📽 Projector Display**.

| Page | Who | What |
|---|---|---|
| `/` | everyone | pick or create a character |
| `/play` | players | character sheet + tracker |
| `/dm` | the GM | every character (including secrets), drain/HP controls, initiative, clocks, settings |
| `/display` | the projector | turn order, party roster, visible clocks, drifting embers |
| `/learn` | everyone | how to play Campfire Saga, with the dice cheat sheet |

## 📜 Logs (when something looks weird)

Every run of every script writes a timestamped log into the **`logs/`** folder, so a
closed terminal window never loses information:

- `logs/server.log` — everything the game server did, across all runs
- `logs/latest-install.log`, `latest-start.log`, `latest-update.log`,
  `latest-hotspot.log`, `latest-projector.log`, `latest-stop.log` — the most recent
  run of each icon (older runs stay alongside with timestamps in their names)

Open them by double-clicking — they're plain text.

## 🛠 Troubleshooting

- **Phones can't find the page** → make sure they're on the `CampfireSaga` WiFi, then
  double-click 🔥 Start — it prints the exact address to type.
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
public/          the five pages + shared js (ws-client, dice/clock renderers)
scripts/         the double-click toolkit (everything logs to logs/)
systemd/         service template (installer fills in user + path)
test/smoke.js    self-test run by install + update against a throwaway DB
```

Run the self-test any time: `node test/smoke.js`.

**Roadmap** (per `HANDOFF.md` phases): Phase 1 (playable core + teaching page) ✅ ·
Phase 2 (initiative + clocks) ✅ · Phase 3 (projector battle map: PixiJS is already
vendored in `public/vendor/`, map upload + grid calibration + tokens + camera remote)
· Phase 4 (glow effects + polish). The map is system-agnostic by design — tokens and
grid know nothing about game rules.

Art is user-replaceable: drop real dice/symbol images into `public/assets/dice/` and
`public/assets/symbols/` (names like `green.png`, `triumph.png`) and the learn page
upgrades its placeholders automatically.
