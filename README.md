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
- **Nothing restyles the HUD per frame.** The music's beat only changes opacity/transform on a few elements, and every
  looping UI animation (low-health pulse, NEW HIGH SCORE, mission cards) is opacity/transform only. Rewriting a CSS
  variable / box-shadow / filter on the glass HUD every frame got the page killed by iOS Safari (found with the
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
- **A DJ mix as the whole soundtrack:** name the parts `mix-1-<title>.mp3`, `mix-2-<title>.mp3`, … It then plays
  through every screen (pause / game over just colour it), part after part, and picks up where you left off next
  time. Parts are streamed, never decoded into memory, so an hour of music is fine on a phone; if a part can't load,
  the built-in soundtrack takes over. Mix files are git-ignored: this repo is public, so commercial music stays out
  of it (and out of any store build without a licence).
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
npm run test:progression # saves, migration, levels, coin bank, missions, set payout -> multiplier
npm run test:boss        # all four bosses end to end + the combat checklist (good and average autopilot players)
npm run test:shop        # buying, level locks, outfits, trails, upgrades, boosts, shop/profile screens, saves
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
- **Boss fights** (`src/boss/`): MALWARE BEAST (1,050 m), FIREWALL (2,550 m), CODE BREAKER (3,450 m) and the final
  boss SYSTEM CRASH (4,450 m), then tougher MK II versions every 1,500 m. Each encounter runs
  WARNING → cinematic INTRO (slow motion, camera shots, title card) → FIGHT → DEFEATED → VICTORY cinematic
  (explosions, THREAT ELIMINATED) → NEXT LEVEL (the next area opens). Distances count running outside boss fights.
- **Boss combat** — DODGE → STRIKE → COMBO → PHASE CHANGE:
  - *Dodge:* every attack is telegraphed (floor strips: red = change lane, gold = jump, cyan = slide, green = safe
    zone; a direction cue like `◀ DODGE LEFT` / `MOVE + JUMP ▶`; heavy attacks add a red flash, shake, roar and a
    slow-motion wind-up). Dodge with the normal controls.
  - *Strike:* after each attack the boss opens up and a touch sequence appears (tap ● and swipes ← → ↑ ↓, e.g.
    `TAP · LEFT · TAP`). While it is up, swipes are attack inputs, not moves. Hit by the attack → OPENING (normal
    strike); dodged it cleanly → WEAK POINT (CRITICAL HIT); dodged a heavy attack → PERFECT DODGE → slow motion →
    COUNTER! Fast and clean = PERFECT! (bonus damage, slow-mo, flash). Wrong input or too slow = MISS: combo reset
    and the boss attacks straight away. Every input is a move: tap = punch / front kick, ← → = spinning roundhouse,
    ↑ = backflip, ↓ = breakdance sweep, last input = flying flip-kick finisher.
  - *Mid-combo attacks:* the boss swings while you're comboing (more often each phase). The sequence pauses
    (⚠ INCOMING · JUMP!), your swipes move you again, dodge it and the combo resumes; get hit and it's INTERRUPTED.
  - *Combo + special:* each strike raises the combo (more damage, more bolts) and fills the SPECIAL meter; when full,
    the next opening is a long sequence that unleashes a cinematic special attack.
  - *Phases:* 3 per boss (4 for SYSTEM CRASH). A hit can't skip a phase. Each phase shortens reaction time,
    rest and sequence windows, adds attacks and harder sequences; the last is ENRAGED (rage cinematic) and the
    final quarter gets faster still.
  - *Identities:* MALWARE BEAST — claw swipes, virus clones, packet volleys, shockwaves. FIREWALL — wall slams
    (move + jump), burning lanes with safe zones, scan lasers, lane lockdowns; L/R-heavy sequences. CODE BREAKER —
    decoy obstacles (no floor warning = fake), mirror attacks that reverse left/right, teleport strikes, the longest
    sequences. SYSTEM CRASH — all of it, blue screens, KERNEL PANIC final attack and two weak points per opening.

## Progression

Everything is saved on the device (`src/core/Profile.ts`, one versioned localStorage record). Older saves (high score,
lifetime XP and coins) are carried over automatically.

- **Level and rank.** XP comes from bug fixes, XP files, chips, power-ups, the boss, finished missions and distance
  (1 XP per 10 m). Level L needs `150 + 75 × (L − 1)` XP. Ranks: INTERN → JUNIOR DEV (3) → DEVELOPER (6) →
  SENIOR DEV (10) → LEAD ENGINEER (15) → ARCHITECT (20) → CTO (30) → LEGEND (40). Each new level banks coins.
- **Coin bank.** Coins from every run (also when you quit from pause) plus level and mission rewards. Fictional
  currency, spent in the shop (Phase 5).
- **Missions** (`src/game/Missions.ts`): three at a time, e.g. "Fix 5 bugs in one run", "Reach DEBUG COMBO x3",
  "Run 2,000 m in total". "In one run" missions keep your best attempt; the rest add up across runs. Each one gives
  XP when it's done (MISSION COMPLETE card). Finish all three and the set pays out: **score multiplier +1 for every
  run after** (up to ×30) plus coins, and a harder set replaces it. The first three sets are fixed to teach the game;
  later sets are generated from the set number, so they never change under you.
- **Where you see it:** the menu shows level, XP bar, bank and missions; pause shows mission progress; the results
  screen fills the XP bar (LEVEL UP), shows coins banked, ticks off finished missions and announces a completed set.

## Shop

SHOP on the menu (`src/game/Shop.ts` rules + catalog, `src/ui/ShopUI.ts` screen). Coins are fictional and only
earned by playing; there is no real money anywhere. Buying takes two taps (price, then CONFIRM).

- **Outfits** (8): recolour Ty's hoodie and accents (kicks, hair streak). Tap one to try it on the 3D runner before
  buying. The recolour is a hue key in the avatar shader driven by uniforms, so changing outfit never compiles a shader.
- **Trails** (7): sneaker light-trail colours, including an RGB cycle.
- **Upgrades**: DEBUG MODE, CODE BOOST, BUG MAGNET, RAM BOOST and FIREWALL, 5 levels each, +15% duration per level
  (300 / 700 / 1,500 / 3,000 / 6,000 coins).
- **Boosts** (one run each, switched on/off with the chips above TAP TO START):
  HEAD START (8 s of CODE BOOST), FIREWALL START (shield until the first hit), DOUBLE SCORE (×2 for the first
  1,000 m), SYSTEM BACKUP (at 0% health you're restored to 50% and the hazards ahead are cleared; one per run,
  only used up if it saves you).
- Some cosmetics unlock at a player level. **PROFILE** (menu, or tap the level strip) shows rank, multiplier and
  lifetime stats.

## Structure

```
src/
  core/    GameManager (state machine + loop), Config (all tuning), Theme (stages + shared shader palette),
           EventBus, GameState, Profile (saved progress: level, bank, best, missions, stats)
  game/    PlayerController, Character (procedural rig), CameraController, ComboSystem,
           ObstacleWatcher (clears / near misses), PowerUps, Missions, Shop
  boss/    BossDirector (encounter state machine, attacks, combat loop, cinematics), bosses (catalogue: stats,
           phases, attack patterns, sequences), Combat (touch sequences), BossModel + models/ (the four bosses),
           LaneWarnings (floor telegraphs)
  world/   Track (data streams + motherboard), ComputerWorld (instanced districts, holo windows, core),
           Obstacles (hazards + bad bugs), Pickups (collectibles, good bugs, power-ups), Spawner (fair generation)
  render/  Quality (tiers), MaterialLib (procedural PBR), Environment (PMREM), Reflection (planar mirror),
           Watchdog (black-screen fallback, GPU reset hand-off, flight recorder)
  fx/      PostFX (DOF, bloom, motion blur, glitch, grade), FXDirector (event → effects), Particles (shaped sprites), Trails, SpeedLines
  audio/   AudioManager (buses, modes, beat sync, SFX), HipHopEngine (procedural soundtrack), synth (instruments), MusicFiles (drop-in tracks)
  ui/      HUD (glass dashboard, bug-fix cards, banners, missions, sound settings, SYSTEM FAILURE, reboot),
           ShopUI (shop + profile screens), premium.css, progression.css, shop.css
assets/music/  drop-in soundtrack files
scripts/   playtest, scenarios, progression, shop, bot, shot (+ lib), check-gpu-reset, check-shader-stalls, build-single
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
