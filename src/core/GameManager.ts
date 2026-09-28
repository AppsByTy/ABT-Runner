import * as THREE from 'three';
import { CONFIG } from './Config';
import { events } from './EventBus';
import { GameState, TRANSITIONS } from './GameState';
import { BestScore, Lifetime } from './BestScore';
import { STAGES, THEME, resetTheme, stageAt, updateTheme, type StageDef } from './Theme';
import { InputManager, type InputAction } from '../input/InputManager';
import { PlayerController } from '../game/PlayerController';
import { CameraController } from '../game/CameraController';
import { ComboSystem } from '../game/ComboSystem';
import { ObstacleWatcher } from '../game/ObstacleWatcher';
import { PowerUps } from '../game/PowerUps';
import { VirusBoss } from '../game/VirusBoss';
import { Track } from '../world/Track';
import { ComputerWorld } from '../world/ComputerWorld';
import { ThemeLinks } from '../world/ThemeLinks';
import { ObstacleManager, KIND_LABEL, isBadBug, type Obstacle, type ObstacleKind } from '../world/Obstacles';
import { PickupManager, POWER_INFO, type Pickup, type PowerType } from '../world/Pickups';
import { Spawner } from '../world/Spawner';
import { PostFX, canRenderHalfFloat } from '../fx/PostFX';
import { RenderWatchdog, rememberError, showDiagnostics } from '../render/Watchdog';
import { loadAvatar } from '../game/ModelAvatar';
import tyMeshUrl from '../assets/models/ty-mesh.glb?inline';
import tyAlbedoUrl from '../assets/models/ty-albedo.jpg?inline';
import { FXDirector } from '../fx/FXDirector';
import { HUD } from '../ui/HUD';
import { audio } from '../audio/AudioManager';
import { clamp, makeAABB, overlapX, overlapZ, overlaps } from '../utils/math';
import { QUALITY, loadQuality, type QualitySettings } from '../render/Quality';
import { MaterialLib } from '../render/MaterialLib';
import { EnvironmentMaps } from '../render/Environment';
import { PlanarReflection } from '../render/Reflection';

const CAUSE: Record<ObstacleKind, string> = {
  firewall: 'FIREWALL_COLLISION',
  errorWindow: 'UNHANDLED_ERROR_WINDOW',
  corruptBlock: 'CORRUPTED_CODE_EXCEPTION',
  glitchBug: 'GLITCH_BUG_INFESTATION',
  virusDrone: 'VIRUS_PAYLOAD_EXECUTED',
  malwareBug: 'MALWARE_BREACH',
  packet: 'CORRUPT_PACKET_OVERFLOW',
};

const POWER_BANNER: Record<PowerType, [string, string, 'green' | 'orange' | 'cyan' | 'pink' | 'purple' | 'gold']> = {
  debug: ['DEBUG MODE ACTIVATED', 'INVINCIBLE · AUTO-FIXING BUGS', 'green'],
  firewall: ['FIREWALL ONLINE', 'BLOCKS THE NEXT HIT', 'orange'],
  boost: ['CODE BOOST', 'OVERCLOCKED · INVINCIBLE', 'cyan'],
  magnet: ['BUG MAGNET', 'PULLING BUGS + COINS', 'pink'],
  ram: ['RAM BOOST', 'SCORE ×2 · FASTER MOVES', 'purple'],
  admin: ['ADMIN ACCESS GRANTED', 'ROOT PRIVILEGES · SCORE ×3', 'gold'],
};

const STAGE_TONE: Record<number, 'cyan' | 'gold' | 'orange' | 'pink' | 'green' | 'red'> = {
  1: 'cyan',
  2: 'gold',
  3: 'orange',
  4: 'pink',
  5: 'green',
  6: 'red',
  7: 'gold',
};

/**
 * Owns the renderer, the state machine and every gameplay system.
 * Simulation runs on a fixed timestep; rendering/animation at display rate.
 */
export class GameManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly input: InputManager;
  readonly player: PlayerController;
  readonly quality: QualitySettings;
  readonly lib: MaterialLib;
  readonly envMaps: EnvironmentMaps;
  reflection: PlanarReflection | null;
  readonly cam: CameraController;
  readonly links = new ThemeLinks();
  readonly track: Track;
  readonly world: ComputerWorld;
  readonly obstacles: ObstacleManager;
  readonly pickups: PickupManager;
  readonly spawner: Spawner;
  readonly boss: VirusBoss;
  readonly powers = new PowerUps();
  readonly combo = new ComboSystem();
  readonly watcher = new ObstacleWatcher();
  readonly post: PostFX;
  private readonly watchdog: RenderWatchdog;
  private recoverStep = 0;
  private prewarmed = 0;
  /** The browser took the WebGL context away; nothing is drawn until it is restored. */
  private gpuLost = false;
  private beatTime = 0;
  private fpsCount = 0;
  /** Session counters for the flight recorder. */
  private runs = 0;
  private actions = 0;
  private resizes = 0;
  readonly fx: FXDirector;
  readonly hud: HUD;

  state: GameState = GameState.Ready;

  // Run stats
  distance = 0;
  speed: number = CONFIG.speed.start;
  score = 0;
  coinCount = 0;
  bugsFixed = 0;
  xp = 0;
  health: number = CONFIG.health.max;
  multiplier = 1;
  runTime = 0;
  stage: StageDef = STAGES[0];
  /** Counters for tests/analytics. */
  hits = 0;

  /** When false the RAF loop idles and frames are driven via stepFrame(). */
  autoLoop = true;
  /** When false, frames simulate but skip the GPU (used by automated tests). */
  renderEnabled = true;
  seed: number | undefined;
  /** Force the scripted intro on/off (tests); undefined = first two runs only. */
  tutorialOverride: boolean | undefined;

  private prevDistance = 0;
  private lastFrameDistance = 0;
  private speedPenalty = 0;
  private boostSpeed = 1;
  private accumulator = 0;
  private stateTime = 0;
  private timeScale = 1;
  private clock = 0;
  private lastFrame = performance.now();
  private best = BestScore.get();
  private readonly debug: boolean;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private pixelRatio = 1;
  private debugBlend = 0;
  private rebooting = false;
  private coinStreak = 0;
  private coinStreakT = 0;
  private killer: ObstacleKind = 'corruptBlock';
  private grazed: Obstacle | null = null;

  private readonly hemi: THREE.HemisphereLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly key: THREE.DirectionalLight;
  private readonly shadowCatcher: THREE.Mesh;
  private envKey = 'stage1';
  private glitchTimer = 6;
  private readonly white = new THREE.Color(1, 1, 1);
  private readonly red = new THREE.Color('#ff1030');
  private readonly pBox = makeAABB();
  private readonly pPrev = makeAABB();
  private readonly oBox = makeAABB();
  private readonly oPrev = makeAABB();

  /** @param opts.avatar false = keep the procedural runner (on-device A/B crash test) */
  constructor(container: HTMLElement, opts: { avatar?: boolean } = {}) {
    const params = new URLSearchParams(location.search);
    this.debug = params.has('debug');
    const seedParam = params.get('seed');
    this.seed = seedParam !== null ? Number(seedParam) : undefined;
    const q = (this.quality = { ...QUALITY[loadQuality()] });
    // Phones already render at 2-3x density; multisampled half-float targets are
    // also a known black-screen source on iOS WebGL, so phones skip MSAA.
    const touchDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
    if (touchDevice) {
      q.msaa = 0;
      q.dof = false;
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: !q.post, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio, q.pixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.watchdog = new RenderWatchdog(this.renderer);
    this.renderer.info.autoReset = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shadows are refreshed once per frame (shared by the reflection and main passes).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.lib = new MaterialLib();
    this.envMaps = new EnvironmentMaps(this.renderer);
    this.scene.environment = this.envMaps.get('stage1');
    this.scene.environmentIntensity = 1.0;
    this.scene.fog = new THREE.Fog(THEME.uVoid.value.clone(), 40, 210);

    this.hemi = new THREE.HemisphereLight(0x9ad8ff, 0x0a1428, 0.55);
    this.scene.add(this.hemi);
    // Key light follows the runner and casts the only dynamic shadows.
    this.key = new THREE.DirectionalLight(0xe8f0ff, 2.2);
    this.key.castShadow = q.shadows;
    this.key.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    const sc = this.key.shadow.camera;
    sc.left = -9;
    sc.right = 9;
    sc.top = 16;
    sc.bottom = -16;
    sc.near = 1;
    sc.far = 60;
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 3;
    this.scene.add(this.key, this.key.target);
    this.rim = new THREE.DirectionalLight(0x00e5ff, 1.6);
    this.rim.position.set(5, 3, -10);
    this.scene.add(this.rim);
    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 44).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ color: 0x000008, opacity: 0.6, depthWrite: false }),
    );
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.position.set(0, 0.012, -12);
    this.shadowCatcher.renderOrder = 1;
    this.shadowCatcher.visible = q.shadows;
    this.scene.add(this.shadowCatcher);

    this.player = new PlayerController(this.lib);
    this.cam = new CameraController(window.innerWidth / window.innerHeight);
    this.track = new Track(this.scene, this.links, this.lib);
    this.world = new ComputerWorld(this.scene, this.links, this.lib, q);
    this.reflection = q.reflections ? new PlanarReflection(window.innerWidth * this.pixelRatio, window.innerHeight * this.pixelRatio, q.reflectionScale, canRenderHalfFloat(this.renderer)) : null;
    if (this.reflection) {
      this.track.reflectUniforms.uReflect.value = this.reflection.target.texture;
      this.track.reflectUniforms.uReflectOn.value = 1;
    }
    this.obstacles = new ObstacleManager(this.scene, this.lib);
    this.obstacles.onMaterialize = (o) => events.emit('materialize', { x: o.x, z: -(o.dist - this.distance), kind: o.kind });
    this.pickups = new PickupManager(this.scene);
    this.spawner = new Spawner(this.obstacles, this.pickups, { health: () => this.health });
    this.boss = new VirusBoss(this.scene);
    this.scene.add(this.player.root, this.player.shadowRoot);
    this.post = new PostFX(this.renderer, this.scene, this.cam.camera, q);
    this.fx = new FXDirector(this.scene, this.player, this.cam, this.post, this.boss, q.particles);

    this.hud = new HUD(container);
    this.hud.onPause = () => this.pause();
    this.hud.onResume = () => this.resume();
    this.hud.onRestart = () => this.restart();
    this.hud.onMenu = () => this.toReady();
    this.hud.onMute = () => {
      audio.setMuted(!audio.muted);
      this.hud.setMuted(audio.muted);
      audio.play('ui');
    };
    this.hud.setMuted(audio.muted);
    this.hud.setFps(this.debug ? '—' : null);
    this.setViewportSizes();

    this.input = new InputManager(container);
    this.input.onAction((a) => this.handleInput(a));
    this.wireEvents();

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });
    window.addEventListener('blur', () => this.pause());

    this.resetRun();
    this.hud.setState(this.state, this.best);
    audio.startMusic();
    audio.onBeat = (kind) => this.fx.onBeat(kind, this.powers.mode, this.state === GameState.Playing, this.multiplier);
    audio.setIntensity(0);
    // GPU context loss (iOS GPU reset): pause, then rebuild in place - never reload.
    this.watchdog.onContextLost = () => this.onContextLost();
    this.watchdog.onContextRestored = () => this.onContextRestored();
    // Pre-compile every shader (incl. pooled, not-yet-visible hazards, bosses
    // and power-ups) during the menu so nothing compiles mid-run.
    // Sculpted 3D runner model (falls back to the procedural character if it can't load).
    if (opts.avatar !== false) loadAvatar(tyMeshUrl, tyAlbedoUrl)
      .then((av) => {
        this.player.character.attachModel(av);
        this.warmShaders();
      })
      .catch((e) => this.watchdog.log(`model: ${String(e).slice(0, 160)}`));
    window.setTimeout(() => this.warmShaders(), 600);
    // If the previous session died with an error, show the report once so it can be screenshotted.
    if (this.watchdog.previous) {
      showDiagnostics(this.renderer, [`LAST SESSION CRASHED: ${this.watchdog.previous}`, 'Tap this box to close.']);
    }
    if (new URLSearchParams(location.search).has('diag')) {
      window.setInterval(
        () =>
          showDiagnostics(this.renderer, [
            `quality ${this.quality.level} · post level ${this.post.safeLevel} · halfFloat ${canRenderHalfFloat(this.renderer)} · reflections ${!!this.reflection} · shadows ${this.renderer.shadowMap.enabled}`,
            `pixelRatio ${this.pixelRatio} · calls ${this.renderer.info.render.calls} · watchdog ${this.watchdog.done ? 'ok' : 'checking'}`,
            ...(this.watchdog.previous ? [`previous session: ${this.watchdog.previous}`] : []),
            `jsHeap ${Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6)}MB · geo ${this.renderer.info.memory.geometries} · tex ${this.renderer.info.memory.textures}`,
            ...this.watchdog.errors,
          ]),
        1000,
      );
    }
  }

  private setViewportSizes(): void {
    const h = window.innerHeight * this.renderer.getPixelRatio();
    this.fx.setViewportHeight(h);
    this.world.setViewportHeight(h);
  }

  // ------------------------------------------------------------- events

  private wireEvents(): void {
    const P = CONFIG.combo.points;
    events.on('obstacleCleared', ({ how }) => {
      if (this.state !== GameState.Playing) return;
      this.addScore(CONFIG.score.clear);
      this.combo.add(how === 'dodge' ? P.dodge : P.clear, how.toUpperCase());
    });
    events.on('nearMiss', ({ x, style }) => {
      if (this.state !== GameState.Playing) return;
      this.player.character.react(style === 'vertical' ? 0 : Math.sign(this.player.x - x) || 1);
      this.addScore(CONFIG.score.nearMiss);
      this.combo.add(P.nearMiss, 'NEAR MISS');
      this.hud.popup('NEAR MISS!', 'cyan', true);
      audio.play('nearMiss');
    });
    events.on('combo', ({ levelUp, multiplier }) => {
      if (!levelUp) return;
      this.hud.popup(`DEBUG COMBO x${multiplier}`, multiplier >= 10 ? 'gold' : multiplier >= 5 ? 'pink' : 'lime', true);
      audio.play('comboTier', Math.max(0, [2, 3, 5, 10].indexOf(multiplier)) * 2);
    });
    events.on('comboEnd', ({ combo, reason }) => {
      if (reason === 'timeout' && combo >= 5) this.hud.popup(`CHAIN ENDED · ${combo}`, 'gold');
    });

    events.on('jump', () => audio.play('jump'));
    events.on('land', () => audio.play('land'));
    events.on('slideStart', () => audio.play('slide'));
    events.on('laneChange', () => audio.play('lane'));
    events.on('obstacleDeleted', () => audio.play('deleted'));

    events.on('powerStart', ({ type, fresh }) => {
      const [title, sub, tone] = POWER_BANNER[type];
      if (fresh || type === 'admin') this.hud.banner(title, sub, tone, type === 'admin' ? 2.4 : 1.6);
      else this.hud.popup(`${POWER_INFO[type].name} REFRESHED`, 'lime');
      audio.play(type === 'debug' ? 'debug' : type === 'admin' ? 'admin' : 'power');
    });
    events.on('powerEnd', ({ type, reason }) => {
      if (reason === 'absorbed') {
        this.hud.popup('FIREWALL BLOCKED IT!', 'gold', true);
        audio.play('shieldBreak');
      } else if (type === 'boost' || type === 'debug' || type === 'admin') {
        // A moment of grace so an invincible mode never ends inside a hazard.
        this.player.grace(1.0);
      }
    });

    events.on('bossStart', () => {
      this.hud.banner('VIRUS DETECTED', 'COLLECT GOLD PATCHES TO DELETE IT', 'red', 2.6);
      audio.play('bossAlarm');
      audio.setBoss(true);
    });
    events.on('bossActive', () => this.spawner.setBoss(true, this.distance));
    events.on('bossPatched', ({ progress, needed }) => {
      this.hud.popup(`PATCH ${progress}/${needed}`, 'gold', true);
      audio.play('bossPatch', progress * 2);
    });
    events.on('bossDeleted', () => {
      const S = CONFIG.score;
      const reward = S.boss * this.totalMult;
      this.addScore(S.boss);
      this.coinCount += 50;
      this.xp += CONFIG.xp.boss;
      this.heal(CONFIG.health.boss);
      this.combo.add(3, 'VIRUS DELETED');
      this.hud.banner('VIRUS DELETED ✓', `+${reward.toLocaleString('en-US')} · +50 COINS · +${CONFIG.xp.boss} XP`, 'green', 2.6);
      audio.play('bossDeleted');
      this.spawner.setBoss(false, this.distance);
    });
    events.on('bossEscaped', () => {
      this.hud.banner('VIRUS ESCAPED', 'QUARANTINE FAILED · IT WILL BE BACK', 'red', 2.2);
      this.spawner.setBoss(false, this.distance);
    });
    events.on('bossEnd', () => {
      audio.setBoss(false);
      this.hud.boss(false);
    });
  }

  // ---------------------------------------------------------- state machine

  private setState(next: GameState): boolean {
    if (next === this.state) return false;
    if (!TRANSITIONS[this.state].includes(next)) {
      console.warn(`[GameManager] illegal transition ${this.state} -> ${next}`);
      return false;
    }
    const from = this.state;
    this.state = next;
    this.stateTime = 0;
    this.hud.setState(next, this.best);
    events.emit('stateChange', { from, to: next });
    audio.setMuffled(next === GameState.Paused);
    audio.setGameOver(next === GameState.Dying || next === GameState.GameOver);
    return true;
  }

  private resetRun(): void {
    this.distance = this.prevDistance = this.lastFrameDistance = 0;
    this.speed = CONFIG.speed.start;
    this.speedPenalty = 0;
    this.boostSpeed = 1;
    this.score = 0;
    this.coinCount = 0;
    this.bugsFixed = 0;
    this.xp = 0;
    this.hits = 0;
    this.health = CONFIG.health.max;
    this.multiplier = 1;
    this.runTime = 0;
    this.accumulator = 0;
    this.timeScale = 1;
    this.grazed = null;
    this.stage = STAGES[0];
    this.coinStreak = 0;
    this.debugBlend = 0;
    resetTheme();
    this.combo.reset();
    this.powers.reset();
    this.boss.reset();
    this.fx.reset();
    this.world.reset();
    this.obstacles.clear();
    this.pickups.clear();
    this.track.reset();
    this.player.reset();
    const tutorial = this.tutorialOverride ?? Lifetime.get().runs < 2;
    this.spawner.reset(this.seed, tutorial);
    this.spawner.update(0, this.speed, 0, 0);
    this.obstacles.update(0, 0, 0);
    this.cam.snap(this.player.x, 0);
    this.hud.resetCounters();
    this.hud.setAccent(this.stage.primary);
    this.hud.update(this.stats(), 0);
  }

  start(): void {
    if (this.state !== GameState.Ready) return;
    if (this.setState(GameState.Playing)) {
      this.runs++;
      events.emit('runStart');
      audio.play('ui');
      this.hud.banner('STAGE 1', this.stage.name, 'cyan', 1.4);
    }
  }

  pause(): void {
    if (this.state === GameState.Playing) this.setState(GameState.Paused);
  }

  resume(): void {
    if (this.state !== GameState.Paused || this.gpuLost) return;
    this.lastFrame = performance.now();
    this.setState(GameState.Playing);
  }

  /** REBOOT SYSTEM: boot animation, then straight into a new run. */
  restart(instant = false): void {
    if (this.state !== GameState.GameOver || this.rebooting) return;
    const go = (): void => {
      this.rebooting = false;
      if (this.state !== GameState.GameOver) return;
      this.resetRun();
      if (this.setState(GameState.Playing)) {
        this.runs++;
        events.emit('runStart');
        this.hud.banner('SYSTEM RESTORED', `STAGE 1 · ${this.stage.name}`, 'green', 1.4);
      }
    };
    if (instant) return go();
    this.rebooting = true;
    audio.play('reboot');
    void this.hud.reboot().then(go);
  }

  toReady(): void {
    if (this.state !== GameState.Paused && this.state !== GameState.GameOver) return;
    if (this.rebooting) return;
    this.resetRun();
    this.setState(GameState.Ready);
  }

  private handleInput(a: InputAction): void {
    switch (this.state) {
      case GameState.Ready:
        if (a !== 'pause') this.start();
        return;
      case GameState.Playing:
        this.actions++;
        if (a === 'left') this.player.moveLane(-1);
        else if (a === 'right') this.player.moveLane(1);
        else if (a === 'jump') this.player.jump();
        else if (a === 'slide') this.player.slide();
        else if (a === 'pause') this.pause();
        return;
      case GameState.Paused:
        if (a === 'pause' || a === 'confirm' || a === 'jump') this.resume();
        return;
      case GameState.GameOver:
        // Short lockout so a frantic swipe at the crash doesn't instantly restart.
        if ((a === 'confirm' || a === 'jump') && this.stateTime > 0.8) this.restart();
        return;
      case GameState.Dying:
        return;
    }
  }

  // ------------------------------------------------------------------ loop

  run(): void {
    let errors = 0;
    const frame = (now: number): void => {
      // Always keep the loop alive: one bad frame must never freeze the game.
      requestAnimationFrame(frame);
      const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
      this.lastFrame = now;
      if (!this.autoLoop) return;
      try {
        this.frame(dt);
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? `${e.message} @ ${(e.stack ?? '').split('\n').slice(0, 3).join(' | ')}` : String(e);
        this.watchdog.log(`frame error: ${msg.slice(0, 300)}`);
        rememberError(msg);
        console.error(e);
        if (errors === 30) showDiagnostics(this.renderer, this.watchdog.errors);
      }
    };
    requestAnimationFrame(frame);
  }

  /** Advance one display frame manually (tests / tooling). */
  stepFrame(dt: number): void {
    this.frame(dt);
  }

  private speedFactor(): number {
    return clamp((this.speed - CONFIG.speed.start) / (CONFIG.speed.max - CONFIG.speed.start), 0, 1);
  }

  get totalMult(): number {
    return this.multiplier * this.powers.scoreMult;
  }

  private addScore(points: number): void {
    this.score += points * this.totalMult;
  }

  private heal(amount: number): void {
    const before = this.health;
    this.health = Math.min(CONFIG.health.max, this.health + amount);
    if (this.health > before) events.emit('heal', { amount: this.health - before, health: this.health });
  }

  private frame(realDt: number): void {
    this.stateTime += realDt;
    this.renderer.info.reset();
    const playing = this.state === GameState.Playing;
    const dying = this.state === GameState.Dying;

    if (dying) {
      // Brief slow-mo on the crash, then settle.
      this.timeScale = this.stateTime < 0.4 ? 0.22 : Math.min(1, this.timeScale + realDt * 3);
      if (this.stateTime > 1.3) this.finishRun();
    }
    const dt = realDt * this.timeScale;

    if (playing) {
      this.accumulator += dt;
      const step = CONFIG.sim.fixedStep;
      let n = 0;
      while (this.accumulator >= step && n < CONFIG.sim.maxSubSteps) {
        this.simulate(step);
        this.accumulator -= step;
        n++;
        if (this.state !== GameState.Playing) break;
      }
      if (n === CONFIG.sim.maxSubSteps) this.accumulator = 0;
    }

    this.clock += dt;
    const scroll = this.distance - this.lastFrameDistance;
    this.lastFrameDistance = this.distance;
    const sf = this.speedFactor();
    const mode = this.powers.mode;

    // Theme: stage palette, debug-mode matrix look, glitch from low health.
    this.debugBlend += ((this.powers.has('debug') ? 1 : 0) - this.debugBlend) * Math.min(1, realDt * 5);
    const lowHp = this.health < 40 && (playing || dying) ? (40 - this.health) / 40 : 0;
    updateTheme(this.stage, realDt, this.clock, this.distance, this.debugBlend, lowHp * 0.15);
    // Beat sync: world lighting, road dividers, bloom and UI pulse with the music.
    const beat = audio.update(realDt);
    const beatGain = playing ? 0.55 + Math.min(0.45, (this.multiplier - 1) * 0.06) + this.debugBlend * 0.5 : 0.45;
    THEME.uBeat.value = beat * beatGain;
    this.hud.setBeat(THEME.uBeat.value);
    this.links.apply();
    (this.scene.fog as THREE.Fog).color.copy(THEME.uVoid.value);
    this.hemi.color.copy(THEME.uPrimary.value).lerp(this.white, 0.55);
    this.rim.color.copy(THEME.uSecondary.value);
    this.updateLighting(realDt, playing, mode);

    this.world.update(this.distance, dt);
    this.pickups.update(dt, this.distance, this.player, this.powers.magnetRadius, this.powers.magnetKinds);
    if (!playing) this.obstacles.update(this.distance, 0, this.clock);

    const charColor = mode === 'debug' || mode === 'admin' || mode === 'boost' || mode === 'ram' ? POWER_INFO[mode].color : null;
    this.player.character.setMode(charColor, realDt);
    this.player.animate(dt, this.speed, playing || dying, this.state === GameState.Ready);
    audio.setDebug(playing && (mode === 'debug' || mode === 'admin'));
    this.cam.intensity = playing && (mode === 'debug' || mode === 'admin' || mode === 'boost') ? (mode === 'boost' ? 0.6 : 1) : 0;
    this.cam.beat = THEME.uBeat.value;
    this.cam.update(realDt, this.player, sf, this.state === GameState.Ready);
    this.fx.update(dt, scroll, this.speed, sf, playing || dying, mode, this.powers.has('firewall'));

    // Screen mood.
    this.post.tick(realDt);
    const tint = mode === 'admin' ? POWER_INFO.admin.color : mode === 'debug' ? POWER_INFO.debug.color : null;
    if (tint) this.post.tint.set(tint);
    this.post.tintAmount += ((tint ? (mode === 'admin' ? 0.4 : 0.38) : 0) - this.post.tintAmount) * Math.min(1, realDt * 5);
    this.post.danger = playing && this.health <= 30 ? 0.35 + (1 - this.health / 30) * 0.65 : 0;
    const tier = this.multiplier;
    const hype = playing ? (tier >= 10 ? 0.8 : tier >= 5 ? 0.45 : tier >= 3 ? 0.2 : 0) : 0;
    this.post.hype += (hype - this.post.hype) * Math.min(1, realDt * 3);
    this.post.hypeColor.set(tier >= 10 ? '#ffd23a' : tier >= 5 ? '#ff2bd6' : '#b4ff1e');
    audio.setIntensity(this.state === GameState.Ready ? 0 : this.boss.fighting || tier >= 5 || mode === 'admin' ? 3 : tier >= 3 ? 2 : 1);

    this.hud.update(this.stats(), realDt);
    if ((playing || this.state === GameState.Paused) && (this.boss.phase === 'active' || this.boss.phase === 'deleted')) this.hud.boss(true, this.boss.progress, this.boss.needed, this.boss.timeLeft);

    // Cinematic lens: radial motion blur at speed / boosts, shallow DOF on menus.
    const boosting = mode === 'boost' || mode === 'admin';
    const motionT = playing ? Math.max(0, sf - 0.55) * 0.9 + (boosting ? 0.45 : 0) : 0;
    this.post.motion += (Math.min(1, motionT) - this.post.motion) * Math.min(1, realDt * 4);
    const menuish = this.state === GameState.Ready || this.state === GameState.GameOver || this.state === GameState.Paused;
    this.post.dof += ((menuish ? 1 : 0) - this.post.dof) * Math.min(1, realDt * 3);
    this.post.focus = this.cam.camera.position.distanceTo(this.player.root.position) + 0.2;

    this.beatTime += realDt;
    if (this.beatTime >= 1) {
      this.watchdog.heartbeat(this.state, this.distance, this.fpsCount / this.beatTime,
        `run ${this.runs} · ${this.actions} swipes · ${this.hits} hits · ${this.resizes} resizes · view ${window.innerWidth}x${window.innerHeight} · open ${Math.round(performance.now() / 1000)} s`);
      this.beatTime = this.fpsCount = 0;
    }
    this.fpsCount++;

    if (this.renderEnabled && !this.gpuLost) {
      this.renderer.shadowMap.needsUpdate = true;
      if (this.reflection) {
        this.reflection.render(this.renderer, this.scene, this.cam.camera, [this.track.group, this.shadowCatcher]);
        (this.track.reflectUniforms.uReflectMatrix.value as THREE.Matrix4).copy(this.reflection.textureMatrix);
      }
      this.post.render(realDt, playing ? sf : 0);
      if (!this.watchdog.done && this.autoLoop && this.watchdog.check(this.renderer.getContext())) this.recoverBlackScreen();
    }

    if (this.debug) {
      this.fpsAccum += realDt;
      this.fpsFrames++;
      if (this.fpsAccum > 0.5) {
        const info = this.renderer.info.render;
        this.hud.setFps(
          `${Math.round(this.fpsFrames / this.fpsAccum)} fps · ${info.calls} calls · ${this.speed.toFixed(1)} u/s · obs ${this.obstacles.activeCount} · pick ${this.pickups.active.length}`,
        );
        this.fpsAccum = this.fpsFrames = 0;
      }
    }
  }

  private simulate(dt: number): void {
    this.runTime += dt;
    this.powers.update(dt);

    // Speed ramp: exponential ease toward max, minus a recovering hit penalty, times CODE BOOST.
    const S = CONFIG.speed;
    const base = S.start + (S.max - S.start) * (1 - Math.exp(-this.distance / S.rampDistance));
    this.speedPenalty = Math.max(0, this.speedPenalty - dt * 0.5);
    this.boostSpeed += (this.powers.speedMult - this.boostSpeed) * Math.min(1, dt * 4);
    this.speed = base * (1 - this.speedPenalty) * this.boostSpeed;
    this.player.laneFactor = this.powers.has('ram') || this.powers.has('admin') ? CONFIG.player.ramLaneFactor : 1;

    this.prevDistance = this.distance;
    this.distance += this.speed * dt;
    this.score += this.speed * dt * this.totalMult * 0.5;

    const sf = this.speedFactor();
    this.player.step(dt, sf);
    this.spawner.update(this.distance, this.speed, sf, dt);
    this.track.update(this.distance);
    this.obstacles.update(this.distance, dt, this.clock);
    this.boss.update(dt, this.distance, this.player.x, this.player.lane);

    // Corruption stage progression.
    const st = stageAt(this.distance);
    if (st.id !== this.stage.id) {
      this.stage = st;
      events.emit('stage', { id: st.id, name: st.name });
      if (st.id === 7) this.hud.banner('ENTERING THE CORE', 'THE HEART OF THE SYSTEM', 'gold', 2.6);
      else this.hud.banner(`STAGE ${st.id}`, st.name, STAGE_TONE[st.id], 2.0);
      this.hud.setAccent(st.primary);
      audio.play('stage');
      audio.setStage(st.id);
    }

    // Tutorial hints.
    for (const h of this.spawner.hints) {
      if (!h.shown && h.dist - this.distance < this.speed * 1.7) {
        h.shown = true;
        this.hud.hint(h.text);
      }
    }

    this.powerEffects();
    this.checkObstacles();
    if (this.state === GameState.Playing) {
      this.player.getCollider(this.pBox);
      this.watcher.update(this.obstacles, this.distance, this.player, this.pBox);
      this.combo.update(dt);
      this.multiplier = this.combo.multiplier;
      this.coinStreakT -= dt;
      if (this.coinStreakT <= 0) this.coinStreak = 0;
      this.checkPickups();
    }
  }

  /** DEBUG MODE fixes bad bugs ahead; ADMIN ACCESS deletes every hazard ahead. */
  private powerEffects(): void {
    const admin = this.powers.has('admin');
    const debug = this.powers.has('debug');
    if (!admin && !debug) return;
    this.obstacles.forEach((o) => {
      if (o.destroyed) return;
      const ahead = o.dist - this.distance;
      if (ahead < 1 || ahead > 26) return;
      const bug = isBadBug(o.kind);
      if (admin || (debug && bug)) this.deleteObstacle(o, bug);
    });
  }

  private deleteObstacle(o: Obstacle, bug: boolean): void {
    this.obstacles.destroy(o);
    o.noScore = true;
    const z = -(o.dist - this.distance);
    events.emit('obstacleDeleted', { kind: o.kind, badBug: bug, x: o.x, y: o.cls === 'high' ? 1.8 : 0.5, z });
    if (bug) {
      this.bugsFixed++;
      this.xp += CONFIG.xp.badBugFixed;
      this.addScore(CONFIG.score.badBugFixed);
      this.combo.add(CONFIG.combo.points.badBug, 'BUG FIXED');
      this.hud.popup(`${KIND_LABEL[o.kind]} FIXED`, 'green');
    } else {
      this.addScore(CONFIG.score.deleted);
      this.hud.popup('DELETED', 'gold');
    }
  }

  private checkObstacles(): void {
    const p = this.player;
    p.getCollider(this.pBox);
    p.getCollider(this.pPrev, p.prevX);
    let hit: Obstacle | null = null;
    let side = false;

    if (this.grazed && this.grazed.dist + this.grazed.depth < this.distance - 1) this.grazed = null;

    this.obstacles.forEach((o) => {
      if (hit || o.destroyed || o === this.grazed) return;
      this.obstacles.getCollider(o, this.distance, this.oBox);
      if (!overlaps(this.pBox, this.oBox)) return;
      this.obstacles.getCollider(o, this.prevDistance, this.oPrev);
      side = overlapZ(this.pPrev, this.oPrev) && !overlapX(this.pPrev, this.oPrev);
      hit = o;
    });
    if (!hit) return;
    const o = hit as Obstacle;

    // Invincible power-ups plough straight through, fixing/deleting as they go.
    if (this.powers.invincible) {
      this.deleteObstacle(o, isBadBug(o.kind));
      return;
    }
    if (p.invulnerable) {
      this.grazed = o;
      return;
    }

    const pen = Math.min(this.pBox.maxX - this.oBox.minX, this.oBox.maxX - this.pBox.minX);
    const leaving = o.lane !== p.lane;
    const graze = side || (p.changingLane && pen < CONFIG.player.grazeTolerance);
    const absorbed = this.powers.absorbHit();
    const damage = absorbed ? 0 : graze ? CONFIG.health.graze : CONFIG.health.hit;
    const z = -(o.dist - this.distance);

    o.noScore = true;
    if (graze) {
      p.stumble(!leaving);
      this.grazed = o;
    } else {
      // Head-on: the hazard shatters and we stagger through it.
      p.stumble(false);
      this.obstacles.destroy(o);
    }
    this.hits++;
    this.health = Math.max(0, this.health - damage);
    this.killer = o.kind;
    if (!absorbed) {
      this.combo.break('hit');
      this.speedPenalty = CONFIG.speed.hitPenalty * (graze ? 0.5 : 1);
      this.hud.popup(`-${damage}% SYSTEM HEALTH`, 'red', true);
      this.hud.damageFlash();
      audio.play(graze ? 'graze' : 'hit');
    }
    events.emit('hit', { kind: o.kind, damage, health: this.health, absorbed, graze, x: o.x, y: o.cls === 'high' ? 1.6 : 0.4, z });
    if (this.health <= 0) this.die(o);
  }

  private checkPickups(): void {
    const p = this.player;
    const cy = p.y + (p.sliding ? CONFIG.player.slideHeight : CONFIG.player.height) / 2;
    for (const c of this.pickups.active) {
      if (c.collected) continue;
      const z = -(c.dist - this.distance);
      const r = c.kind === 'power' ? 1.35 : c.kind === 'goodBug' || c.kind === 'bossPatch' ? 1.25 : CONFIG.coin.pickupRadiusXZ;
      if (z < -r || z > r) continue;
      if (Math.abs(c.x - p.x) > r) continue;
      const cyItem = c.kind === 'goodBug' ? 0.4 : c.kind === 'power' ? 1.3 : c.y;
      if (Math.abs(cyItem - cy) > CONFIG.coin.pickupRadiusY + (c.kind === 'goodBug' ? 0.4 : 0)) continue;
      this.pickups.collect(c);
      this.collect(c, z);
    }
  }

  private collect(c: Pickup, z: number): void {
    const S = CONFIG.score;
    const at = { x: c.x, y: c.kind === 'goodBug' ? 0.4 : c.y, z };
    switch (c.kind) {
      case 'coin':
        this.coinCount++;
        this.addScore(S.coin);
        this.combo.keepAlive(CONFIG.combo.coinKeepAlive);
        this.coinStreak = Math.min(this.coinStreak + 1, 14);
        this.coinStreakT = 0.45;
        audio.play('coin', [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24][this.coinStreak]);
        break;
      case 'code':
        this.addScore(S.code);
        this.combo.keepAlive(CONFIG.combo.coinKeepAlive * 2);
        audio.play('code');
        break;
      case 'chip':
        this.addScore(S.chip);
        this.xp += CONFIG.xp.chip;
        this.hud.popup('DATA CHIP +100', 'green');
        audio.play('chip');
        break;
      case 'xp':
        this.addScore(S.xpFile);
        this.xp += CONFIG.xp.xpFile;
        this.hud.popup(`+${CONFIG.xp.xpFile} XP`, 'pink', true);
        audio.play('xp');
        break;
      case 'patch':
        this.addScore(S.patch);
        this.heal(CONFIG.health.patch);
        this.combo.add(CONFIG.combo.points.patch, 'PATCH');
        this.hud.popup(`SYSTEM PATCHED +${CONFIG.health.patch}%`, 'green', true);
        audio.play('patch');
        break;
      case 'bossPatch':
        this.addScore(S.bossPatch);
        this.boss.patch();
        break;
      case 'goodBug': {
        this.bugsFixed++;
        const streak = this.combo.fixBug();
        this.coinCount += 2;
        this.xp += CONFIG.xp.bugFix;
        this.addScore(S.bugFix);
        this.heal(CONFIG.health.bugFix);
        this.hud.bugFixCard(streak, CONFIG.xp.bugFix, this.powers.has('debug'));
        this.hud.popup(`BUG FIXED +${streak}`, 'green', true);
        audio.play('bugFix', Math.min(streak - 1, 7));
        events.emit('bugFixed', { ...at, streak, total: this.bugsFixed });
        break;
      }
      case 'power':
        this.addScore(S.power);
        this.xp += CONFIG.xp.power;
        this.powers.activate(c.power!);
        break;
    }
    events.emit('pickup', { kind: c.kind, power: c.power, ...at });
  }

  private die(o: Obstacle): void {
    this.combo.break('death');
    this.player.kill();
    this.cam.shake(1);
    this.setState(GameState.Dying);
    this.hud.crash();
    audio.play('crash');
    events.emit('death', { kind: o.kind, score: this.score, distance: this.distance });
  }

  private finishRun(): void {
    const isNewBest = this.score > this.best;
    if (isNewBest) {
      this.best = Math.floor(this.score);
      BestScore.set(this.best);
      events.emit('newBest', { score: this.best });
    }
    Lifetime.add({ runs: 1, xp: this.xp, coins: this.coinCount, bugsFixed: this.bugsFixed });
    this.hud.showGameOver({
      score: this.score,
      distance: this.distance,
      coins: this.coinCount,
      bugsFixed: this.bugsFixed,
      bestCombo: this.combo.best,
      bestMultiplier: this.combo.bestMultiplier,
      xp: this.xp,
      health: this.health,
      best: this.best,
      isNewBest,
      cause: CAUSE[this.killer],
      stageName: `STAGE ${this.stage.id} ${this.stage.name}`,
    });
    this.setState(GameState.GameOver);
  }

  private stats() {
    return {
      score: this.score,
      coins: this.coinCount,
      distance: this.distance,
      bugsFixed: this.bugsFixed,
      xp: this.xp,
      health: this.health,
      multiplier: this.multiplier,
      powerMult: this.powers.scoreMult,
      combo: this.combo.combo,
      comboTimer: this.combo.timerFrac,
      tierProgress: this.combo.tierProgress,
      stageId: this.stage.id,
      stageName: this.stage.name,
      powers: this.powers.active(),
    };
  }

  /** Stage lighting moods, env-map swaps, shadow follow and glitch bursts. */
  private updateLighting(dt: number, playing: boolean, mode: string | null): void {
    const px = this.player.x;
    this.key.position.set(px - 5, 14, 9);
    this.key.target.position.set(px, 0, -8);
    this.shadowCatcher.position.x = px;

    // Bake the next stage's lighting a little before we get there (no hitch at the switch).
    const next = STAGES[this.stage.id];
    if (playing && next && this.distance > next.at - 120 && this.prewarmed !== next.id) {
      this.prewarmed = next.id;
      this.envMaps.prewarm(`stage${next.id}`);
    }
    const want = mode === 'debug' ? 'debug' : mode === 'admin' ? 'admin' : `stage${this.stage.id}`;
    if (want !== this.envKey) {
      this.envKey = want;
      this.scene.environment = this.envMaps.get(want);
    }

    // Ambient mood (virus = dark) + red warning strobe in corrupted / critical stages.
    const st = this.stage;
    const strobe = st.strobe > 0 && playing ? Math.pow(Math.max(0, Math.sin(this.clock * 3.2)), 8) * st.strobe : 0;
    const beat = THEME.uBeat.value;
    this.hemi.intensity += (0.55 * st.ambient - this.hemi.intensity) * Math.min(1, dt * 2);
    this.key.intensity = 2.2 * (0.55 + 0.45 * st.ambient) + beat * 0.25;
    if (strobe > 0.01) this.rim.color.lerp(this.red, strobe);
    this.rim.intensity = 1.6 + strobe * 2.5 + beat * 0.4;

    // Short, rare glitch bursts only where the system is actually corrupted.
    if (playing && st.glitch > 0.03) {
      this.glitchTimer -= dt;
      if (this.glitchTimer <= 0) {
        this.post.glitch(0.35 + st.glitch * 4);
        this.glitchTimer = 7 + Math.random() * 9 - st.glitch * 30;
      }
    }
  }

  /**
   * Compile every material in the scene - including hidden pooled effects,
   * the boss and power-up visuals - as the variant it is actually drawn with.
   * Shader variants depend on the render target (off-screen HDR targets skip
   * tone mapping), so compiling against the screen would build the wrong ones
   * and leave the real ones to compile mid-run.
   */
  private warmShaders(): void {
    if (!this.renderEnabled || this.gpuLost) return;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const targets: (THREE.WebGLRenderTarget | null)[] = [this.post.sceneTarget];
    if (!this.post.sceneTarget && this.reflection) targets.push(this.reflection.target);
    const ready: Promise<unknown>[] = [];
    for (const t of targets) {
      r.setRenderTarget(t);
      ready.push(r.compileAsync(this.scene, this.cam.camera));
    }
    r.setRenderTarget(prev);
    void Promise.all(ready).then(() => this.warmDraw());
  }

  /**
   * Draw everything that is currently hidden (pooled effects, power-up
   * visuals, the boss, empty instanced pools) once, off-screen. A compiled
   * shader still needs GPU pipeline state for each blend/cull/target setup it
   * is drawn with, and the GPU builds that on first draw - so do the first
   * draw now, in the menu, instead of on the first power-up of the run.
   */
  private warmDraw(): void {
    if (!this.renderEnabled || this.gpuLost) return;
    const hidden: THREE.Object3D[] = [];
    const culled: THREE.Object3D[] = [];
    const empty: THREE.InstancedMesh[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        o.visible = true;
        hidden.push(o);
      }
      if (o.frustumCulled) {
        o.frustumCulled = false;
        culled.push(o);
      }
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh && im.count === 0) {
        im.count = 1;
        empty.push(im);
      }
    });
    const r = this.renderer;
    const prev = r.getRenderTarget();
    try {
      r.shadowMap.needsUpdate = true;
      this.reflection?.render(r, this.scene, this.cam.camera, [this.track.group, this.shadowCatcher]);
      r.setRenderTarget(this.post.sceneTarget ?? this.reflection?.target ?? null);
      r.render(this.scene, this.cam.camera);
    } finally {
      r.setRenderTarget(prev);
      for (const o of hidden) o.visible = false;
      for (const o of culled) o.frustumCulled = true;
      for (const im of empty) im.count = 0;
    }
  }

  /** The GPU dropped the context (iOS GPU reset / memory pressure). */
  private onContextLost(): void {
    this.gpuLost = true;
    this.pause();
    this.hud.banner('GRAPHICS RESET', 'RESTORING…', 'orange', 3);
    window.setTimeout(() => {
      if (this.gpuLost) showDiagnostics(this.renderer, ['The graphics driver did not come back.', ...this.watchdog.errors]);
    }, 10000);
  }

  /**
   * Context is back. three.js re-creates its GL objects lazily from the data
   * it still holds (geometry, textures, render targets); only content that
   * existed solely on the GPU - the baked lighting - has to be rebuilt.
   */
  private onContextRestored(): void {
    this.gpuLost = false;
    this.envMaps.rebuild();
    this.scene.environment = this.envMaps.get(this.envKey);
    this.warmShaders();
    this.hud.banner('GRAPHICS RESTORED', this.state === GameState.Paused ? 'TAP TO RESUME' : '', 'green', 1.6);
  }

  /**
   * The finished frame keeps coming out black: step the pipeline down until
   * something shows (post chain -> reflections -> shadows -> plain render),
   * then show diagnostics if even that fails.
   */
  private recoverBlackScreen(): void {
    this.recoverStep++;
    this.watchdog.log(`black frame -> recovery step ${this.recoverStep} (post level ${this.post.safeLevel})`);
    if (this.post.fallback()) return;
    if (this.reflection) {
      this.reflection = null;
      this.track.reflectUniforms.uReflectOn.value = 0;
      return;
    }
    if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = false;
      this.key.castShadow = false;
      this.shadowCatcher.visible = false;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
      });
      return;
    }
    this.watchdog.done = true;
    showDiagnostics(this.renderer, this.watchdog.errors);
  }

  private onResize = (): void => {
    this.resizes++;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
    this.reflection?.setSize(w * this.pixelRatio, h * this.pixelRatio);
    this.setViewportSizes();
    this.cam.setAspect(w / h);
  };
}
