import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CONFIG, LANE_X } from '../core/Config';
import { GLSL_HASH, THEME } from '../core/Theme';
import { Pool } from '../utils/Pool';
import { canvasTexture } from '../utils/textures';
import { rimify } from '../utils/rim';
import type { MaterialLib } from '../render/MaterialLib';
import { glyphAtlas } from './ComputerWorld';
import type { AABB } from '../utils/math';

/**
 * Hazards inside the computer. Every hazard belongs to one collision class:
 *   low  – jump over (or change lane)
 *   high – slide under (or change lane)
 *   wall – long block: change lane
 * Bad bugs are hazards that move: glitch bugs charge, malware bugs switch
 * lanes (telegraphed), virus drones hover at head height.
 */
export type ObstacleKind = 'firewall' | 'errorWindow' | 'corruptBlock' | 'glitchBug' | 'virusDrone' | 'malwareBug' | 'packet' | 'laser' | 'shock';
export type ObstacleClass = 'low' | 'high' | 'wall';

export const KIND_CLASS: Record<ObstacleKind, ObstacleClass> = {
  firewall: 'low',
  glitchBug: 'low',
  malwareBug: 'low',
  packet: 'low',
  shock: 'low',
  errorWindow: 'high',
  laser: 'high',
  virusDrone: 'high',
  corruptBlock: 'wall',
};

export const KIND_LABEL: Record<ObstacleKind, string> = {
  firewall: 'FIREWALL',
  errorWindow: 'ERROR WINDOW',
  corruptBlock: 'CORRUPTED CODE',
  glitchBug: 'GLITCH BUG',
  virusDrone: 'VIRUS BUG',
  malwareBug: 'MALWARE BUG',
  packet: 'CORRUPT PACKET',
  laser: 'SCAN LASER',
  shock: 'SHOCKWAVE',
};

export const isBadBug = (k: ObstacleKind): boolean => k === 'glitchBug' || k === 'virusDrone' || k === 'malwareBug';

export interface Obstacle {
  kind: ObstacleKind;
  cls: ObstacleClass;
  mesh: THREE.Group;
  /** Visual root (animated/scaled), child of mesh. */
  body: THREE.Group;
  lane: number;
  /** Current centre x (moves while a malware bug switches lanes). */
  x: number;
  /** Run distance at which the obstacle's front face reaches the player (z = 0). */
  dist: number;
  depth: number;
  width: number;
  minY: number;
  maxY: number;
  variant: number;
  // Behaviour
  /** Extra closing speed (m/s) once charging. */
  charge: number;
  /** Malware: lane it will switch to (-1 = none) and switch progress. */
  toLane: number;
  fromX: number;
  switchT: number;
  phase: number;
  /** 0..1 materialise-in animation. */
  appear: number;
  /** Knocked out (hit, deleted by a power-up or fixed in debug mode). */
  destroyed: boolean;
  // Per-pass scoring state (reset on spawn).
  arrived: boolean;
  passed: boolean;
  inLane: boolean;
  minClear: number;
  noScore: boolean;
  /** Boss decoy: a hologram that can't hurt (it flickers, and gets no floor warning). */
  fake: boolean;
  late: boolean;
  /** Per-instance shader uniforms, if any. */
  uniforms?: Record<string, THREE.IUniform>;
  marker?: THREE.Object3D;
  legsA?: THREE.Object3D;
  legsB?: THREE.Object3D;
  spin?: THREE.Object3D;
}

const LW = CONFIG.lanes.width;

/**
 * Collider dims are a little smaller than the visuals: players judge by what
 * they see, and brushing a pixel of a hurdle should not cost health.
 */
const DIMS: Record<ObstacleClass, { width: number; minY: number; maxY: number }> = {
  low: { width: LW * 0.86 * 0.8, minY: 0, maxY: 0.88 },
  high: { width: LW * 0.92 * 0.8, minY: 1.22, maxY: 3.0 },
  wall: { width: LW * 0.9 * 0.8, minY: 0, maxY: 3.4 },
};

const MONO = '"SF Mono", "Cascadia Mono", Menlo, Consolas, "Courier New", monospace';

// -------------------------------------------------------------- materials

function hexEnergy(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: THEME.uTime },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      varying vec2 vUv;
      float hexd(vec2 p) {
        p = abs(p);
        return max(dot(p, normalize(vec2(1.0, 1.732))), p.x);
      }
      void main() {
        vec2 p = vUv * vec2(9.0, 4.0);
        vec2 r = vec2(1.0, 1.732);
        vec2 h = r * 0.5;
        vec2 a = mod(p, r) - h;
        vec2 b = mod(p - h, r) - h;
        vec2 gv = dot(a, a) < dot(b, b) ? a : b;
        float edge = smoothstep(0.42, 0.5, hexd(gv));
        float scan = smoothstep(0.15, 0.0, abs(fract(vUv.y * 1.0 - uTime * 0.8) - 0.5) - 0.35);
        float border = smoothstep(0.06, 0.0, min(min(vUv.x, 1.0 - vUv.x) * 4.0, min(vUv.y, 1.0 - vUv.y)));
        float a2 = 0.18 + edge * 0.55 + scan * 0.25 + border * 0.9;
        gl_FragColor = vec4(uColor * a2 * 1.4, 1.0);
      }`,
  });
}

function textTexture(text: string, color: string, w = 512, h = 96, size = 64, bg = 'rgba(0,0,0,0)'): THREE.CanvasTexture {
  return canvasTexture(w, h, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.font = `900 ${size}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, h / 2 + 4);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(text, w / 2, h / 2 + 4);
  });
}

const ERROR_MSGS = ['404 NOT FOUND', 'FATAL EXCEPTION', 'STACK OVERFLOW', 'NULL POINTER'];

function errorWindowTexture(): THREE.CanvasTexture {
  // 2x2 atlas of 512x300 dialogs.
  return canvasTexture(1024, 600, (ctx) => {
    ERROR_MSGS.forEach((msg, i) => {
      const x = (i % 2) * 512;
      const y = Math.floor(i / 2) * 300;
      ctx.fillStyle = '#2a040b';
      ctx.fillRect(x, y, 512, 300);
      ctx.fillStyle = '#ff2a4a';
      ctx.fillRect(x, y, 512, 62);
      ctx.fillStyle = '#1a0004';
      ctx.font = `900 34px ${MONO}`;
      ctx.textBaseline = 'middle';
      ctx.fillText('⚠ ERROR', x + 20, y + 33);
      ctx.fillText('✕', x + 466, y + 33);
      ctx.fillStyle = '#ff5a70';
      ctx.font = `900 88px ${MONO}`;
      ctx.fillText('⊗', x + 26, y + 170);
      ctx.fillStyle = '#ffd0d6';
      ctx.font = `800 ${msg.length > 12 ? 34 : 40}px ${MONO}`;
      ctx.fillText(msg, x + 140, y + 150);
      ctx.fillStyle = '#ff8a9a';
      ctx.font = `600 22px ${MONO}`;
      ctx.fillText(`code 0x${(0xdead + i * 4099).toString(16).toUpperCase()}`, x + 140, y + 200);
      ctx.strokeStyle = '#ff5a70';
      ctx.lineWidth = 4;
      ctx.strokeRect(x + 330, y + 234, 150, 44);
      ctx.fillStyle = '#ff8a9a';
      ctx.font = `800 24px ${MONO}`;
      ctx.fillText('OK', x + 385, y + 257);
      ctx.strokeStyle = '#ff2a4a';
      ctx.lineWidth = 8;
      ctx.strokeRect(x + 4, y + 4, 504, 292);
    });
  });
}

/** Branching glowing veins for the virus core's emissive map. */
function veinTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 256, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 512, 256);
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const branch = (x: number, y: number, a: number, len: number, w: number): void => {
      if (len < 6 || w < 0.6) return;
      const nx = x + Math.cos(a) * len;
      const ny = y + Math.sin(a) * len;
      ctx.strokeStyle = `rgba(90,255,120,${Math.min(1, w / 3)})`;
      ctx.lineWidth = w;
      ctx.shadowColor = '#39ff6a';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      branch(nx, ny, a + (rnd() - 0.5) * 1.2, len * 0.8, w * 0.8);
      if (rnd() < 0.45) branch(nx, ny, a + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.6), len * 0.65, w * 0.6);
    };
    for (let i = 0; i < 14; i++) branch(rnd() * 512, rnd() * 256, rnd() * Math.PI * 2, 36, 3.2);
  });
}

const BLOCK_LABELS = ['CORRUPTED.EXE', 'MEMORY LEAK', 'FATAL.DLL', 'GLITCH.SYS'];

function blockLabelTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 1024, (ctx) => {
    BLOCK_LABELS.forEach((label, i) => {
      const y = i * 256;
      ctx.fillStyle = '#12020a';
      ctx.fillRect(0, y, 512, 256);
      ctx.strokeStyle = '#ff2a4a';
      ctx.lineWidth = 10;
      ctx.strokeRect(8, y + 8, 496, 240);
      ctx.fillStyle = '#ff3b5c';
      ctx.font = `900 96px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚠', 256, y + 92);
      ctx.font = `900 ${label.length > 11 ? 46 : 54}px ${MONO}`;
      ctx.fillText(label, 256, y + 186);
    });
  });
}

/** Corrupted code monolith: glitching red glyphs, label on the front face. */
function corruptBlockMaterial(glyphs: THREE.Texture, labels: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: THEME.uTime,
      uGlyphs: { value: glyphs },
      uLabels: { value: labels },
      uVariant: { value: 0 },
      uDepth: { value: 8 },
      uAppear: { value: 1 },
    },
    fog: true,
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vN;
      varying vec3 vVN;
      varying vec3 vView;
      varying vec2 vUv;
      uniform float uDepth;
      uniform float uTime;
      #include <fog_pars_vertex>
      void main() {
        vLocal = position * vec3(1.0, 1.0, uDepth);
        vN = normal;
        vUv = uv;
        vec3 p = position;
        // Horizontal glitch slices.
        float slice = floor(p.y * 6.0);
        float g = step(0.93, fract(sin(slice * 91.7 + floor(uTime * 14.0)) * 43758.5));
        p.x += g * 0.12 * sign(sin(slice * 3.0 + uTime));
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        vVN = normalize(normalMatrix * normal);
        vView = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vVN;
      varying vec3 vView;
      uniform sampler2D uGlyphs;
      uniform sampler2D uLabels;
      uniform float uVariant;
      uniform float uTime;
      uniform float uAppear;
      varying vec3 vLocal;
      varying vec3 vN;
      varying vec2 vUv;
      #include <fog_pars_fragment>
      ${GLSL_HASH}
      void main() {
        vec3 n = normalize(vN);
        vec3 vn = normalize(vVN);
        vec3 vv = normalize(vView);
        // Obsidian glass body: dark base, fake studio reflection, fresnel rim.
        vec3 r = reflect(-vv, vn);
        float fres = pow(1.0 - clamp(dot(vn, vv), 0.0, 1.0), 3.0);
        float studio = smoothstep(0.55, 0.9, r.y) * 0.5 + smoothstep(0.02, 0.0, abs(r.y - 0.25)) * 0.35;
        vec3 col = vec3(0.035, 0.004, 0.012) + vec3(0.9, 0.35, 0.45) * studio * 0.18 + vec3(1.0, 0.12, 0.3) * fres * 0.55;
        // Bevelled glowing edges on every face.
        vec2 e2 = abs(vUv - 0.5) * 2.0;
        float bevel = smoothstep(0.93, 0.985, max(e2.x, e2.y));
        if (n.z > 0.5) {
          // Front face: warning label set into a dark glass panel.
          vec2 luv = vec2(vUv.x, (3.0 - uVariant + vUv.y) / 4.0);
          vec3 lab = texture2D(uLabels, luv).rgb;
          col = col * 0.6 + lab * 1.25 + vec3(1.0, 0.2, 0.3) * studio * 0.12;
          col += bevel * vec3(1.0, 0.18, 0.3) * 1.2;
        } else if (n.y > 0.5) {
          // Top: dark with running scan lines.
          float scanL = smoothstep(0.08, 0.0, abs(fract(vLocal.z * 0.35 + uTime * 1.5) - 0.5));
          col += scanL * vec3(1.0, 0.1, 0.3) * 0.35 + bevel * vec3(1.0, 0.15, 0.3) * 1.4;
        } else {
          vec2 uv = abs(n.x) > 0.5 ? vec2(vLocal.z, vLocal.y) : vec2(vLocal.x, vLocal.z);
          vec2 g = uv * vec2(2.2, 2.6);
          g.y += uTime * 3.0 * step(0.5, hash12(vec2(floor(g.x), 1.0)));
          vec2 id = floor(g);
          vec2 f = fract(g);
          float gi = floor(hash12(id + floor(uTime * 4.0 + hash12(id) * 7.0)) * 16.0);
          vec2 cell = vec2(mod(gi, 4.0), floor(gi / 4.0)) / 4.0;
          float glyph = texture2D(uGlyphs, cell + f / 4.0).r * step(0.35, hash12(id + 3.3));
          vec3 gc = mix(vec3(1.0, 0.12, 0.3), vec3(1.0, 0.2, 0.9), step(0.7, hash12(id)));
          col += glyph * gc * 1.1;
          // Circuit seams between glyph columns.
          col += smoothstep(0.04, 0.0, abs(fract(uv.x * 2.2) - 0.02)) * vec3(0.5, 0.02, 0.1) * 0.5;
          col += bevel * vec3(1.0, 0.1, 0.25) * 1.5;
        }
        float flash = (1.0 - uAppear) * 2.0;
        col += vec3(1.0, 0.3, 0.4) * flash;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// ------------------------------------------------------------ the manager

export interface SpawnOpts {
  depth?: number;
  variant?: number;
  toLane?: number;
  /** Spawned close to the player: animate materialising in. */
  materialize?: boolean;
  /** Boss attacks (laser / shockwave): energy colour. */
  color?: THREE.ColorRepresentation;
  /** Harmless decoy (Code Breaker). */
  fake?: boolean;
}

export class ObstacleManager {
  private readonly pools: Record<ObstacleKind, Pool<Obstacle>>;
  private readonly scene: THREE.Scene;
  private readonly glyphs = glyphAtlas();
  private readonly labels = blockLabelTexture();
  private readonly errorTex = errorWindowTexture();

  /** Called when an obstacle materialises close to the player (for FX). */
  onMaterialize: (o: Obstacle) => void = () => {};

  constructor(scene: THREE.Scene, lib: MaterialLib) {
    this.scene = scene;
    const metal = new THREE.MeshStandardMaterial({
      color: 0x2a2d3a, metalness: 0.9, roughness: 0.32, normalMap: lib.brushedNormal, roughnessMap: lib.brushedRough,
    });
    const chrome = lib.chrome;
    const orangeGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff6a1a').multiplyScalar(2) });
    const redGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2a4a').multiplyScalar(2) });

    const fresh = (kind: ObstacleKind, mesh: THREE.Group, body: THREE.Group, depth: number): Obstacle => ({
      kind, cls: KIND_CLASS[kind], mesh, body, lane: 1, x: 0, dist: 0, depth, ...DIMS[KIND_CLASS[kind]],
      variant: 0, charge: 0, toLane: -1, fromX: 0, switchT: 0, phase: 0, appear: 1, destroyed: false,
      arrived: false, passed: false, inLane: false, minClear: Infinity, noScore: false, fake: false, late: false,
    });
    const group = (): [THREE.Group, THREE.Group] => {
      const g = new THREE.Group();
      const b = new THREE.Group();
      g.add(b);
      return [g, b];
    };

    // FIREWALL (variant 0) / 404 barrier (variant 1) ----------------------------------
    const BW = LW * 0.86;
    const firewallPosts = mergeGeometries([
      new THREE.BoxGeometry(0.16, 1.05, 0.2).translate(-BW / 2, 0.52, 0),
      new THREE.BoxGeometry(0.16, 1.05, 0.2).translate(BW / 2, 0.52, 0),
    ])!;
    const firewallCaps = mergeGeometries([
      new THREE.BoxGeometry(0.22, 0.1, 0.26).translate(-BW / 2, 1.07, 0),
      new THREE.BoxGeometry(0.22, 0.1, 0.26).translate(BW / 2, 1.07, 0),
      new THREE.BoxGeometry(BW, 0.05, 0.08).translate(0, 1.0, 0),
    ])!;
    const firewallBase = mergeGeometries([
      new RoundedBoxGeometry(BW + 0.3, 0.12, 0.34, 2, 0.04).translate(0, 0.06, 0),
      new THREE.CylinderGeometry(0.11, 0.13, 0.08, 20).translate(-BW / 2, 0.16, 0).toNonIndexed(),
      new THREE.CylinderGeometry(0.11, 0.13, 0.08, 20).translate(BW / 2, 0.16, 0).toNonIndexed(),
    ])!;
    const firewallNodes = mergeGeometries(
      [0.25, 0.5, 0.75].flatMap((y) => [
        new THREE.BoxGeometry(0.2, 0.025, 0.24).translate(-BW / 2, y + 0.02, 0),
        new THREE.BoxGeometry(0.2, 0.025, 0.24).translate(BW / 2, y + 0.02, 0),
      ]),
    )!;
    const hexMat = hexEnergy('#ff5a1a');
    const fwLabel = new THREE.MeshBasicMaterial({ map: textTexture('FIREWALL', '#ff8a3a'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const errLabelTex = textTexture('404 ERROR', '#ff3b5c', 512, 128, 76, '#1a0206');
    const errBar = new THREE.MeshBasicMaterial({ map: errLabelTex });
    const makeFirewall = (): Obstacle => {
      const [g, b] = group();
      const fw = new THREE.Group();
      fw.name = 'fw';
      fw.add(new THREE.Mesh(firewallPosts, metal), new THREE.Mesh(firewallCaps, orangeGlow), new THREE.Mesh(firewallBase, chrome), new THREE.Mesh(firewallNodes, orangeGlow));
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(BW, 0.95), hexMat);
      panel.position.y = 0.5;
      fw.add(panel);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.28), fwLabel);
      label.position.set(0, 1.25, 0);
      fw.add(label);
      const e404 = new THREE.Group();
      e404.name = 'e404';
      e404.add(new THREE.Mesh(firewallPosts, metal));
      const bar = new THREE.Mesh(new THREE.BoxGeometry(BW, 0.5, 0.26), [metal, metal, metal, metal, errBar, errBar]);
      bar.position.y = 0.72;
      e404.add(bar);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(BW + 0.02, 0.05, 0.28), redGlow);
      trim.position.y = 0.98;
      e404.add(trim);
      b.add(fw, e404);
      return fresh('firewall', g, b, 0.45);
    };

    // ERROR WINDOW (slide under) ----------------------------------------------------
    const WW = 2.2;
    const WH = 1.3;
    const frameGeo = mergeGeometries([
      new RoundedBoxGeometry(WW + 0.14, 0.1, 0.2, 2, 0.035).translate(0, WH / 2 + 0.02, 0),
      new RoundedBoxGeometry(WW + 0.14, 0.1, 0.2, 2, 0.035).translate(0, -WH / 2 - 0.02, 0),
      new RoundedBoxGeometry(0.1, WH + 0.1, 0.2, 2, 0.035).translate(-WW / 2 - 0.02, 0, 0),
      new RoundedBoxGeometry(0.1, WH + 0.1, 0.2, 2, 0.035).translate(WW / 2 + 0.02, 0, 0),
    ])!;
    const frameGlowGeo = mergeGeometries([
      new THREE.BoxGeometry(WW - 0.02, 0.018, 0.02).translate(0, WH / 2 - 0.035, 0.1),
      new THREE.BoxGeometry(WW - 0.02, 0.018, 0.02).translate(0, -WH / 2 + 0.035, 0.1),
      new THREE.BoxGeometry(0.018, WH - 0.07, 0.02).translate(-WW / 2 + 0.035, 0, 0.1),
      new THREE.BoxGeometry(0.018, WH - 0.07, 0.02).translate(WW / 2 - 0.035, 0, 0.1),
    ])!;
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.035, 0.05, 1.32, 12).translate(-WW / 2 - 0.02, 0.66, 0),
      new THREE.CylinderGeometry(0.035, 0.05, 1.32, 12).translate(WW / 2 + 0.02, 0.66, 0),
      new THREE.CylinderGeometry(0.12, 0.14, 0.05, 20).translate(-WW / 2 - 0.02, 0.025, 0),
      new THREE.CylinderGeometry(0.12, 0.14, 0.05, 20).translate(WW / 2 + 0.02, 0.025, 0),
    ])!;
    const poleGlowGeo = mergeGeometries([
      new THREE.BoxGeometry(0.014, 1.2, 0.014).translate(-WW / 2 - 0.02, 0.66, 0.045),
      new THREE.BoxGeometry(0.014, 1.2, 0.014).translate(WW / 2 + 0.02, 0.66, 0.045),
    ])!;
    const backGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff1030').multiplyScalar(0.9), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
    const makeErrorWindow = (): Obstacle => {
      const [g, b] = group();
      const tex = this.errorTex.clone();
      tex.needsUpdate = true;
      tex.repeat.set(0.5, 0.5);
      const face = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.25, 1.25, 1.25) });
      const win = new THREE.Group();
      win.position.y = 1.95;
      const body = new THREE.Mesh(new THREE.BoxGeometry(WW, WH, 0.12), metal);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(WW - 0.04, WH - 0.04), face);
      screen.position.z = 0.065;
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(WW + 0.9, WH + 0.8), backGlow);
      halo.position.z = -0.12;
      win.add(body, screen, new THREE.Mesh(frameGeo, chrome), new THREE.Mesh(frameGlowGeo, redGlow), halo);
      b.add(win, new THREE.Mesh(poleGeo, chrome), new THREE.Mesh(poleGlowGeo, redGlow));
      const o = fresh('errorWindow', g, b, 0.45);
      o.uniforms = { tex: { value: tex } };
      return o;
    };

    // CORRUPTED CODE BLOCK (wall) -------------------------------------------------------
    const blockGeo = new THREE.BoxGeometry(LW * 0.9, 3.4, 1).translate(0, 1.7, -0.5);
    const makeBlock = (): Obstacle => {
      const [g, b] = group();
      const mat = corruptBlockMaterial(this.glyphs, this.labels);
      const m = new THREE.Mesh(blockGeo, mat);
      m.name = 'block';
      b.add(m);
      const o = fresh('corruptBlock', g, b, 8);
      o.uniforms = mat.uniforms;
      return o;
    };

    // GLITCH BUG (low, charges) -------------------------------------------------------
    const bugShell = rimify(
      new THREE.MeshPhysicalMaterial({
        color: 0x9a0a2c, emissive: 0x2a0008, metalness: 0.55, roughness: 0.2, roughnessMap: lib.scratchRough,
        clearcoat: 1, clearcoatRoughness: 0.06, iridescence: 0.7, iridescenceIOR: 1.5, iridescenceThicknessRange: [200, 600],
      }),
      '#ff2bd6', 0.9, 2.6, false,
    );
    const bugDark = rimify(
      new THREE.MeshStandardMaterial({ color: 0x160508, metalness: 0.85, roughness: 0.3, normalMap: lib.brushedNormal }),
      '#ff2a4a', 0.6, 3, false,
    );
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffee55').multiplyScalar(2) });
    // Two-segment insect legs (femur up and out, tibia down to the floor) with joints.
    const legGeo = (side: number, set: number[]): THREE.BufferGeometry =>
      mergeGeometries(
        set.flatMap((i) => {
          const z = -0.35 + i * 0.35;
          const femur = new THREE.CapsuleGeometry(0.035, 0.34, 4, 8).rotateZ(Math.PI / 2).translate(side * 0.2, 0, 0).rotateZ(side * 0.45).translate(side * 0.38, 0.34, z);
          const knee = new THREE.SphereGeometry(0.05, 10, 8).translate(side * 0.72, 0.5, z);
          const tibia = new THREE.CapsuleGeometry(0.026, 0.42, 4, 8).translate(0, -0.21, 0).rotateZ(side * 0.35).translate(side * 0.72, 0.5, z);
          return [femur.toNonIndexed(), knee.toNonIndexed(), tibia.toNonIndexed()];
        }),
      )!;
    const legsA = mergeGeometries([legGeo(1, [0, 2]), legGeo(-1, [1])])!;
    const legsB = mergeGeometries([legGeo(-1, [0, 2]), legGeo(1, [1])])!;
    const makeGlitchBug = (): Obstacle => {
      const [g, b] = group();
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.5, 36, 24).scale(1.15, 0.7, 1.35), bugShell);
      shell.position.y = 0.48;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 1.2), eyeMat);
      stripe.position.set(0, 0.84, 0);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 28, 18).scale(1, 0.85, 1), bugDark);
      head.position.set(0, 0.45, -0.7);
      const eyes = new THREE.Mesh(
        mergeGeometries([new THREE.SphereGeometry(0.075, 16, 12).scale(1.2, 0.8, 0.7).translate(-0.13, 0.52, -0.94), new THREE.SphereGeometry(0.075, 16, 12).scale(1.2, 0.8, 0.7).translate(0.13, 0.52, -0.94)])!,
        eyeMat,
      );
      const antennae = new THREE.Mesh(
        mergeGeometries([
          new THREE.CylinderGeometry(0.008, 0.016, 0.5, 6).rotateX(0.6).rotateZ(0.4).translate(-0.18, 0.85, -0.85),
          new THREE.CylinderGeometry(0.008, 0.016, 0.5, 6).rotateX(0.6).rotateZ(-0.4).translate(0.18, 0.85, -0.85),
        ])!,
        bugDark,
      );
      const la = new THREE.Mesh(legsA, bugDark);
      const lb = new THREE.Mesh(legsB, bugDark);
      // Glitch shards orbiting the shell.
      const shards = new THREE.Mesh(
        mergeGeometries([0, 1, 2, 3, 4].map((i) => new THREE.OctahedronGeometry(0.07 + (i % 2) * 0.03, 0).scale(1, 1.8, 1).translate(Math.cos(i * 1.26) * 0.75, 0.95 + (i % 3) * 0.12, Math.sin(i * 1.26) * 0.75)))!,
        new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2bd6').multiplyScalar(1.8) }),
      );
      // Model is authored facing -z; turn it to face the player.
      const model = new THREE.Group();
      model.rotation.y = Math.PI;
      model.add(shell, stripe, head, eyes, antennae, la, lb);
      b.add(model, shards);
      const o = fresh('glitchBug', g, b, 1.3);
      o.legsA = la;
      o.legsB = lb;
      o.spin = shards;
      return o;
    };

    // MALWARE BUG (low, switches lanes) -------------------------------------------------
    const malShell = rimify(
      new THREE.MeshPhysicalMaterial({
        color: 0x4a10a0, emissive: 0x1a0040, metalness: 0.6, roughness: 0.18, roughnessMap: lib.scratchRough,
        clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 1, iridescenceIOR: 1.7, iridescenceThicknessRange: [300, 800],
      }),
      '#ff2bd6', 0.8, 2.6, false,
    );
    const warnTex = canvasTexture(256, 256, (ctx) => {
      ctx.strokeStyle = '#ff2bd6';
      ctx.fillStyle = 'rgba(255,43,214,0.25)';
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(128, 30);
      ctx.lineTo(230, 220);
      ctx.lineTo(26, 220);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ff9af0';
      ctx.font = '900 110px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('!', 128, 200);
    });
    const warnMat = new THREE.MeshBasicMaterial({ map: warnTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const makeMalware = (): Obstacle => {
      const [g, b] = group();
      const segs = new THREE.Mesh(
        mergeGeometries([0, 1, 2].map((i) => new THREE.SphereGeometry(0.36 - i * 0.04, 32, 20).scale(1, 0.8, 1.1).translate(0, 0.42, i * 0.5)))!,
        malShell,
      );
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 28, 18).scale(1, 0.85, 1), bugDark);
      head.position.set(0, 0.5, -0.45);
      const eyes = new THREE.Mesh(
        mergeGeometries([new THREE.SphereGeometry(0.08, 16, 12).translate(-0.13, 0.6, -0.72), new THREE.SphereGeometry(0.08, 16, 12).translate(0.13, 0.6, -0.72)])!,
        new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2bd6').multiplyScalar(2.2) }),
      );
      const la = new THREE.Mesh(legsA, bugDark);
      const lb = new THREE.Mesh(legsB, bugDark);
      la.position.z = lb.position.z = 0.4;
      const model = new THREE.Group();
      model.rotation.y = Math.PI;
      model.add(segs, head, eyes, la, lb);
      b.add(model);
      const marker = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4).rotateX(-Math.PI / 2), warnMat);
      marker.position.y = 0.03;
      g.add(marker);
      const o = fresh('malwareBug', g, b, 1.3);
      o.legsA = la;
      o.legsB = lb;
      o.marker = marker;
      return o;
    };

    // VIRUS DRONE (high) -------------------------------------------------------------
    const virusMat = rimify(
      new THREE.MeshPhysicalMaterial({
        color: 0x0c2410, emissive: 0xffffff, emissiveMap: veinTexture(), emissiveIntensity: 1.4, metalness: 0.35, roughness: 0.28,
        clearcoat: 1, clearcoatRoughness: 0.1,
      }),
      '#39ff6a', 1.1, 2.4, false,
    );
    const virusGeo = (() => {
      const geo = new THREE.IcosahedronGeometry(0.55, 5);
      const pos = geo.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const n = Math.sin(v.x * 11) * Math.sin(v.y * 13) * Math.sin(v.z * 9);
        v.multiplyScalar(1 + n * 0.07);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();
      return geo;
    })();
    const spikeGeo = (() => {
      const parts: THREE.BufferGeometry[] = [];
      const ico = new THREE.IcosahedronGeometry(1, 0);
      const pos = ico.getAttribute('position');
      const seen = new Set<string>();
      const up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
        const key = v.toArray().map((n) => n.toFixed(2)).join();
        if (seen.has(key)) continue;
        seen.add(key);
        const c = new THREE.ConeGeometry(0.075, 0.42, 10).translate(0, 0.66, 0);
        parts.push(new THREE.SphereGeometry(0.1, 12, 8).translate(0, 0.52, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, v)));
        c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, v));
        parts.push(c);
      }
      return mergeGeometries(parts)!;
    })();
    const makeVirus = (): Obstacle => {
      const [g, b] = group();
      const core = new THREE.Group();
      core.position.y = 2.05;
      core.scale.setScalar(0.8);
      core.add(new THREE.Mesh(virusGeo, virusMat));
      core.add(new THREE.Mesh(spikeGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2255').multiplyScalar(1.8) })));
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2255').multiplyScalar(2.5) }));
      eye.position.set(0, 0, -0.5);
      core.add(eye);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.035, 10, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color('#39ff6a').multiplyScalar(1.8) }));
      ring.rotation.x = Math.PI / 2.4;
      core.add(ring);
      // Tethers down to the ground so the player reads the danger zone.
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.4, 6).translate(0, 0.7, 0), redGlow);
      b.add(core, beam);
      const o = fresh('virusDrone', g, b, 1.2);
      o.spin = core;
      return o;
    };

    // CORRUPT PACKET (boss drop, low) ---------------------------------------------------
    const packetMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2a4a').multiplyScalar(1.6) });
    const packetDark = rimify(
      new THREE.MeshStandardMaterial({ color: 0x2a0610, metalness: 0.85, roughness: 0.25, roughnessMap: lib.scratchRough, normalMap: lib.brushedNormal }),
      '#ff2a4a', 1.0, 2.5, false,
    );
    const packetGeo = mergeGeometries([
      new RoundedBoxGeometry(0.8, 0.8, 0.8, 2, 0.05).translate(-0.35, 0.4, 0),
      new RoundedBoxGeometry(0.55, 0.55, 0.55, 2, 0.04).translate(0.45, 0.28, 0.1).rotateY(0.3),
      new RoundedBoxGeometry(0.4, 0.4, 0.4, 2, 0.03).translate(0.1, 0.72, -0.1),
    ])!;
    const makePacket = (): Obstacle => {
      const [g, b] = group();
      b.add(new THREE.Mesh(packetGeo, packetDark));
      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(packetGeo, 40), new THREE.LineBasicMaterial({ color: packetMat.color }));
      b.add(wire);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 32).rotateX(-Math.PI / 2), packetMat);
      ring.position.y = 0.03;
      g.add(ring);
      const o = fresh('packet', g, b, 0.9);
      o.marker = ring;
      return o;
    };

    // SCAN LASER (boss attack, high: slide under) -------------------------------------
    // Two emitter posts and a humming beam at head height across the lane.
    const beamVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
    const postGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.09, 0.14, 2.05, 10).translate(0, 1.02, 0),
      new THREE.CylinderGeometry(0.2, 0.24, 0.12, 12).translate(0, 0.06, 0),
      new THREE.CylinderGeometry(0.19, 0.19, 0.44, 8).translate(0, 1.78, 0),
    ])!;
    const laserPost = rimify(
      new THREE.MeshStandardMaterial({ color: 0x1c1f2a, metalness: 0.9, roughness: 0.28, normalMap: lib.brushedNormal, roughnessMap: lib.brushedRough }),
      '#ff2a4a', 0.8, 2.5, false,
    );
    const makeLaser = (): Obstacle => {
      const [g, b] = group();
      const uniforms = { uColor: { value: new THREE.Color('#ff2a4a') }, uTime: THEME.uTime, uAppear: { value: 1 } };
      const beamMat = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        vertexShader: beamVert,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uTime; uniform float uAppear;
          varying vec2 vUv;
          void main() {
            float r = abs(vUv.y - 0.5) * 2.0;
            float core = smoothstep(0.22, 0.0, r);
            float glow = pow(1.0 - r, 3.0);
            float hum = 0.82 + 0.18 * sin(uTime * 60.0 + vUv.x * 40.0) * sin(uTime * 23.0);
            float crawl = 0.5 + 0.5 * sin(vUv.x * 26.0 - uTime * 30.0);
            vec3 c = uColor * glow * (1.3 + crawl * 0.6) + vec3(1.0) * core * 1.4;
            gl_FragColor = vec4(c * hum * uAppear, 1.0);
          }`,
      });
      const BL = LW * 0.94;
      const beam = new THREE.Mesh(new THREE.PlaneGeometry(BL, 0.42), beamMat);
      beam.position.y = 1.78;
      const beam2 = beam.clone();
      beam2.rotation.x = Math.PI / 2;
      const capMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2a4a').multiplyScalar(2.2) });
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, laserPost);
        post.position.x = side * BL * 0.5;
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), capMat);
        cap.position.set(side * (BL * 0.5 - 0.18), 1.78, 0);
        b.add(post, cap);
      }
      b.add(beam, beam2);
      const o = fresh('laser', g, b, 0.5);
      o.uniforms = uniforms;
      (o as Obstacle & { cap?: THREE.MeshBasicMaterial }).cap = capMat;
      return o;
    };

    // SHOCKWAVE (boss attack, low: jump) -------------------------------------------------
    // A rolling wall of energy across the lane, bulging toward the runner.
    const shockGeo = new THREE.CylinderGeometry(7, 7, 0.9, 28, 1, true, Math.PI - (LW * 0.94) / 14, (LW * 0.94) / 7).translate(0, 0.45, 7);
    const makeShock = (): Obstacle => {
      const [g, b] = group();
      const uniforms = { uColor: { value: new THREE.Color('#ffd23a') }, uTime: THEME.uTime, uAppear: { value: 1 } };
      const mat = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        vertexShader: beamVert,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uTime; uniform float uAppear;
          varying vec2 vUv;
          ${GLSL_HASH}
          void main() {
            float y = vUv.y;
            float edge = smoothstep(0.78, 0.97, y) * smoothstep(1.0, 0.97, y);
            float body = pow(1.0 - y, 1.6);
            float arcs = smoothstep(0.55, 1.0, vnoise(vec2(vUv.x * 18.0, y * 3.0 - uTime * 6.0)));
            float scan = 0.6 + 0.4 * sin(vUv.x * 60.0 + uTime * 25.0);
            vec3 c = uColor * (body * 1.1 + arcs * 0.9 * (1.0 - y)) * scan + vec3(1.0) * edge * 1.6;
            gl_FragColor = vec4(c * uAppear, 1.0);
          }`,
      });
      const wave = new THREE.Mesh(shockGeo, mat);
      b.add(wave);
      const floorMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd23a').multiplyScalar(1.4), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(LW * 0.94, 0.5).rotateX(-Math.PI / 2), floorMat);
      floor.position.set(0, 0.02, 0.1);
      b.add(floor);
      const o = fresh('shock', g, b, 0.6);
      o.uniforms = uniforms;
      (o as Obstacle & { cap?: THREE.MeshBasicMaterial }).cap = floorMat;
      return o;
    };

    const onAcquire = (o: Obstacle): void => {
      o.mesh.visible = true;
    };
    const onRelease = (o: Obstacle): void => {
      o.mesh.visible = false;
    };
    const add = (factory: () => Obstacle) => (): Obstacle => {
      const o = factory();
      o.mesh.traverse((c) => {
        c.frustumCulled = false;
        const m = c as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        m.castShadow = !mat.transparent && !(mat as THREE.MeshBasicMaterial).isMeshBasicMaterial;
      });
      this.scene.add(o.mesh);
      return o;
    };

    this.pools = {
      firewall: new Pool(add(makeFirewall), onAcquire, onRelease, 10),
      errorWindow: new Pool(add(makeErrorWindow), onAcquire, onRelease, 8),
      corruptBlock: new Pool(add(makeBlock), onAcquire, onRelease, 10),
      glitchBug: new Pool(add(makeGlitchBug), onAcquire, onRelease, 6),
      virusDrone: new Pool(add(makeVirus), onAcquire, onRelease, 6),
      malwareBug: new Pool(add(makeMalware), onAcquire, onRelease, 4),
      packet: new Pool(add(makePacket), onAcquire, onRelease, 6),
      laser: new Pool(add(makeLaser), onAcquire, onRelease, 9),
      shock: new Pool(add(makeShock), onAcquire, onRelease, 9),
    };
  }

  spawn(kind: ObstacleKind, lane: number, dist: number, opts: SpawnOpts = {}): Obstacle {
    const o = this.pools[kind].acquire();
    o.lane = lane;
    o.x = o.fromX = LANE_X[lane];
    o.dist = dist;
    o.arrived = o.passed = o.inLane = o.noScore = o.late = o.destroyed = false;
    o.minClear = Infinity;
    o.fake = !!opts.fake;
    if (o.fake) o.noScore = true;
    o.variant = opts.variant ?? 0;
    o.toLane = opts.toLane ?? -1;
    o.switchT = 0;
    o.charge = 0;
    o.phase = Math.random() * 10;
    o.appear = opts.materialize ? 0 : 1;
    o.body.visible = true;
    o.body.scale.set(1, 1, 1);
    o.body.position.set(0, 0, 0);
    if (kind === 'corruptBlock') {
      o.depth = opts.depth ?? 8;
      o.body.getObjectByName('block')!.scale.z = o.depth;
      o.uniforms!.uDepth.value = o.depth;
      o.uniforms!.uVariant.value = o.variant % 4;
    }
    if (kind === 'firewall') {
      o.body.getObjectByName('fw')!.visible = o.variant === 0;
      o.body.getObjectByName('e404')!.visible = o.variant !== 0;
    }
    if (kind === 'errorWindow') {
      const t = o.uniforms!.tex.value as THREE.Texture;
      t.offset.set((o.variant % 2) * 0.5, 0.5 - Math.floor((o.variant % 4) / 2) * 0.5);
    }
    if (o.marker) o.marker.visible = kind === 'packet' || o.toLane >= 0;
    if ((kind === 'laser' || kind === 'shock') && o.uniforms) {
      const c = new THREE.Color(opts.color ?? (kind === 'laser' ? '#ff2a4a' : '#ffd23a'));
      (o.uniforms.uColor.value as THREE.Color).copy(c);
      (o as Obstacle & { cap?: THREE.MeshBasicMaterial }).cap?.color.copy(c).multiplyScalar(2);
    }
    if (opts.materialize) this.onMaterialize(o);
    return o;
  }

  /** Knock an obstacle out of the world (hit, deleted, fixed). */
  destroy(o: Obstacle): void {
    o.destroyed = true;
    o.body.visible = false;
    if (o.marker) o.marker.visible = false;
  }

  /** Move, animate and recycle. */
  update(distance: number, dt: number, time: number): void {
    for (const kind of KINDS) {
      const pool = this.pools[kind];
      for (let i = pool.active.length - 1; i >= 0; i--) {
        const o = pool.active[i];
        let zFront = -(o.dist - distance);
        if (zFront - o.depth > CONFIG.spawn.despawnBehind) {
          pool.releaseAt(i);
          continue;
        }
        const ahead = -zFront;
        if (!o.destroyed) this.behave(o, ahead, dt, time);
        if (o.fake && !o.destroyed) o.body.visible = Math.sin(time * 38 + o.phase * 7) > -0.55;
        zFront = -(o.dist - distance);
        if (o.appear < 1) {
          o.appear = Math.min(1, o.appear + dt * 3.2);
          const e = 1 - Math.pow(1 - o.appear, 3);
          o.body.scale.set(1, Math.max(0.01, e), 1);
          if (kind === 'packet') o.body.position.y = (1 - e) * 7;
        }
        if (o.uniforms?.uAppear) o.uniforms.uAppear.value = o.appear;
        o.mesh.position.set(o.x, 0, o.cls === 'wall' ? zFront : zFront - o.depth / 2);
      }
    }
  }

  private behave(o: Obstacle, ahead: number, dt: number, time: number): void {
    const t = time + o.phase;
    switch (o.kind) {
      case 'glitchBug': {
        // Charges once close: closes the gap faster than the scrolling world.
        if (ahead < 36 && ahead > 1) o.charge = Math.min(5, o.charge + dt * 10);
        o.dist -= o.charge * dt;
        const run = o.charge > 0 ? 18 : 6;
        o.legsA!.rotation.x = Math.sin(t * run) * 0.5;
        o.legsB!.rotation.x = -Math.sin(t * run) * 0.5;
        o.spin!.rotation.y = t * 3;
        // Glitch jitter.
        const g = Math.sin(t * 37) > 0.93 ? 0.12 : 0;
        o.body.position.x = g * Math.sign(Math.sin(t * 13));
        o.body.position.y = Math.abs(Math.sin(t * run)) * 0.04;
        break;
      }
      case 'malwareBug': {
        o.legsA!.rotation.x = Math.sin(t * 16) * 0.5;
        o.legsB!.rotation.x = -Math.sin(t * 16) * 0.5;
        if (o.toLane >= 0) {
          const tx = LANE_X[o.toLane];
          if (o.marker) o.marker.position.x = tx - o.x;
          if (ahead < 58 && o.switchT < 1) {
            o.switchT = Math.min(1, o.switchT + dt / 0.55);
            const e = o.switchT * o.switchT * (3 - 2 * o.switchT);
            o.x = o.fromX + (tx - o.fromX) * e;
            o.body.rotation.y = Math.sin(o.switchT * Math.PI) * Math.sign(tx - o.fromX) * -0.8;
            o.body.position.y = Math.sin(o.switchT * Math.PI) * 0.6;
            if (o.switchT >= 1) {
              o.lane = o.toLane;
              o.toLane = -1;
              if (o.marker) o.marker.visible = false;
            }
          }
        }
        break;
      }
      case 'virusDrone': {
        o.spin!.rotation.y = t * 1.6;
        o.spin!.rotation.z = Math.sin(t * 1.3) * 0.2;
        o.spin!.position.y = 2.05 + Math.sin(t * 3) * 0.08;
        break;
      }
      case 'errorWindow': {
        o.body.position.y = Math.sin(t * 2) * 0.04;
        o.body.rotation.z = Math.sin(t * 1.4) * 0.02;
        break;
      }
      case 'packet': {
        o.body.rotation.y = t * 1.5;
        break;
      }
      case 'shock': {
        // A rolling wave: it closes in a little faster than the world scrolls.
        if (ahead < 40 && ahead > 0) o.dist -= 3 * dt;
        o.body.scale.y = 0.9 + Math.sin(t * 18) * 0.1;
        break;
      }
      default:
        break;
    }
  }

  forEach(fn: (o: Obstacle) => void): void {
    for (const kind of KINDS) for (const o of this.pools[kind].active) fn(o);
  }

  getCollider(o: Obstacle, distance: number, out: AABB): AABB {
    const zFront = -(o.dist - distance);
    out.minX = o.x - o.width / 2;
    out.maxX = o.x + o.width / 2;
    out.minY = o.minY;
    out.maxY = o.maxY;
    out.maxZ = zFront;
    out.minZ = zFront - o.depth;
    return out;
  }

  clear(): void {
    for (const kind of KINDS) this.pools[kind].releaseAll();
  }

  get activeCount(): number {
    return KINDS.reduce((n, k) => n + this.pools[k].active.length, 0);
  }
}

const KINDS: readonly ObstacleKind[] = ['firewall', 'errorWindow', 'corruptBlock', 'glitchBug', 'virusDrone', 'malwareBug', 'packet', 'laser', 'shock'];
