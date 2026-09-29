# AppsByTy: Code Runner

**RUN. CODE. FIX. REPEAT.**

An endless 3-lane runner set inside a giant computer. You play the AppsByTy developer, sprinting
along three data streams, fixing bugs, dodging errors and surviving a system that gets more
corrupted the further you go.

Three.js + TypeScript + Vite, structured for Capacitor (iOS/Android). All art is procedural
(geometry, shaders, canvas textures). All audio is synthesised with the Web Audio API behind
`AudioManager`, and any sound can be swapped for a file with `audio.loadFile(id, url)`.

## Graphics

Graphics always run at top quality: no graphics menu and no automatic downgrade for performance.
The only fallback is a black-screen safety net: if a device's GPU fails to draw the frame at all, the
game switches the failing effect off so the game is visible instead of black.

- PBR materials with procedural normal/roughness maps: brushed metal, chrome, carbon fibre, glass, fabric.
- Per-stage baked environment maps (PMREM) for real metal/glass reflections.
- Planar mirror reflections on the data-stream floor, dynamic shadows from a key light that follows the runner.
- Post: depth of field (menus), bloom, radial motion blur at speed, chromatic aberration, vignette, film grain, glitch (only at key moments).
- Lighting moods per stage: clean = cool cyan, minor bugs = blue/purple, corrupted = red warning strobe,
  virus = dark, THE CORE = gold/cyan energy.
- Particle shapes drawn in-shader (sparkles, shards, code glyphs, glitch pixels, velocity streaks) plus a dark
  alpha-blended layer for virus smoke. Bug fixes assemble a checkmark out of particles.
- Cinematic camera: handheld drift, speed FOV, lower/livelier in DEBUG / ADMIN, a look-up shot when the virus arrives.

Stability on phones:

- **No GPU work is created mid-run.** Every shader is compiled for the render target it is really drawn into, and
  every hidden effect (power-up rings, bug-fix checkmarks, boss beams, halo, shield, the virus) is drawn once
  off-screen in the menu. One-shot effects are pooled, never created/destroyed per event.
- **GPU reset recovery.** If iOS drops the WebGL context, the run pauses, graphics are rebuilt in place (baked
  lighting re-baked) and you resume where you were. The page is never reloaded.
- **Beat sync never restyles the HUD.** The music's beat only changes opacity/transform on a few elements. Rewriting a
  CSS variable / box-shadow / filter on the glass HUD every frame got the page killed by iOS Safari (found with the
  on-device crash tests in `src/dev/stress.ts`, built with `VITE_STRESS=1`).
- **Flight recorder.** If the system kills the page mid-run, the next launch shows a short report (distance, FPS,
  whether the GPU had reset) so the cause is known.

## Music & sound

- **Original procedural hip-hop soundtrack** (`src/audio/HipHopEngine.ts`): 808s with glides, punchy kicks, flammed
  claps, swung hats with rolls, pads, FM bell hooks, supersaw stabs, formant vocal chops and glitch fills. No samples,
  no copyrighted music.
- Three gameplay tracks rotate automatically (every ~32 bars and on stage changes), plus a boss track.
- Modes: MENU (slow, atmospheric), RUN, DEBUG (more layers, glitch), BOSS (dark phrygian, distorted), GAME OVER (sinks away).
- **Your own music:** drop `.mp3/.ogg/.wav/.m4a` into `assets/music/` and rebuild — see `assets/music/README.md`
  (filename picks the mode: `menu`, `boss`, `debug`, `gameover`, anything else = gameplay).
- Sound settings (gear icon on the menu, SOUND in pause): music volume, SFX volume, mute music, mute SFX. Saved.
- Beat sync: lighting, road dividers, bloom, HUD glow and particles pulse on the kick/snare.

## Run on Replit

Import this GitHub repo into Replit (Create Repl → Import from GitHub). Press **Run**: it installs and starts
the dev server on port 5173 and opens the webview. **Deploy → Static** builds to `dist/` and publishes it
(config in `.replit`).

## Run

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # typecheck + production build to dist/
```

URL flags: `?debug` (FPS / draw calls), `?seed=123` (fixed layout), `?quality=low|medium|high|ultra` (testing only; default is ultra).

Tests (need `npx playwright install chromium` once, and the dev server running):

```bash
npm run test:play       # fairness solver (40 seeds x 9 km) + keyboard/touch controls
npm run test:scenarios  # 15 scripted checks: dodge/jump/slide, near misses, damage, power-ups, boss, crash
npm run test:bot        # lockstep autopilot across 24 seeds, prints balance stats
npm run test:shots      # screenshots of key moments into shots/
npm run test:gpu-reset  # a GPU reset mid-run must pause + recover in place, never reload
npm run test:stalls     # no shader may compile or be thrown away during a run (slow on a software GPU)
npm run build:single -- out.html "label"   # one self-contained HTML file (fonts + 3D model inlined)
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
  render/  Quality (tiers), MaterialLib (procedural PBR), Environment (PMREM), Reflection (planar mirror),
           Watchdog (black-screen fallback, GPU reset hand-off, flight recorder)
  fx/      PostFX (DOF, bloom, motion blur, glitch, grade), FXDirector (event → effects), Particles (shaped sprites), Trails, SpeedLines
  audio/   AudioManager (buses, modes, beat sync, SFX), HipHopEngine (procedural soundtrack), synth (instruments), MusicFiles (drop-in tracks)
  ui/      HUD (glass dashboard, bug-fix cards, banners, sound settings, SYSTEM FAILURE, reboot), premium.css
assets/music/  drop-in soundtrack files
scripts/   playtest, scenarios, bot, shot (+ lib), check-gpu-reset, check-shader-stalls, build-single
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
