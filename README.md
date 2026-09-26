# AppsByTy: Code Runner

**RUN. CODE. FIX. REPEAT.**

An endless 3-lane runner set inside a giant computer. You play the AppsByTy developer, sprinting
along three data streams, fixing bugs, dodging errors and surviving a system that gets more
corrupted the further you go.

Three.js + TypeScript + Vite, structured for Capacitor (iOS/Android). All art is procedural
(geometry, shaders, canvas textures). All audio is synthesised with the Web Audio API behind
`AudioManager`, and any sound can be swapped for a file with `audio.loadFile(id, url)`.

## Run

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # typecheck + production build to dist/
```

URL flags: `?debug` (FPS / draw calls), `?seed=123` (fixed layout), `?quality=low` (no post-processing).

Tests (need `npx playwright install chromium` once, and the dev server running):

```bash
npm run test:play       # fairness solver (40 seeds x 9 km) + keyboard/touch controls
npm run test:scenarios  # 15 scripted checks: dodge/jump/slide, near misses, damage, power-ups, boss, crash
npm run test:bot        # lockstep autopilot across 24 seeds, prints balance stats
npm run test:shots      # screenshots of key moments into shots/
```

## How it plays

| Action | Keyboard | Touch |
|---|---|---|
| Change stream | ← → / A D | swipe left/right |
| Jump | ↑ / W / Space | swipe up |
| Slide (in air: slam down) | ↓ / S | swipe down |
| Pause | Esc / P | pause button |

- **Green bugs** are friendly: touch one to fix it (BUG FOUND → PATCHING… → BUG FIXED ✓). Each fix gives score, XP, coins, +5% health and builds the DEBUG COMBO.
- **Red things hurt.** Firewalls and 404 barriers (jump), error windows and virus drones (slide), corrupted code blocks (change lane), glitch bugs that charge, and malware bugs that hop lanes (watch the ⚠ marker).
- **SYSTEM HEALTH** starts at 100%. A hit costs 20% (a graze 10%). Bug fixes +5%, patches +10%. At 0%: SYSTEM FAILURE.
- **DEBUG COMBO** multiplier tiers: x1 → x2 (5) → x3 (12) → x5 (25) → x10 (45). A hit or 3.4 s idle breaks the chain.
- **Power-ups:** DEBUG MODE (invincible, auto-fixes bugs), FIREWALL (absorbs one hit), CODE BOOST (overclocked + invincible), BUG MAGNET, RAM BOOST (×2 score, faster moves), ADMIN ACCESS (rare: deletes everything ahead, ×3 score).
- **Corruption stages:** Clean Computer → Minor Bugs → System Errors → Corrupted System → Virus Infection → Critical System Failure → THE CORE.
- **THE VIRUS** (boss, from 1,350 m): survive its dropped packets and grab gold security patches until PATCHING SYSTEM hits 100% → VIRUS DELETED ✓.

## Structure

```
src/
  core/    GameManager (state machine + loop), Config (all tuning), Theme (stages + shared shader palette),
           EventBus, GameState, BestScore (best + lifetime stats)
  game/    PlayerController, Character (procedural rig), CameraController, ComboSystem,
           ObstacleWatcher (clears / near misses), PowerUps, VirusBoss
  world/   Track (data streams + motherboard), ComputerWorld (instanced districts, holo windows, core),
           Obstacles (hazards + bad bugs), Pickups (collectibles, good bugs, power-ups), Spawner (fair generation)
  fx/      PostFX (bloom, glitch, tints), FXDirector (event → effects), Particles, Trails, SpeedLines
  audio/   AudioManager (synth SFX + generative music)
  ui/      HUD (developer dashboard, bug-fix cards, banners, SYSTEM FAILURE, reboot)
scripts/   playtest, scenarios, bot, shot (+ lib)
```

Key decisions:

- **Player stays at z = 0 and the world scrolls.** Everything stores the run distance where it
  reaches the player, so long runs never drift.
- **Fixed 120 Hz simulation**, rendering at display rate.
- **Fair by construction.** The spawner tracks reachable lanes and treats corrupted blocks as walls.
  It never needs a jump and a slide in the same spot, and gives charging bugs room. An independent
  solver verifies this.
- **One palette drives everything.** Stages, DEBUG MODE and THE CORE re-colour the whole world
  through shared `THEME` uniforms.
- **EventBus decoupling.** Gameplay emits events; FX, audio and the HUD subscribe.
