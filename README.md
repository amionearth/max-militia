# MAX MILITIA (V2)

An original, fan-made 3D low-poly jetpack arena shooter for the browser, built with Three.js and TypeScript (Vite). It is inspired by the 2D classic, but all art, audio and names are original and generated in code.

> Fan-made project. Not affiliated with Appsomniacs or Miniclip.

## Run it locally

Requirements: Node.js 20 or newer. The project uses pnpm, and `npx pnpm@10.18.0 ...` works without installing it.

```powershell
cd game
npx --yes pnpm@10.18.0 install
npx --yes pnpm@10.18.0 dev:all      # game on http://127.0.0.1:3000, multiplayer server on ws://127.0.0.1:8787
```

Open http://127.0.0.1:3000. If port 3000 is busy, set another port first (`$env:PORT='3001'` in PowerShell, or stop the process that holds 3000). Practice Range works without the server; Create Room and Join Room need `dev:all`, or `pnpm start:server` in a second terminal.

To play with friends on the same Wi-Fi, run Vite with `--host 0.0.0.0` and share `http://<your-LAN-IP>:3000`. The client connects to `ws://<same host>:8787` automatically.

## What is in V2

| Area | What it does |
| --- | --- |
| Map | **Skyspire**: a vertical floating-platform arena (central pylon, tiers, bridges, side towers, crates, void kill zone) built from `src/data/arena.json`. |
| Flow | Callsign screen, main menu, locker (customization), join screen, lobby, HUD, pause menu and results screen. |
| Rooms | Create a room, share the 5-character code, up to 6 pilots, Red vs Blue team deathmatch. The host sets kill and time limits. The server is authoritative; clients predict, interpolate, reconnect and show ping. |
| Grenades | Frag, Gas and Proximity with limited stock that recharges. |
| Weapons | Uzi and Desert Eagle (starters) plus pickup crates: Rift AR, Scatter Pump, Lance Rifle and Halo Magnum. Stats live in `src/data/weapons.json`. |
| Avatar | One base body with swappable cosmetic slots (skin, headgear, face, torso, legs, boots, jet flame, emote) from `src/data/avatar_slots.json`. Saved in the browser and sent to the room. |
| Audio | Every sound is synthesized with Web Audio. No audio files. |

## Controls

| Input | Action |
| --- | --- |
| W A S D | Move |
| Mouse | Aim (click the game to capture the mouse) |
| Left click | Fire |
| Right click or G | Throw the selected grenade |
| 3 / 4 / 5 or Q | Select Frag / Gas / Proximity, or cycle |
| Space | Jump; hold in the air for the jetpack (short bursts are more efficient than holding) |
| Shift | Sprint |
| R | Reload |
| 1 / 2 / mouse wheel | Switch weapon |
| V | Emote |
| Tab (hold) | Scoreboard |
| Esc or P | Menu (online matches keep running while it is open) |

## Project layout

```
src/
  main.ts            boot, screen flow, wiring (UI <-> Game <-> RoomClient)
  engine/            renderer, fixed-step loop, input, procedural audio
  game/              Game orchestrator, Arena (map), Avatar, camera, FX, dummies, world FX
  shared/            deterministic simulation used by BOTH client and server
                     (collision, jetpack, weapons, grenades, hitboxes, playerSim, MatchSim, protocol, cosmetics)
  net/               RoomClient (WebSocket + reconnect) and Session (practice / online prediction)
  ui/ui.ts           all DOM screens and the HUD (player text is always set with textContent)
  data/              weapons, grenades, pickups, match rules, arena, avatar slots (JSON)
server/              WebSocket server (index.ts) and room manager (rooms.ts)
tests/               Vitest unit tests (shared simulation, protocol, room server)
scripts/smoke.mjs    Playwright end-to-end test (name, locker, practice, two-player room)
```

Because `src/shared` also runs on the server, movement, weapons, grenades and hit detection are identical online and offline. The server validates every input frame (rate limited and clamped) and owns health, scores, pickups and grenades.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Vite dev server only |
| `pnpm start:server` | Multiplayer server only (`PORT`, `ALLOWED_ORIGINS`, `MAX_ROOMS`, `MAX_PLAYERS_PER_ROOM`) |
| `pnpm dev:all` | Both together |
| `pnpm typecheck`, `pnpm test` | Type check and unit tests |
| `pnpm smoke` | End-to-end browser test (needs `dev:all` running; set `SMOKE_URL` if not on port 3000) |
| `pnpm build` | Production build into `dist/` |

## Hosting: Vercel plus a WebSocket host

Vercel can host the **front end** (static files in `dist/`, configured by `vercel.json`). It cannot host the multiplayer server, because serverless functions cannot keep a long-lived WebSocket match loop. Deploy the two parts separately:

1. Deploy the server to any Node host that supports WebSockets (Render via `render.yaml`, Railway, Fly.io or a VPS). Set `ALLOWED_ORIGINS` to your Vercel URL.
2. On Vercel, import the `game` folder and set the environment variable `VITE_WS_URL=wss://<your-server-host>`.
3. Practice Range works on Vercel without the server; online rooms need step 1.

## Legal and art notes

All geometry is built from primitives, and all textures and sounds are generated in code. No assets from the original game are used. The reference documents in the parent folder describe the inspiration only.

## Exact deployment settings

**Game server (Render, from `render.yaml`)**

| Setting | Value |
| --- | --- |
| Root directory | `game` |
| Build command | `corepack enable && pnpm install --frozen-lockfile` |
| Start command | `pnpm start:server` |
| Health check path | `/health` |
| `ALLOWED_ORIGINS` | your Vercel URL, for example `https://max-militia.vercel.app` (comma separated for several) |
| `MAX_ROOMS`, `MAX_PLAYERS_PER_ROOM` | optional, defaults 20 and 6 (hard cap 6) |

The public WebSocket URL is `wss://<service-name>.onrender.com` (Render terminates TLS for you). Free instances sleep when idle, so the first connection after a pause can take about a minute.

**Front end (Vercel)**

| Setting | Value |
| --- | --- |
| Root directory | `game` |
| Framework preset | Vite (detected from `vercel.json`) |
| Build command | `pnpm exec vite build` |
| Output directory | `dist` |
| Environment variable | `VITE_WS_URL=wss://<service-name>.onrender.com` (build time, no secrets) |

**Invite links.** In the lobby, "Copy invite link" copies `https://<your-vercel-host>/?room=ABCDE`. Opening it asks for a callsign, then shows the join screen with the code filled in.

## Status

Ready and verified locally (unit tests plus a two-browser Playwright run): callsign screen, customization with saved cosmetics, Skyspire map, practice range, server-authoritative rooms with invite links, team deathmatch with kill and time limits, results and return to lobby, six weapons with server-chosen random pickups, three grenade types, procedural sound with mute and volume.

Needs an external step: deploying the server to a WebSocket host and the client to Vercel (accounts and URLs are yours; the configuration is included). Until `VITE_WS_URL` points to a public server, online rooms only work on your own network or machine.

Known limitations: the `sound effects/` folder mentioned in the V2 brief was not present in the project, so audio is entirely original Web Audio synthesis (the mixer accepts WAV playback later, but none is shipped, and rights for any supplied clip must be confirmed first). Only Red vs Blue team deathmatch exists. Capacity is capped at 6 players per room and has not been load tested. Cosmetics are a compact starter set (see `src/data/avatar_slots.json`), not the full catalog from the reference files. Desktop keyboard and mouse only.
