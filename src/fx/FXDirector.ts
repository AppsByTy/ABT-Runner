import * as THREE from 'three';
import { events } from '../core/EventBus';
import { THEME } from '../core/Theme';
import type { CameraController } from '../game/CameraController';
import type { PlayerController } from '../game/PlayerController';
import type { VirusBoss } from '../game/VirusBoss';
import { POWER_INFO, type PowerType } from '../world/Pickups';
import { glyphAtlas } from '../world/ComputerWorld';
import { canvasTexture } from '../utils/textures';
import { Particles, Shape } from './Particles';
import type { PostFX } from './PostFX';
import { SpeedLines } from './SpeedLines';
import { Trail } from './Trails';

const LIME = '#b4ff1e';
const GREEN = '#39ff6a';
const MAGENTA = '#ff2bd6';
const CYAN = '#00e5ff';
const GOLD = '#ffd23a';
const RED = '#ff2a4a';

interface Burst3D {
  mesh: THREE.Mesh;
  t: number;
  life: number;
  z: number;
  kind: 'ring' | 'check' | 'beam';
}

/**
 * Turns gameplay events into feedback: particles, sneaker trails, speed
 * lines, auras, camera kicks and post-process pulses. Gameplay code never
 * talks to any of these directly.
 */
export class FXDirector {
  readonly particles: Particles;
  /** Alpha-blended smoke / virus matter (dark particles can't be additive). */
  readonly dark: Particles;
  private readonly checkPts: Float32Array;
  private debugEmit = 0;
  private powerEmit = 0;
  private powerColor = '#ffffff';
  private readonly trails: [Trail, Trail];
  private readonly speedLines: SpeedLines;
  private readonly underglow: THREE.PointLight;
  private readonly foot = new THREE.Vector3();
  private slideEmit = 0;
  private readonly player: PlayerController;
  private readonly shield: THREE.Mesh;
  private readonly shieldU = { uTime: THEME.uTime, uHit: { value: 0 }, uOn: { value: 0 } };
  private readonly halo: THREE.Points;
  private readonly haloU = { uTime: THEME.uTime, uColor: { value: new THREE.Color(GREEN) }, uOn: { value: 0 }, uGlyphs: { value: glyphAtlas() }, uScale: { value: 500 } };
  private readonly bursts: Burst3D[] = [];
  private readonly ringGeo = new THREE.RingGeometry(0.7, 0.85, 40);
  private readonly checkTex: THREE.CanvasTexture;
  private readonly scene: THREE.Scene;
  private haloTarget = 0;

  constructor(scene: THREE.Scene, player: PlayerController, cam: CameraController, post: PostFX, boss: VirusBoss, density = 1) {
    this.scene = scene;
    this.player = player;
    this.particles = new Particles(scene, 1400);
    this.dark = new Particles(scene, 500, true);
    this.particles.density = this.dark.density = Math.min(1, density);
    // Checkmark outline sampled into points (local, in a camera-facing plane).
    const pts: number[] = [];
    const seg = (ax: number, ay: number, bx: number, by: number, n: number): void => {
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        pts.push(ax + (bx - ax) * t, ay + (by - ay) * t, 0);
      }
    };
    seg(-0.42, 0.02, -0.12, -0.3, 12);
    seg(-0.12, -0.3, 0.48, 0.36, 22);
    this.checkPts = new Float32Array(pts);
    this.trails = [new Trail(scene, MAGENTA, 0.08), new Trail(scene, MAGENTA, 0.08)];
    this.speedLines = new SpeedLines(scene);
    this.underglow = new THREE.PointLight(0x00e5ff, 2.2, 4.5, 2);
    scene.add(this.underglow);

    // Firewall shield: hexagonal energy bubble around the player.
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.25, 32, 20),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: this.shieldU,
        vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform float uHit; uniform float uOn;
          varying vec3 vN; varying vec3 vP;
          void main() {
            float fres = pow(1.0 - abs(vN.z), 2.2);
            vec2 p = vec2(atan(vP.x, vP.z) * 3.0, vP.y * 3.4);
            vec2 g = abs(fract(p + vec2(0.5 * step(0.5, fract(p.y * 0.5)), 0.0)) - 0.5);
            float hex = smoothstep(0.42, 0.48, max(g.x, g.y));
            float scan = smoothstep(0.1, 0.0, abs(fract(vP.y * 0.4 - uTime * 0.7) - 0.5) - 0.4);
            vec3 c = vec3(1.0, 0.45, 0.1) * (fres * 1.2 + hex * 0.35 + scan * 0.3) + vec3(1.0) * uHit;
            gl_FragColor = vec4(c * uOn, 1.0);
          }`,
      }),
    );
    this.shield.visible = false;
    scene.add(this.shield);

    // Code halo: glyphs orbiting the character in power-up modes.
    const n = 36;
    const pos = new Float32Array(n * 3);
    const cell = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (i / n) * Math.PI * 2; // angle
      pos[i * 3 + 1] = 0.2 + (i % 6) * 0.3; // height
      pos[i * 3 + 2] = 0.9 + (i % 3) * 0.15; // radius
      cell[i] = i % 16;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));
    this.halo = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: this.haloU,
        vertexShader: /* glsl */ `
          uniform float uTime; uniform float uScale;
          attribute float aCell;
          varying float vCell;
          void main() {
            vCell = aCell;
            float a = position.x + uTime * (1.2 + mod(aCell, 3.0) * 0.4);
            vec3 p = vec3(cos(a) * position.z, position.y + sin(uTime * 2.0 + aCell) * 0.1, sin(a) * position.z);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = uScale * 0.17 / -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uGlyphs; uniform vec3 uColor; uniform float uOn;
          varying float vCell;
          void main() {
            vec2 c = vec2(mod(vCell, 4.0), floor(vCell / 4.0)) / 4.0;
            float g = texture2D(uGlyphs, c + gl_PointCoord / 4.0).r;
            gl_FragColor = vec4(uColor * g * uOn * 1.6, 1.0);
          }`,
      }),
    );
    this.halo.frustumCulled = false;
    scene.add(this.halo);

    this.checkTex = canvasTexture(128, 128, (ctx) => {
      ctx.strokeStyle = GREEN;
      ctx.shadowColor = GREEN;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 18;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(26, 68);
      ctx.lineTo(54, 96);
      ctx.lineTo(104, 34);
      ctx.stroke();
    });

    const p = this.particles;
    player.character.onFootstep = (side) => events.emit('footstep', { side });

    events.on('footstep', ({ side }) => {
      player.character.getFootWorld(side, this.foot);
      p.burst(this.foot.x, 0.05, this.foot.z + 0.1, {
        count: 3, color: [CYAN, MAGENTA], speed: [0.6, 1.8], dir: [0, 1, 1], spread: 0.9, life: [0.2, 0.4], size: [0.05, 0.1], gravity: 5, shape: [Shape.Spark, Shape.Orb],
      });
    });
    events.on('pickup', ({ kind, x, y, z }) => {
      const color =
        kind === 'coin' ? [GOLD, '#fff3b0'] : kind === 'code' ? [CYAN, '#ffffff'] : kind === 'chip' ? [GREEN, LIME] : kind === 'xp' ? ['#c59bff', '#ffffff'] : kind === 'patch' || kind === 'bossPatch' ? [GREEN, GOLD] : [LIME];
      if (kind === 'coin') {
        // Gold glint: star sparkles, a few hot orbs and flying streaks.
        p.burst(x, y, z, { count: 5, color: ['#fff6c8', GOLD], speed: [0.4, 1.2], life: [0.3, 0.45], size: [0.28, 0.42], drag: 4, shape: Shape.Spark });
        p.burst(x, y, z, { count: 12, color: [GOLD, '#ffe27a', '#ffffff'], speed: [3, 6.5], life: [0.25, 0.45], size: [0.05, 0.1], gravity: 5, drag: 2.5, shape: Shape.Streak });
      } else {
        p.burst(x, y, z, { count: 8, color, speed: [0.5, 1.5], life: [0.3, 0.5], size: [0.2, 0.32], drag: 4, shape: Shape.Spark });
        p.burst(x, y, z, { count: 16, color, speed: [2, 5], life: [0.3, 0.55], size: [0.08, 0.16], gravity: 3, drag: 3, shape: kind === 'code' || kind === 'xp' ? [Shape.Glyph, Shape.Streak] : [Shape.Shard, Shape.Streak], spin: 8 });
      }
      if (kind === 'patch' || kind === 'bossPatch') this.ring(x, 0.05, z, kind === 'bossPatch' ? GOLD : GREEN, 1.6);
    });
    events.on('bugFixed', ({ x, z }) => {
      this.ring(x, 0.05, z, GREEN, 1.3);
      this.assembleCheck(x, 2.55, Math.min(z, -0.6));
      p.burst(x, 0.5, z, { count: 18, color: [GREEN, LIME, '#ffffff', CYAN], speed: [2.5, 6], dir: [0, 1, 0], spread: 1.1, life: [0.35, 0.7], size: [0.06, 0.12], gravity: 6, drag: 2, shape: [Shape.Glyph, Shape.Streak, Shape.Spark] });
    });
    events.on('jump', () => {
      p.burst(player.x, 0.1, 0.1, { count: 12, color: [LIME, CYAN], speed: [1.5, 3.5], dir: [0, 0.4, 1], spread: 1.4, life: [0.25, 0.45], size: [0.07, 0.14], gravity: 3, shape: [Shape.Streak, Shape.Spark] });
      cam.kickFov(2.5);
    });
    events.on('land', () => {
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        p.burst(player.x + Math.cos(a) * 0.3, 0.06, Math.sin(a) * 0.3, {
          count: 1, color: i % 2 ? CYAN : MAGENTA, speed: [2.5, 3.5], dir: [Math.cos(a), 0.15, Math.sin(a)], spread: 0.15, life: [0.25, 0.4], size: [0.08, 0.13], drag: 5, shape: Shape.Streak,
        });
      }
      cam.dip(0.16);
    });
    events.on('slideStart', () => {
      p.burst(player.x, 0.1, 0.2, { count: 14, color: [CYAN, MAGENTA, '#ffffff'], speed: [2, 4], dir: [0, 0.6, 1], spread: 0.8, life: [0.2, 0.4], size: [0.06, 0.12], gravity: 6, shape: Shape.Streak });
      cam.dip(0.1);
    });
    events.on('laneChange', ({ dir }) => {
      p.burst(player.x, 0.4, 0.3, { count: 6, color: [CYAN, '#ffffff'], speed: [2, 3.5], dir: [-dir, 0.2, 1], spread: 0.4, life: [0.15, 0.3], size: [0.05, 0.09], drag: 4, shape: Shape.Streak });
    });
    events.on('hit', ({ x, y, z, absorbed, graze }) => {
      if (absorbed) {
        this.shieldU.uHit.value = 1;
        p.burst(player.x, 1, 0, { count: 40, color: ['#ff7a1a', '#ffd23a', '#ffffff'], speed: [4, 9], life: [0.3, 0.6], size: [0.07, 0.15], drag: 2, jitter: 1.2, shape: [Shape.Shard, Shape.Streak, Shape.Spark], spin: 10 });
        post.flashScreen('#ff7a1a', 0.3);
        cam.shake(0.35);
        return;
      }
      p.burst(x, y + 0.6, z, { count: graze ? 18 : 36, color: [RED, '#ffffff', MAGENTA], speed: [3, 9], dir: [0, 0.5, 1], spread: 1.2, life: [0.25, 0.55], size: [0.08, 0.18], gravity: 9, shape: [Shape.Pixel, Shape.Shard, Shape.Streak], spin: 12 });
      if (!graze) this.dark.burst(x, y + 0.8, z, { count: 14, color: ['#1a0206', '#3a0410', '#000000'], speed: [0.8, 2.2], dir: [0, 1, 0.4], life: [0.5, 0.9], size: [0.25, 0.5], drag: 2, shape: Shape.Orb });
      post.glitch(graze ? 0.45 : 0.9);
      post.pulse(0.7);
      post.flashScreen('#ff1144', graze ? 0.22 : 0.4);
      cam.shake(graze ? 0.4 : 0.7);
    });
    events.on('obstacleDeleted', ({ x, y, z, badBug }) => {
      p.burst(x, y + 0.5, z, {
        count: 30, color: badBug ? [GREEN, LIME, '#ffffff'] : ['#ffffff', GOLD, CYAN], speed: [3, 8], life: [0.3, 0.6], size: [0.08, 0.16], drag: 2, jitter: 1,
        shape: [Shape.Pixel, Shape.Glyph, Shape.Streak], spin: 8,
      });
      if (badBug) {
        this.ring(x, 0.05, z, GREEN, 1.4);
        this.assembleCheck(x, 2.2, Math.min(z, -2));
      }
    });
    events.on('materialize', ({ x, z }) => {
      if (z < -150) return;
      p.burst(x, 0.3, z, { count: 18, color: [RED, MAGENTA, '#ffffff'], speed: [1.5, 4], dir: [0, 1, 0], spread: 0.8, life: [0.3, 0.6], size: [0.1, 0.2], drag: 2, jitter: 1.2, shape: [Shape.Pixel, Shape.Glyph] });
      if (boss.fighting) this.dark.burst(x, 0.6, z, { count: 10, color: ['#000000', '#2a0008'], speed: [0.5, 1.5], dir: [0, 1, 0], life: [0.5, 0.9], size: [0.4, 0.7], drag: 1.5, jitter: 1 });
      if (boss.fighting) this.beam(boss.mouth, x, z);
    });
    events.on('nearMiss', ({ x, y, style }) => {
      const dirX = style === 'lateral' ? Math.sign(x - player.x) : 0;
      p.burst(x, y, 0, { count: 20, color: ['#ffffff', CYAN, LIME], speed: [3, 7], dir: [dirX, style === 'vertical' ? 1 : 0.3, 1], spread: 0.7, life: [0.2, 0.45], size: [0.06, 0.12], drag: 3, shape: Shape.Streak });
      post.pulse(0.7);
      post.flashScreen(CYAN, 0.12);
      this.speedLines.boost(0.8);
      cam.kickFov(4);
    });
    events.on('obstacleCleared', ({ x, y }) => {
      p.burst(x, y, 0.3, { count: 8, color: [LIME, '#ffffff'], speed: [1.5, 3], life: [0.2, 0.35], size: [0.05, 0.1], drag: 3, shape: Shape.Spark });
    });
    events.on('combo', ({ levelUp, multiplier }) => {
      if (!levelUp) return;
      post.flashScreen(multiplier >= 5 ? MAGENTA : LIME, 0.16);
      this.speedLines.boost(0.6);
      cam.kickFov(3);
    });
    events.on('powerStart', ({ type }) => {
      const c = POWER_INFO[type].color;
      this.ring(player.x, 0.05, 0, c, 2.6);
      this.ring(player.x, 1.0, 0, c, 2.0);
      p.burst(player.x, 1, 0, { count: 36, color: [c, '#ffffff'], speed: [3, 8], life: [0.4, 0.8], size: [0.08, 0.16], drag: 2, jitter: 0.8, shape: [Shape.Streak, Shape.Spark, Shape.Shard], spin: 8 });
      // Energy wraps the character for a moment (see update()).
      this.powerEmit = 0.9;
      this.powerColor = c;
      post.flashScreen(c, type === 'admin' || type === 'debug' ? 0.45 : 0.25);
      post.glitch(type === 'debug' ? 0.8 : 0.3);
      cam.kickFov(type === 'boost' ? 8 : 4);
      if (type === 'debug' || type === 'admin') cam.cinematic('power', 1.1);
      if (type === 'debug' || type === 'admin') cam.cinematic('power', 1.1);
      if (type === 'boost') this.speedLines.boost(1);
    });
    events.on('stage', () => {
      post.glitch(1.2);
      post.flashScreen(THEME.uPrimary.value.getStyle(), 0.2);
    });
    events.on('bossStart', () => {
      cam.cinematic('boss', 2.2);
      post.glitch(1.0);
      post.flashScreen(RED, 0.3);
      cam.shake(0.5);
    });
    events.on('bossPatched', () => {
      const b = boss.mouth;
      p.burst(b.x, b.y, b.z, { count: 40, color: [GOLD, '#ffffff', GREEN], speed: [4, 10], life: [0.4, 0.8], size: [0.25, 0.5], drag: 1.5, world: false, jitter: 3, shape: [Shape.Spark, Shape.Shard, Shape.Glyph], spin: 6 });
      this.dark.burst(b.x, b.y, b.z, { count: 16, color: ['#000000', '#1a0005'], speed: [2, 5], life: [0.6, 1.1], size: [0.8, 1.4], drag: 1.5, world: false, jitter: 2 });
      this.beam(new THREE.Vector3(player.x, 1, 0), b.x, b.z, GOLD, b.y);
    });
    events.on('bossDeleted', () => {
      const b = boss.mouth;
      p.burst(b.x, b.y, b.z, { count: 160, color: [GREEN, '#ffffff', GOLD, RED], speed: [6, 20], life: [0.6, 1.4], size: [0.3, 0.7], drag: 1, world: false, jitter: 4, shape: [Shape.Pixel, Shape.Shard, Shape.Streak, Shape.Glyph, Shape.Spark], spin: 10 });
      this.dark.burst(b.x, b.y, b.z, { count: 50, color: ['#000000', '#200006', '#050505'], speed: [3, 9], life: [0.8, 1.6], size: [1, 2], drag: 1.2, world: false, jitter: 4 });
      post.flashScreen('#ffffff', 0.6);
      post.glitch(1);
      cam.shake(0.8);
    });
    events.on('death', () => {
      // Crash: the character shatters into glitch fragments.
      p.burst(player.x, 1.1, -0.2, { count: 90, color: [RED, MAGENTA, '#ffffff', CYAN], speed: [3, 10], life: [0.5, 1.1], size: [0.1, 0.24], gravity: 7, drag: 1.5, jitter: 0.6, shape: [Shape.Pixel, Shape.Pixel, Shape.Shard, Shape.Glyph], spin: 14 });
      this.dark.burst(player.x, 1, -0.2, { count: 24, color: ['#000000', '#2a0008'], speed: [1, 3], dir: [0, 1, 0], life: [0.8, 1.4], size: [0.4, 0.8], drag: 1.5, jitter: 0.6 });
      post.pulse(1);
      post.glitch(1.5);
      post.flashScreen('#ff1144', 0.6);
    });
  }

  // ------------------------------------------------------------ 3D bursts

  private ring(x: number, y: number, z: number, color: string, size: number): void {
    const mesh = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.userData.size = size;
    this.scene.add(mesh);
    this.bursts.push({ mesh, t: 0, life: 0.5, z, kind: 'ring' });
  }

  private beatGlow = 0;

  /** Music beat hook: environment + particles react in DEBUG and at high combo. */
  onBeat(kind: 'kick' | 'snare', mode: PowerType | null, running: boolean, multiplier: number): void {
    if (!running) return;
    const pl = this.player;
    this.beatGlow = kind === 'kick' ? 1 : 0.6;
    if (mode === 'debug' && kind === 'kick') {
      this.ring(pl.x, 0.04, -0.5, GREEN, 2.4);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        this.particles.burst(pl.x + Math.cos(a) * 0.9, 0.08, Math.sin(a) * 0.9, {
          count: 1, color: [GREEN, '#caffd8'], speed: [2.5, 3.5], dir: [Math.cos(a), 0.9, Math.sin(a)], spread: 0.1, life: [0.4, 0.6], size: [0.12, 0.16], world: false, drag: 2, shape: Shape.Glyph,
        });
      }
    }
    if (multiplier >= 5 && kind === 'snare') {
      const c = multiplier >= 10 ? GOLD : MAGENTA;
      for (const side of [-1, 1]) {
        this.particles.burst(side * 4.3, 0.4, -14, { count: 6, color: [c, '#ffffff'], speed: [3, 6], dir: [-side * 0.2, 1, 0.3], spread: 0.3, life: [0.3, 0.5], size: [0.1, 0.16], gravity: 6, shape: [Shape.Spark, Shape.Streak] });
      }
    }
  }

  /** Particles burst out, then snap together into a green checkmark. */
  private assembleCheck(x: number, y: number, z: number): void {
    const n = this.checkPts.length / 3;
    const home = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      home[i * 3] = x + this.checkPts[i * 3] * 1.3;
      home[i * 3 + 1] = y + this.checkPts[i * 3 + 1] * 1.3;
      home[i * 3 + 2] = z;
    }
    this.particles.burst(x, y - 0.6, z, {
      count: n * 2, color: [GREEN, LIME, '#d8ffe0'], speed: [3, 6], life: [0.9, 1.05], size: [0.1, 0.15],
      shape: [Shape.Orb, Shape.Glyph], home, homeDelay: 0.12, homeK: 70, world: false,
    });
    this.check(x, y, z, 0.35);
  }

  private check(x: number, y: number, z: number, delay = 0): void {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({ map: this.checkTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(1.6, 1.6, 1.6) }),
    );
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.bursts.push({ mesh, t: -delay, life: 0.8, z, kind: 'check' });
  }

  private beam(from: THREE.Vector3, x: number, z: number, color = RED, y = 0): void {
    const to = new THREE.Vector3(x, y, z);
    const len = from.distanceTo(to);
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.2, len, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    this.scene.add(mesh);
    this.bursts.push({ mesh, t: 0, life: 0.35, z: mesh.position.z, kind: 'beam' });
  }

  private updateBursts(dt: number, scroll: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.t += dt;
      const k = Math.max(0, b.t / b.life);
      const mat = b.mesh.material as THREE.MeshBasicMaterial;
      b.mesh.visible = b.t >= 0;
      if (k >= 1) {
        this.scene.remove(b.mesh);
        mat.dispose();
        if (b.kind !== 'ring') b.mesh.geometry.dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      if (b.kind === 'ring') b.mesh.position.z += scroll;
      if (b.kind === 'ring') {
        b.mesh.scale.setScalar(0.3 + k * (b.mesh.userData.size as number));
        mat.opacity = 1 - k;
      } else if (b.kind === 'check') {
        b.mesh.position.y += dt * 1.4;
        b.mesh.scale.setScalar(k < 0.2 ? k * 6 : 1.2 - (k - 0.2) * 0.3);
        mat.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      } else {
        mat.opacity = 1 - k;
        b.mesh.scale.set(1 - k * 0.8, 1, 1 - k * 0.8);
      }
    }
  }

  reset(): void {
    this.particles.clear();
    this.dark.clear();
    for (const t of this.trails) t.reset();
    for (const b of this.bursts) this.scene.remove(b.mesh);
    this.bursts.length = 0;
    this.haloTarget = 0;
    this.haloU.uOn.value = 0;
  }

  setViewportHeight(px: number): void {
    this.particles.setViewportHeight(px);
    this.dark.setViewportHeight(px);
    this.haloU.uScale.value = px;
  }

  /**
   * @param scroll world distance travelled this frame
   * @param running true while a run is in progress (not menu / game over)
   */
  update(dt: number, scroll: number, speed: number, speedFactor: number, running: boolean, mode: PowerType | null, shieldOn: boolean): void {
    const pl = this.player;

    // Slide sparks.
    if (running && pl.sliding) {
      this.slideEmit += dt * 90;
      while (this.slideEmit >= 1) {
        this.slideEmit -= 1;
        this.particles.burst(pl.x + (Math.random() - 0.5) * 0.4, 0.05, 0.1, {
          count: 1, color: [CYAN, '#ffffff', MAGENTA], speed: [2, 5], dir: [0, 0.8, 1], spread: 0.5, life: [0.15, 0.35], size: [0.04, 0.09], gravity: 12, shape: Shape.Streak,
        });
      }
    }
    // Admin: golden sparks; boost: code streaming behind.
    if (running && mode === 'admin' && Math.random() < dt * 30) {
      this.particles.burst(pl.x + (Math.random() - 0.5), 0.2 + Math.random() * 1.8, 0.2, { count: 1, color: [GOLD, '#ffffff'], speed: [0.5, 2], dir: [0, 1, 0.5], life: [0.4, 0.8], size: [0.1, 0.18], drag: 1, shape: Shape.Spark });
    }

    // DEBUG MODE: code glyphs stream up around the runner.
    if (running && mode === 'debug') {
      this.debugEmit += dt * 11;
      while (this.debugEmit >= 1) {
        this.debugEmit -= 1;
        const a = Math.random() * Math.PI * 2;
        this.particles.burst(pl.x + Math.cos(a) * 1.1, 0.1 + Math.random() * 0.4, Math.sin(a) * 1.1, {
          count: 1, color: [GREEN, '#b8ffcc', CYAN], speed: [1.2, 2.4], dir: [0, 1, 0], spread: 0.15, life: [0.7, 1.1], size: [0.07, 0.11], world: false, shape: Shape.Glyph,
        });
      }
    }
    // Power-up activation: a rising energy helix wraps the character.
    if (this.powerEmit > 0) {
      this.powerEmit -= dt;
      const t = 0.9 - this.powerEmit;
      for (let k = 0; k < 2; k++) {
        const a = t * 14 + k * Math.PI;
        this.particles.burst(pl.x + Math.cos(a) * 0.85, pl.y + t * 2.4, Math.sin(a) * 0.85, {
          count: 2, color: [this.powerColor, '#ffffff'], speed: [0.2, 0.6], life: [0.35, 0.55], size: [0.12, 0.2], world: false, drag: 3, shape: [Shape.Spark, Shape.Orb],
        });
      }
    }

    // Sneaker trails follow the mode colour.
    const target = running && !pl.dead ? 1 : 0;
    this.trails.forEach((t, side) => {
      t.intensity += (target * (mode === 'boost' ? 1.8 : 1) - t.intensity) * Math.min(1, dt * 6);
      pl.character.getFootWorld(side as 0 | 1, this.foot);
      t.update(this.foot, scroll);
    });

    // Shield bubble.
    this.shield.visible = shieldOn || this.shieldU.uOn.value > 0.01;
    this.shieldU.uOn.value += ((shieldOn ? 1 : 0) - this.shieldU.uOn.value) * Math.min(1, dt * 8);
    this.shieldU.uHit.value = Math.max(0, this.shieldU.uHit.value - dt * 3);
    this.shield.position.set(pl.x, pl.y + (pl.sliding ? 0.5 : 0.95), 0);
    this.shield.scale.set(1, pl.sliding ? 0.6 : 1, 1);

    // Code halo in DEBUG / BOOST / ADMIN.
    this.haloTarget = mode === 'debug' || mode === 'boost' || mode === 'admin' ? 1 : 0;
    this.haloU.uOn.value += (this.haloTarget - this.haloU.uOn.value) * Math.min(1, dt * 6);
    if (mode) this.haloU.uColor.value.set(POWER_INFO[mode].color);
    this.halo.visible = this.haloU.uOn.value > 0.01;
    this.halo.position.set(pl.x, pl.y, 0);

    this.updateBursts(dt, scroll);
    this.particles.update(dt, scroll);
    this.dark.update(dt, scroll);
    this.speedLines.update(dt, running ? speed : 0, running ? speedFactor : 0, pl.x * 0.85);

    this.underglow.position.set(pl.x, 0.25 + pl.y, 0.9);
    this.underglow.color.set(mode ? POWER_INFO[mode].color : '#00e5ff');
    this.beatGlow = Math.max(0, this.beatGlow - dt * 5);
    this.underglow.intensity = (pl.dead ? 0.8 : mode ? 4 : 2.2) + this.beatGlow * 1.6;
  }
}
