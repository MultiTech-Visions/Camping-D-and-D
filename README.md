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

Clocks, initiative, the GM screen, the **reveal cards** (full-screen NPC / location /
story splashes), and the projector display are **system-agnostic** — mix Campfire
heroes and D&D characters in the same session if you like.

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
2. The system window appears with three QR codes: **scan #1** with a phone camera to
   join the WiFi (`CampfireSaga` / password `tellmeastory`), **scan #2** to open the
   game (players), **scan #3** for the GM screen. (At home, where the Pi already has
   WiFi, step #1 just says "join the same network".) Then turn the Pi's screen off —
   nobody looks at it again.
3. On their phones, players name their device and pick **This is me** or forge a new
   hero; the GM scans the GM QR (the **/dm** screen lives on its own port — see below).
   Players and the projector connect over plain `http://` — **no warnings, nothing to
   tap through.**
4. At night, HDMI into the projector and tap **"Switch this screen to the projector
   display"** on the system window (or browse to `/display`).

> **The GM screen is HTTPS (and why).** Only the **GM port (3001)** serves over
> **HTTPS**, because the prep-time **voice assistant** on `/assist` needs the
> **microphone**, and phone browsers only allow the mic on a secure connection. With no
> internet domain at a campsite, the Pi makes its own **self-signed certificate** on
> first start (saved in the private `data/` folder, regenerated if its IP changes), so
> the GM's device sees a **one-time "not secure" warning** the first time it opens the
> GM screen — tap through it (Advanced → proceed). Typing a plain `http://…:3001`
> address still works; it redirects to `https://`. The **player port (3000) stays plain
> HTTP**, so nobody at the table meets a certificate warning — the mic is never used
> there.

The app runs **two web servers on one Pi**: the player side on port **3000** and the
GM side on port **3001**. The GM URL simply doesn't serve character creation or the
player sheet, so handing someone the projector or sharing a screen can't leak the GM
controls. Both sides talk over the same live connection, so a GM action shows up on
every phone instantly.

| Page | Port | Who | What |
|---|---|---|---|
| `/` | 3000 | everyone | name this device, then pick or create a character |
| `/play` | 3000 | players | character sheet + tracker; reveal cards pop up here |
| `/dm` | 3001 | the GM | every character (including secrets), drain/HP controls, initiative, clocks, the reveal-card library, devices, and settings |
| `/display` | both | the projector | turn order, party roster, visible clocks, drifting embers, and full-screen reveal cards |
| `/learn` | both | everyone | how to play Campfire Saga, with the dice cheat sheet |
| `/status` | 3001 | the Pi itself | the system window START.sh opens: WiFi + player + GM QR codes, who's connected |

## 🎴 Reveal cards (NPCs, locations & story beats)

The GM prepares **cards** ahead of time and reveals them full-screen on the projector
and every player's phone — a video-game-style splash with a framed, cross-fading
portrait on the left and a scrolling info column on the right. There are three kinds,
all built and revealed the same way:

- **🐲 NPC / monster** — a stat-block reveal; the first image doubles as a map token,
  so you can "place on map" straight from the library.
- **🌍 Location** — set the scene when the party arrives somewhere; mark places visited.
- **📖 Story** — a narrated beat or handout you walk the table through.

Each card holds a name, subtitle, GM-only notes, a slideshow of uploaded images, and
text **sections** of **entries**. During play the GM toggles individual entries on and
off, so a scene unfolds live; spotlights a section or single entry; pauses or speeds the
auto-scrolling crawl; holds a specific image; and toggles a glowing connector line that
ties a caption to the picture it describes. Players get a dismissible copy they can read
at their own pace (with a banner to reopen it); the projector shows it locked and
crawling. GM notes and hidden entries never reach players. Each card has a backdrop and a
**particle effect** — embers, snow, rain, motes, or arcane — and the projector plays a
short transition splash when it swaps between screens. Tune scroll speed, particles, and
the transition splashes in the GM **Settings** panel.

## 📱 Devices

Every phone names itself once ("Sara's phone") and quietly remembers who it is. A phone
only shows its own characters, and the GM's **Devices** panel lists every device — online
or offline — with the characters linked to each, so you can rename, forget, link, or
unlink a hero from a phone without anyone retyping anything.

## 📓 Player notebook

Every player gets a private **notebook** on their phone (nav: **📓 Notebook**, or
the card at the bottom of their sheet) for long-term note-taking across sessions.
It's not one big text box — players create **as many records as they like**, each
with its own **title** and free-text body, so session recaps, clues, NPC reminders,
and shopping lists stay as separate, scannable entries. A **search box** filters
across every record's title and text, and any record can be **pinned** to the top
for quick recall. Notes are tied to the character and **never leave that phone** —
other players, the GM, and the projector never see them.

## 🪄 Campaign assistant (prep at home, needs internet)

Before a trip — while the Pi still has internet — open **`/assist`** on the GM port
(there's a link in the GM screen's nav and on the system window) to talk through your
campaign with an AI helper. Describe what you want ("a smuggler NPC who runs the docks,
the tavern they drink in, and an opening story beat") and it **fleshes out the details
for you**: it writes NPC / location / story reveal cards, generates portrait and scene
art, and drafts vivid section text — all saved straight into your campaign so it's there
offline at the campsite. Everything it makes appears live on the GM screen as it works.

You can **talk to it** (🎙 Start talking — realtime voice over WebRTC) or **type** to it.
It's purely a preparation tool; at the campsite the Pi runs offline as always and this
page simply won't connect.

**One-time setup** — give it an OpenAI API key (the key stays on the Pi; phones never see
it). Either set the `OPENAI_API_KEY` environment variable, or simply drop the key into a
plain text file at **`data/openai.key`** (the `data/` folder is private and never touched
by updates), then restart the server. The models, voice, and image size are tunable in
`config.js` under `ASSISTANT` — if OpenAI renames a model and a call fails, update it there.

### 📨 Story Arc Builder — hand prep off to a co-GM (no internet, no account)

Want a friend to draft a campaign without giving them the Pi or an AI key? The
**Story Arc Builder** is a single, self-contained web page — **`public/builder.html`**.
On the `/assist` screen there's a button to **download it**; email that one file, drop it in
a shared drive, or save it to a phone. Whoever opens it can flesh out a campaign **fully
offline**: cards (characters / locations / story beats), chapters and scenes, GM-only
notes, and **image requests** (just typed descriptions of art they'd like). It autosaves in
their browser and exports a **"prep pack" `.json`** file.

Back home with internet, the GM returns to **`/assist` → "Import a prep pack,"** picks that
file, and the Pi turns it into real reveal cards — running every image request through the
art generator (the **image queue**) and slotting the results into place, with live progress.
Scenes marked *"start hidden"* come in hidden so the GM still unveils them at the table.

## 🍄 Mushroom lamp (campfire ambiance)

The projector sits on a glowing "mushroom" stand — an off-the-shelf Bluetooth LED
light that the app can make **flicker like a campfire**. Lovely ambiance on a night
with no real fire going.

**Turn it on:** GM screen → **⚙ Settings → 🍄 Mushroom lamp → "Light the flame."**
Tap again to put it out. The button tells you what's happening: *Finding the
light…*, *Flame burning*, or a clear warning if it can't reach the light.

**The hardware — what to buy:** it's just a consumer **RGBIC LED strip/light kit with
Bluetooth** (the kind controlled by a phone app and a little RF remote). This one pairs
with the **"Magic Lantern"** Android app. Any light from that same family should work —
look for one whose app talks over Bluetooth (not only WiFi).

> 🛒 **The exact set we use:** _(Amazon link — add yours here)_

**Tips:**
- Keep the **Pi within about 1 meter** of the light's controller — the Pi's built-in
  Bluetooth is weak and won't hear it from across a tent.
- Only **one device at a time** can control the light over Bluetooth, so close the
  light's phone app while the campfire is running.
- It's **self-healing**: if the light drops out or the Bluetooth gets cranky, the app
  keeps retrying and even resets the Bluetooth on its own — just give it a few seconds.
- The campfire is **optional**; if no light is connected, nothing else is affected.

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
- **Mushroom lamp won't light** ("Finding the light…" for a while) → move the Pi closer
  (within ~1 m), make sure the light has power, and close its phone app. It auto-resets
  the Bluetooth after a few tries, so give it ~30 seconds. If it says the Bluetooth
  library is missing, run Install again (it adds `python3-bleak`).

## 🧱 For developers

Vanilla JS, no frameworks, no build step. Node 18+, Express + `ws` + `better-sqlite3`.
The server is the single source of truth: clients send `{type:"action", op, payload}`
over one WebSocket; the server validates (fail-loud — invalid state throws), persists
to SQLite, and broadcasts role-scoped snapshots (players never receive another
player's `hidden_desire`, a card's GM notes/hidden entries, or `dm_only` clocks —
enforced server-side).

Two HTTP servers share **one** WebSocket pool: the player app on `PORT` (3000) and the
GM app on `GM_PORT` (3001). The split is route-level — the GM app never registers the
player routes — so a GM action on 3001 still snapshots out to players on 3000 because
`ws.js` keeps a single shared client set across both servers. Each browser mints a
persistent device UUID (localStorage) and sends it in `hello`; characters are scoped to
their `device_id`, and `ws.js` flips a device online/offline on connect/disconnect.

```
server.js        entry: two Express apps (player :3000 + GM :3001), ws, logging
config.js        tunable constants (PORT/GM_PORT, card kinds, particle effects, conditions…)
rules.js         pure rule helpers (diceForRank — THE rank→dice mapping)
db.js            better-sqlite3 schema + prepared statements (card, device, token tables…)
state.js         in-memory canonical state, all ops, role-scoped snapshots
ws.js            websocket plumbing: hello/snapshot/action/error; shared client pool + device presence
assistant.js     prep-time AI campaign assistant (GM port): realtime-voice token mint,
                 shared tool executor over state.ops, image generation, and the
                 prep-pack importer (/assist/import + image queue) — internet only
public/          the pages + shared js (ws-client, dice/clock renderers,
                 npc-reveal.js + npc-fx.js drive the reveal cards & particles)
public/builder.html  self-contained, OFFLINE Story Arc Builder — email it to a co-GM;
                 exports a prep pack that /assist/import turns into cards
*.sh             the double-click toolkit (INSTALL/START/STOP/UPDATE — all tee
                 their output into logs/); scripts/_lib.sh is the shared plumbing
systemd/         service template (installer fills in user + path)
test/smoke.js    self-test run by install + update against a throwaway DB
```

Run the self-test any time: `node test/smoke.js`.

**Roadmap** (per `HANDOFF.md` phases): Phase 1 (playable core + teaching page) ✅ ·
Phase 2 (initiative + clocks) ✅ · Phase 3 (projector battle map) ✅ · Phase 4
(cinematic presentation — reveal cards, particle effects, projector transitions) ✅.
The map and reveal cards are system-agnostic by design — tokens, the grid, and the
cards know nothing about game rules.

### The battle map (Phase 3)

All from the GM screen on a phone: **upload** a map image → **calibrate** by tapping
the top-left and bottom-right corners of a clean span of squares and saying how many
cells it covers → the map goes live on the projector. Tokens (players, monsters,
terrain, pulsing glow lights) live in **grid coordinates** and belong to a specific
map, so switching the active map swaps in that map's own tokens; players get a d-pad
on their sheet to walk their own token. The camera is a pure view transform — minimap
tap-to-aim, nudge/zoom/rotate buttons, and named view bookmarks to snap between.
Initiative accepts **anything**, not just characters — type "Goblin Pack" or "The
Ritual" and it slots into the turn order. Switching the map off returns the
projector to campfire mode (roster + clocks + embers).

Art is user-replaceable: drop real dice/symbol images into `public/assets/dice/` and
`public/assets/symbols/` (names like `green.png`, `triumph.png`) and the learn page
upgrades its placeholders automatically.
