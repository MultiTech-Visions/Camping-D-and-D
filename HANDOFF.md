# Campfire Saga — Claude Code Handoff Document

A self-hosted companion app for a homebrew narrative-dice tabletop RPG, designed to run on a Raspberry Pi 5 at a campsite with no internet. Players connect to the Pi's own WiFi hotspot from their phones. The Pi also drives a projector (HDMI) that displays a shared battle map at night.

**This document is the single source of truth for the build, and it matches `CAMPFIRE_SAGA_RULEBOOK.md`.** Read it top to bottom before writing code. The game system is finalized; do not redesign it. Where a decision is the GM's to make at runtime, it is called out as configurable.

---

## 0. Critical engineering constraints (read first, non-negotiable)

1. **FAIL LOUD. NO SILENT DEFAULTS.** Never write defensive fallbacks like `JSON.parse(x) || []` or `value ?? someDefault` to paper over missing/malformed data. If data is missing or malformed, that is a bug, and the code must throw so it surfaces immediately. The only blessed empty defaults are genuinely-optional user text fields, named explicitly in the data model (`gear`, `notes`, `flavor`, `hidden_desire`). Anywhere else, if state is wrong, throw.

2. **No React. No Docker.** Vanilla JavaScript on the client. Plain Node.js process under systemd. Server-rendered HTML where sensible, vanilla JS for interactivity.

3. **The server holds the single source of truth.** Clients never own canonical state. A client requests a change over WebSocket; the server validates, mutates its own state, persists, and broadcasts to all clients. No client-authoritative state, ever.

4. **Efficiency: one database hit, not many.** Group related reads/writes. A character plus its conditions plus its initiative slot is one row/object, one query. Use `better-sqlite3` (synchronous, throws on bad SQL — fits fail-loud).

5. **Modularity over duplication.** If a function nearly does what a new feature needs, make it dynamic and reuse it. One clock renderer, one character-card renderer — not parallel near-copies.

6. **Three coordinate spaces for the map. Tokens never live in screen space.** Detailed in §7. Tokens are stored in grid coordinates; the camera is a pure view transform applied only at render time.

7. **Build in the phased order in §10.** The character tracker and teaching page come first and must be fully playable before any projector/map work. The projector is a garnish, not a dependency.

---

## 1. The game system (finalized — matches the rulebook, do not redesign)

A freeform, collaborative-storytelling RPG using the physical narrative dice set. **The app never rolls dice.** Dice are physical, rolled in a passed tray. The app holds character state, the shared map, clocks, and teaching material.

### The physical dice set (fixed counts)
**3 green, 2 yellow, 2 blue, 3 purple, 2 red, 2 black.** These counts are a hard ceiling on any single roll. The hardest difficulty the GM can ever assemble is **3 purple + 2 red + 2 black**.

- **Green — Ability** (positive): base action dice; count = attribute rank.
- **Yellow — Proficiency** (positive): upgraded green with the only **Triumph** face. Appears only at attribute ranks 4–5 (see rank→dice).
- **Blue — Boost** (positive): temporary bonus; granted by the GM or by a player spending advantage.
- **Purple — Difficulty** (negative): base difficulty, set by the GM.
- **Red — Challenge** (negative): serious opposition; the only **Despair** face.
- **Black — Setback** (negative): situational penalty.

### Outcome symbols (players read these off the physical dice; the app does NOT compute them)
- Success vs Failure cancel 1:1. Net ≥1 success = the action works (ties fail).
- Advantage vs Threat cancel 1:1, independently of success/failure. Leftover advantage is spent; leftover threat is inflicted (even on a success).
- **Triumph** (yellow) = a success plus something great. **Despair** (red) = a failure plus something terrible. They do not cancel each other.

### The four attributes
**Brawn, Constitution, Magic, Wits.** Each is rated 0–5. An attribute's rank = the dice rolled for actions it governs.

### Rank → dice (THE core mapping — single source of truth)
The set has exactly 3 green + 2 yellow, so rank maps directly:

| Rank | Dice |
|------|------|
| 0 | none (cannot act with this attribute) |
| 1 | 1 green |
| 2 | 2 green |
| 3 | 3 green |
| 4 | 3 green + 1 yellow |
| 5 | 3 green + 2 yellow |

**There is NO separate proficiency/skill mechanic.** High rank *is* mastery; yellows are earned by raising an attribute to 4–5 through play. Implement this as one helper (`diceForRank(rank) -> {green, yellow}`) used everywhere a pool is built. Reject rank <0 or >5 (throw).

### Character creation
- Distribute **4 points** across the four attributes.
- **No attribute may exceed rank 2 at creation.** (Ceiling is 5, reached only through play.)
- **Constitution may be 0** (a "glass cannon").
- Optional **flavor label** (e.g. "lightning") — cosmetic, no mechanical effect.
- A **hidden desire** — one secret string, GM-only.
Validate on the server: the four attributes sum to exactly the creation budget and each is within 0..creation-max. Throw on violation. (`STARTING_POINTS=4`, `CREATION_MAX=2`, `CEILING=5` are config constants.)

### Constitution as buffer
- On a **failed** action, the rank that would drain from the used attribute may instead be taken from **Constitution** (drain 1 Con), protecting the specialty.
- When **Constitution = 0**, further failures drain the actual attribute used.
- A failure while Con is at 0 is when "down for the count" (unconscious/captured/dead) becomes a GM call — narrative, not numeric.

### The drain mechanic
- On a failed action, **the used attribute's rank drops by 1 for the current encounter** (or Con drops, per buffer above). Because dice come from rank, **yellows strip first** automatically (rank 5→4 removes a yellow). Do not implement a separate "which die drained" tracker — just reduce effective rank and re-derive dice via `diceForRank`.
- If an attribute's effective rank hits **0, the character cannot take actions governed by it** until refilled.
- **Effective rank = base rank − drain[attr]**, clamped at ≥0 by throwing if it would go negative (corrupt state), never by silent default.

### Refill
Every encounter is a self-contained vignette. **At encounter end, all drain (attributes and Constitution) refills to full.** Drain never carries across encounters.

### Resolution → clocks (how the app/GM applies a physical roll)
The table reads the dice; the GM applies the effect to clocks. Default conversions (the app surfaces clocks and lets the GM/players click; these are the house rules to teach):
- **Clean success:** fill 1 segment of the target progress clock.
- **Net advantage (positive):** every 2 advantage = +1 extra segment OR a blue die to an ally OR a narrated benefit (player choice). A single leftover advantage = a small flourish / one blue die.
- **Triumph:** +1 extra segment and a dramatic boon.
- **Net threat (even on a success):** the danger clock advances ~1 per 2 threats; a single threat is a minor setback.
- **Despair:** danger clock +1 and a nasty event.
- **Bare failure (no threats):** drain only — the danger clock does **NOT** advance on a plain miss. Danger advances on threats, despair, and GM fiat.

### Turn model (player-facing — monsters never take turns)
- Go around the circle. Each player declares an action and rolls. **The GM almost never rolls** — they set the negative dice; the acting player rolls.
- Enemy actions are consequences folded into the player's roll: success-with-threat = the enemy gets a lick in; failure = the enemy fully acts (and the player drains / spends Con). No monster turn, no monster dice pool.
- The GM may point a consequence at any character (freeform; no rule).

### Enemies and obstacles (no stat blocks)
An enemy/obstacle = **a difficulty** (how many purple/red/black dice it imposes) **+ a clock** (successes to overcome). No HP, no ability scores, no monster initiative.

### Clocks (win condition + tension engine)
A segmented circle (4/6/8 typical).
- **Progress clocks:** players fill via successes; full = obstacle overcome (win condition for any challenge).
- **Danger clocks:** the GM fills on threats/despair/fiat; full = bad thing happens. Encounters are often a race between a progress and a danger clock.
- **Visibility:** every clock is **visible** (shown on projector + roster) or **dm_only** (secret); a dm_only clock can be flipped to visible in one tap when the fiction reveals it.

### Progression (single track, GM-tunable at runtime)
- **+1 attribute point every N encounters** (default **N = 3**), placed in any attribute, up to the ceiling of **rank 5**. Raising an attribute to 4–5 is how yellow dice are earned. **That is the entire progression — no proficiency track, no feats, no overflow rule.**
- **`N` must be GM-editable live** (a setting on the GM screen). Do not hardcode 3 except as the config default.

---

## 2. Tech stack

- **Runtime:** Node.js 20+ (ships with Raspberry Pi OS Bookworm; verify `node -v`).
- **Server:** Express (HTTP + static) + `ws` (WebSockets).
- **Persistence:** `better-sqlite3` — synchronous, single file, throws on bad SQL.
- **Client:** vanilla JS, no framework, no build step.
- **Projector rendering:** **PixiJS** (2D WebGL), vendored locally (no CDN — no internet at the campsite). Display client only.
- **Process management:** systemd (§9).
- Vendor every dependency locally; `npm install` at home before the trip, `node_modules` travels with the project. Assume zero internet at runtime.

---

## 3. Directory layout

```
campfire-saga/
  server.js                 # entry: Express + ws
  db.js                     # better-sqlite3 setup, schema, prepared statements
  state.js                  # in-memory canonical state + load/persist
  ws.js                     # websocket message handling + broadcast
  config.js                 # tunable constants (STARTING_POINTS, CREATION_MAX, CEILING, N, clocks)
  rules.js                  # diceForRank() and other pure rule helpers (shared, reused)
  public/
    index.html              # landing: pick/create character
    player.html             # player: builder + tracker + token-remote tabs
    dm.html                 # GM dashboard
    display.html            # projector full-screen (PixiJS)
    learn.html              # teaching / how-to-play (the teaching aid)
    css/app.css
    js/
      ws-client.js          # shared websocket connect + state-sync helper
      player.js
      dm.js
      display.js            # PixiJS renderer (map, tokens, glow, clocks)
      learn.js
    assets/
      dice/                 # PLACEHOLDER: green/yellow/blue/purple/red/black images (user provides)
      symbols/              # PLACEHOLDER: success/failure/advantage/threat/triumph/despair (user provides)
      maps/  tokens/
    vendor/pixi.min.js      # vendored, no CDN
  data/campfire.db          # sqlite (gitignored; created on first run)
  systemd/campfire-saga.service
  package.json
  README.md
```

Keep nesting shallow.

---

## 4. Data model

**The character is the core object**; conditions, initiative membership, drain, granted blue dice, and progression hang off it. Map, camera, grid calibration, and clocks are the other top-level pieces.

### `character`
```
id              INTEGER PRIMARY KEY
name            TEXT NOT NULL
concept         TEXT NOT NULL          # one-line description, required
brawn           INTEGER NOT NULL       # base rank 0..5 (0..2 at creation)
constitution    INTEGER NOT NULL       # 0..5 (0..2 at creation; may be 0)
magic           INTEGER NOT NULL       # 0..5
wits            INTEGER NOT NULL       # 0..5
flavor          TEXT NOT NULL          # cosmetic label; starts '' (blessed empty default)
hidden_desire   TEXT NOT NULL          # GM-only; starts '' (blessed empty default)
gear            TEXT NOT NULL          # freeform; starts '' (blessed empty default)
notes           TEXT NOT NULL          # freeform; starts '' (blessed empty default)
encounters_done INTEGER NOT NULL       # drives progression; starts 0
```

**Runtime-only (in-memory state):**
```
drain: { brawn, constitution, magic, wits }   # ranks drained THIS encounter; 0 at start
blue_dice: [ {id, note, encounter, ts} ]       # BANKED Boost dice, each with a required
                                               #   origin note (where/when it was earned).
                                               #   Persists across encounters; spent by id.
                                               #   Legacy integer counts migrate to noteless
                                               #   dice on load. (snapshot also exposes
                                               #   granted_blue = blue_dice.length for renderers)
conditions: [condition]
in_initiative: BOOLEAN
initiative_order: INTEGER
```

**Derived (compute, never store with a silent default):**
```
effective_rank(attr) = base_attr - drain[attr]      # throw if < 0 (corrupt state)
diceForRank(effective_rank) -> {green, yellow}        # the §1 mapping; throw if out of 0..5
# total pool also adds blue_dice.length (consumed on use) and the GM's negative dice.
```
No proficiency fields exist. There is no "yellows last" tracker — yellows-first-on-drain falls out of re-deriving dice from the reduced rank.

### `condition`
```
id INTEGER PRIMARY KEY, char_id -> character.id, kind TEXT NOT NULL
# fixed built-in set for MVP: dead | poisoned | prone | stunned | blessed | ...
# 'dead' renders as token/roster grayed out with an X. Custom conditions are post-MVP.
```

### `clock`
```
id INTEGER PRIMARY KEY
label       TEXT NOT NULL
segments    INTEGER NOT NULL      # total (4/6/8)
filled      INTEGER NOT NULL      # 0..segments; throw if out of range
kind        TEXT NOT NULL         # 'progress' | 'danger'
visibility  TEXT NOT NULL         # 'visible' | 'dm_only'
token_id    INTEGER               # nullable optional attachment
note        TEXT NOT NULL DEFAULT ''  # GM-only long-term bookkeeping (origin,
                                  #   purpose, reminders). Even on a 'visible'
                                  #   clock the note is GM-only — stripped from
                                  #   player + display snapshots.
```

### `token` (map only — Phase 3+)
```
id, label, kind ('pc'|'monster'|'glow'|'terrain'), char_id (nullable, for 'pc'),
col INTEGER NOT NULL, row INTEGER NOT NULL,   # GRID coords, never pixels/screen
art TEXT, glow_color TEXT, glow_radius REAL, glow_pulse REAL
```

### `map_calibration` (single active map; Phase 3)
```
id, image_path, image_w, image_h, cell_size REAL, offset_x REAL, offset_y REAL
# no grid rotation; maps are axis-aligned to their own pixels.
```

### `camera` (runtime, broadcast — Phase 3)
```
center_x, center_y (image pixels), zoom, rotation (view only; does not affect token grid coords)
```

### `game` (singleton runtime settings)
```
reward_every_n_encounters INTEGER   # default config (3); GM-editable live
active_map_id INTEGER                # nullable
```
(No proficiency-rate setting — progression is the single attribute-point track.)

---

## 5. WebSocket state-sync contract

One WebSocket per client; each declares its role on connect.

- `hello` `{role: player|dm|display, char_id?}` → server replies `snapshot` (role-scoped, see scoping).
- Client change request: `{type:"action", op, payload}`. Server validates, mutates, persists, broadcasts. On failure it sends `{type:"error", op, reason}` — it never silently ignores/defaults.
- Server broadcast: `{type:"patch", entity, id, data}` (diffs) or full `snapshot` on structural change.

### Operations
Character/play:
- `character.create` `{name, concept, brawn, constitution, magic, wits, flavor?, hidden_desire?}` — validate sum == `STARTING_POINTS` and each attr in 0..`CREATION_MAX`. Throw on violation.
- `character.update_sheet` `{char_id, flavor?, gear?, notes?}`
- `character.set_drain` `{char_id, attr, amount}` — set current rank-drain on an attribute; validate 0..base_rank.
- `character.absorb_with_con` `{char_id}` — drain 1 Constitution instead of the used attribute.
- `character.add_blue` `{char_id, note}` — bank one Boost die with its (required) origin note; records the `encounter` number + timestamp.
- `character.spend_blue` `{char_id, die_id}` — cash in (remove) one banked die by id.
- `character.edit_blue_note` `{char_id, die_id, note}` — revise a banked die's origin note.
- `character.end_encounter_refill` `{char_id?}` — refill all drain (all chars if no id); increment `encounters_done`; apply progression: when `encounters_done % reward_every_n_encounters == 0`, the character is owed +1 attribute point (surface a prompt/marker for the player to place it, capped at rank 5). **Banked blue dice persist across encounters** — they are not cleared here.
Conditions: `condition.add` `{char_id, kind}` / `condition.remove` `{condition_id}`.
Initiative: `initiative.add`/`initiative.remove` `{char_id}`, `initiative.reorder` `{ordered_char_ids}`, `initiative.set_turn` `{char_id}`.
Clocks: `clock.create` `{label, segments, kind, visibility, token_id?, note?}`, `clock.set_filled` `{clock_id, filled}` (validate 0..segments), `clock.set_visibility` `{clock_id, visibility}` (the reveal), `clock.set_note` `{clock_id, note}` (GM-only long-term note; omit/empty to clear), `clock.delete` `{clock_id}`.
Map/camera (Phase 3+): `map.upload` (HTTP, §6) then `map.calibrate` `{image_path, cell_size, offset_x, offset_y}`, `map.set_active`, `token.create`/`token.move` `{token_id, col, row}`/`token.delete`, `camera.update` `{center_x, center_y, zoom, rotation}`.
Game: `game.set_reward_rate` `{reward_every_n_encounters}` — live tuning.

### State scoping (enforce server-side; do not send-then-hide)
- **player:** all characters' public fields, all `visible` clocks (without the GM `note`), conditions, initiative, camera. Receives its OWN `hidden_desire` but never another character's, and never `dm_only` clocks.
- **dm:** everything, including all `hidden_desire`, all `dm_only` clocks, and all clock `note`s.
- **display:** map, tokens, `visible` clocks, roster (names/conditions/initiative), camera. Never `hidden_desire`, never `dm_only` clocks, never clock `note`s.

---

## 6. HTTP endpoints (non-WS)
`GET /` index · `GET /play` player · `GET /dm` · `GET /display` · `GET /learn` · `POST /upload/map` (multipart → saves to assets/maps/, returns `{image_path,image_w,image_h}`) · `POST /upload/token` · static for `public/`.

---

## 7. The three coordinate spaces (map renderer — Phase 3)

State as a header comment in `display.js`.
1. **Image space** — raw pixels of the uploaded map; fixed; `map_calibration` lives here.
2. **Grid space** — `(col,row)` integers from calibration: `col = floor((image_x - offset_x)/cell_size)`; inverse to cell-center for rendering. **Token positions are stored in grid space.**
3. **Camera/screen space** — what the projector shows; derived at render time from the `camera` object only.

**Rule:** tokens stored in grid space, never screen space; the camera is a pure view transform; moving it never alters a token's stored position. Arrow movement changes `(col,row)` by ±1.

**Calibration UX (GM, phone):** upload → pinch/drag to a region with a clear span of cells → place handles across a known N×M span → enter the count → `cell_size = pixel_distance / cell_count` (spanning more cells averages out tap error). Lock → writes cell_size + offsets. No grid rotation.

**Camera remote (GM, phone):** primary = minimap thumbnail with draggable viewport rectangle; secondary = trackpad (relative pan + pinch zoom), zoom ± buttons, fine-nudge arrows, rotation, and saved view bookmarks (named camera positions to snap to mid-session).

**Huge-map note:** Pi 5 GPU max single texture ~4096–8192px. MVP caps maps at single-texture size; architect so tiling can slot in later but **do not build tiling for the MVP**.

**Glow effects:** a glow is a `token` with `kind='glow'` — a soft radial-gradient sprite, blend mode `ADD`/`SCREEN`, animating scale/rotation/alpha on a sine wave. Cheap; dozens fine. Display client only.

---

## 8. The teaching page (`learn.html`) — build in Phase 1

A friendly, plain-language "Getting Started / How to Play" the GM walks through with the group to teach the system. Mirror the rulebook. Sections:

1. **What this is** — collaborative storytelling; GM spins the tale; you describe actions; physical dice decide; no math, no books.
2. **Making your character** — name + one-line concept; spend **4 points** across Brawn/Constitution/Magic/Wits (**max 2 each at creation**, Con may be 0); optional cosmetic flavor label; a hidden desire only the GM sees. Show the plus/minus builder: a "points remaining" counter, and as you raise an attribute the matching number of **green dice images** appear (and a **yellow** appears at rank 4 and 5).
3. **The four attributes** — one sentence each; the key rule that **rank = how many green dice you roll**, and that **Constitution is your buffer** that soaks failure to protect your other dice.
4. **Rank → dice** — the table from §1, emphasizing that nobody starts with a yellow; yellows (and Triumphs) are earned by reaching rank 4–5.
5. **How a turn works** — go around the circle; describe your action; GM names the difficulty (negative dice); roll; read it together.
6. **Reading the dice** — THE CHEAT SHEET. Two tables (below). Success/Failure cancel; Advantage/Threat are separate; Triumph & Despair are the big ones and don't cancel.
7. **The dice, one by one** — the six dice with names/colors/roles (Green Ability; Yellow Proficiency = upgraded green with the Triumph face, earned at high rank; Blue Boost; Purple Difficulty; Red Challenge with the Despair face; Black Setback). No proficiency-swap language — yellows come from rank.
8. **Spending advantage** — improve your action, fill a clock segment, or hand an ally a blue die (the distract-the-guard example).
9. **Getting hurt** — failure drains a rank from the attribute you used (your best dice, the yellows, fray first), or spend Constitution to absorb it; an attribute at 0 can't be used; everything refills after the encounter; with Con at 0 you can be taken down.
10. **Winning & danger: clocks** — progress clocks fill with successes to overcome an obstacle; danger clocks fill on threats/despair and spell trouble when full. Replaces "kill the monster's HP."
11. **Getting stronger** — +1 attribute point every few encounters, up to rank 5; that's how you earn yellow dice. No other leveling.

**Two tables with placeholder image slots (user provides art + final symbol text later):**
- **Dice table** — columns: *Image* (placeholder `assets/dice/<color>.png`), *Name*, *Color*, *What it's for*, *Special face*. One row per die.
- **Symbols table** — columns: *Image* (placeholder `assets/symbols/<symbol>.png`), *Name*, *Meaning*. Rows: Success, Failure, Advantage, Threat, Triumph, Despair.
Render placeholders as obvious labeled boxes (e.g. "DIE IMAGE: green.png — replace me").

---

## 9. Raspberry Pi setup (Bookworm)

### WiFi hotspot (phones connect with no internet)
```bash
sudo nmcli device wifi hotspot ssid CampfireSaga password <choose-one> ifname wlan0
sudo nmcli connection modify Hotspot connection.autoconnect yes
```
Players join `CampfireSaga` and browse to the Pi (NetworkManager hotspot gateway is typically `http://10.42.0.1:3000`). Record the exact IP in the README after first setup.

### systemd (`systemd/campfire-saga.service`)
```ini
[Unit]
Description=Campfire Saga RPG companion server
After=network.target
[Service]
Type=simple
User=<pi-user>
WorkingDirectory=/home/<pi-user>/campfire-saga
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
```
`sudo cp systemd/campfire-saga.service /etc/systemd/system/ && sudo systemctl enable --now campfire-saga`. SQLite persists across reboots.

### Projector
HDMI to projector; display client is full-screen Chromium kiosk:
```bash
chromium-browser --kiosk --app=http://localhost:3000/display
```
Target 1080p, not 4K. Coexists with the user's projection-mapping use at other times.

---

## 10. Phased build order (do not jump ahead)

**Phase 1 — Playable core + teaching aid (no map, no projector).**
- Server scaffold: Express, `ws`, `better-sqlite3`, `config.js`, `rules.js` (`diceForRank`), systemd, fail-loud from the start.
- WebSocket state-sync with role-scoped snapshots (enforce `hidden_desire` / `dm_only` scoping server-side from day one).
- Player: character builder (plus/minus steppers, "points remaining", green dice images appearing per rank and a yellow at rank 4–5; optional flavor label; hidden desire field) + tracker tab (per-attribute drain, Constitution buffer, conditions, gear, notes, banked blue dice with origin notes).
- GM: dashboard of all character cards incl. hidden desires; add/remove conditions; set drain / absorb-with-con; grant blue; end-encounter refill (applies progression); live reward-rate (`N`) control.
- `learn.html` teaching page with both placeholder tables.
- **Exit:** the group makes characters, the GM runs a full encounter (drain, conditions, refill, progression), everyone can learn the system from `/learn`. Fully playable on phones alone.

**Phase 2 — GM combat tools.**
- Initiative / turn-order board (add, drag-reorder, set turn).
- Clocks: create progress/danger, fill/unfill, visibility toggle + hidden→visible reveal, optional token attachment (inert until Phase 3).
- **Exit:** the GM runs the full clock-based loop and secret timers from their phone.

**Phase 3 — Projector map + tokens (night garnish).**
- Display client (PixiJS), map upload + grid calibration (§7), single-texture maps only.
- Tokens in grid coordinates; player token-remote tab (arrow movement, grid space only); PC tokens link to characters.
- Camera remote (minimap+viewport primary; trackpad, zoom, nudge, rotation, saved bookmarks).
- Mirrored roster sidebar on the projection (names, condition icons, dead = grayed + X, whose-turn highlight); visible clocks render on the map.
- **Exit:** at night the GM projects a calibrated map, players move tokens, clocks + roster show on the wall.

**Phase 4 — Glow effects + polish.**
- Additive-blend radial glow tokens, animated, display-client only; saved-encounter/bookmark polish.

Tiling for oversized maps and custom GM-defined conditions are **out of scope**; leave clean seams, do not implement.

---

## 10b. Mushroom lamp (BLE campfire — projector-stand ambiance)

The projector sits on a "mushroom" stand lit by a **Magic Lantern** BLE LED
controller (`config.MUSHROOM_ADDRESS` = `BE:28:55:00:10:24`, name `MELK-OA21`).
The GM can toggle it to glow like a campfire — ambiance when there's no real
fire. **GM screen → ⚙ Settings → 🍄 Mushroom lamp.**

- **WS op** `mushroom.set {on: boolean}` (DM action). Memory-only status in
  `state.mushroom = {on, status, detail}` — **not persisted** (a restart never
  lights the camp on its own); included in every snapshot for the GM toggle.
- **`mushroom.js`** spawns/kills a Python helper, **`scripts/mushroom_flame.py`**,
  which owns the BLE link and animates the fire. The flame is *host-driven*: a
  continuous ~5 Hz stream of colour frames (the controller has no built-in fire
  effect). Measured cost: ~0.2% CPU, ~25 MB — it sleeps between frames and never
  touches the projector's PixiJS/particle pipeline (that's the browser's GPU).
- Hard-won controller quirks (see the helper's comments): FFF3 is
  **write-without-response only** (an acknowledged write is rejected
  `NotPermitted`); under a fast colour stream it powers its output down, so the
  helper **re-asserts the On frame every 4 s**; keep the Pi within **~1 m** or
  its advert isn't heard. BLE allows **one central at a time** — while the lamp
  is on, the phone app / other tools can't use the light.
- **Degrades safely:** if `python3-bleak` is missing or the light is out of
  range, the helper exits and the GM toggle shows "⚠ No light found"; the game
  server is unaffected. `INSTALL.sh` installs `python3-bleak`. Standalone BLE
  tooling lives on the Desktop (`led_tester`, `led_dance`).

## 11. Reminders for the implementer
- Fail loud. No `|| []`, no `?? default`. Throw. Blessed empty defaults: `flavor`, `hidden_desire`, `gear`, `notes` only.
- Server is the source of truth; clients request, server validates + broadcasts.
- One query per logical read; the character object aggregates what a card needs.
- One `diceForRank` helper, one clock renderer, one card renderer — reuse, don't clone.
- Tokens live in grid space; camera is view-only.
- No proficiency anywhere — rank is the dice; yellows-first-on-drain is automatic from re-deriving dice.
- Everything vendored locally; assume no internet at runtime.
- Build Phase 1 fully before the map. The projector is garnish; the tracker + teaching page are the product.
