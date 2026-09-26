import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLSL_HASH, GLSL_THEME_UNIFORMS, THEME, stageAt } from '../core/Theme';
import { Random } from '../utils/Random';
import type { MaterialLib } from '../render/MaterialLib';
import type { QualitySettings } from '../render/Quality';
import { KEY_LABELS, glyphAtlas, keyAtlas, panelAtlas } from './Atlases';
import { ROAD_WIDTH, worldMaterial } from './Track';
import type { ThemeLinks } from './ThemeLinks';

export { glyphAtlas } from './Atlases';

/**
 * The inside of a giant computer. Everything is instanced (one draw call per
 * kind of thing, however much is on screen) and lit with PBR materials so
 * metal, glass and circuitry pick up the neon environment and fog.
 *
 * Near the streams: themed districts (server rooms, RAM banks, chip boards,
 * keyboards, storage, THE CORE). Around them: mega-towers, giant cooling fans
 * with light shafts, fibre-optic cables overhead, server-room bridges,
 * digital tunnels, holo windows, falling code and drifting dust.
 */

const ROAD_HALF = ROAD_WIDTH / 2;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const AHEAD = 260;
const BEHIND = 26;

const Style = { Rack: 0, Ram: 1, Chip: 2, Storage: 3, Core: 4, Tower: 5 } as const;
type Style = (typeof Style)[keyof typeof Style];

type District = 'server' | 'ram' | 'board' | 'keyboard' | 'storage' | 'core';

interface Item {
  dist: number;
  len: number;
}
interface Box extends Item {
  x: number;
  y: number;
  w: number;
  h: number;
  style: Style;
  seed: number;
  accent: number;
}
interface Key extends Item {
  x: number;
  w: number;
  cell: number;
  tilt: number;
}
interface Panel extends Item {
  x: number;
  y: number;
  w: number;
  h: number;
  yaw: number;
  cell: number;
  phase: number;
}
interface Simple extends Item {
  x: number;
  y: number;
  s: number;
  h: number;
  phase: number;
  side: number;
}

// ---------------------------------------------------------- PBR components

/**
 * MeshStandardMaterial extended with per-instance procedural surfaces:
 * albedo, roughness, metalness and emissive patterns are generated in the
 * shader from each instance's real size, so nothing stretches.
 */
function componentMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.8, roughness: 0.4 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, THEME);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aStyle;
        attribute float aSeed;
        attribute float aAccent;
        varying vec3 vLocalC;
        varying vec3 vNormalC;
        flat varying float vStyleC;
        flat varying float vSeedC;
        flat varying float vAccentC;
        flat varying vec3 vScaleC;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 scC = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vScaleC = scC;
        vLocalC = position * scC;
        vNormalC = normal;
        vStyleC = aStyle;
        vSeedC = aSeed;
        vAccentC = aAccent;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${GLSL_THEME_UNIFORMS}
        varying vec3 vLocalC;
        varying vec3 vNormalC;
        flat varying float vStyleC;
        flat varying float vSeedC;
        flat varying float vAccentC;
        flat varying vec3 vScaleC;
        ${GLSL_HASH}
        float box2(vec2 p, vec2 lo, vec2 hi) { return step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.y) * step(p.y, hi.y); }
        vec3 cAlb; vec3 cEmi; float cRough; float cMetal;
        void compStyle() {
          vec3 n = normalize(vNormalC);
          float isTop = step(0.5, n.y);
          bool sideX = abs(n.x) > 0.5;
          vec3 lc = vLocalC + vec3(0.0, 0.0, vScaleC.z * 0.5);
          vec2 uv = sideX ? vLocalC.zy : vLocalC.xy;
          float h = vLocalC.y;
          vec3 acc = mix(uPrimary, uSecondary, vAccentC);
          float fw = max(fwidth(uv.x), fwidth(uv.y));
          float detail = 1.0 - smoothstep(0.05, 0.16, fw);
          float beat = uBeat * 0.6;
          cAlb = vec3(0.05); cEmi = vec3(0.0); cRough = 0.4; cMetal = 0.85;
          if (vStyleC < 0.5) {
            // SERVER RACK: brushed dark metal units, perforated doors, status LEDs.
            float unit = fract(h / 0.62);
            float seam = 1.0 - step(0.06, unit);
            cAlb = vec3(0.045, 0.05, 0.062) * (1.0 - seam * 0.6);
            cRough = 0.38 + 0.15 * vnoise(vec2(uv.x * 30.0, h * 2.0));
            vec2 g = vec2(uv.x / 0.34, h / 0.62);
            vec2 id = floor(g);
            vec2 f = fract(g);
            float perf = step(0.5, fract(uv.x * 8.0)) * step(0.5, fract(h * 8.0)) * box2(fract(vec2(uv.x / 3.2, h / 0.62)), vec2(0.35, 0.18), vec2(0.95, 0.85));
            cAlb *= 1.0 - perf * 0.6 * detail;
            float led = smoothstep(0.16, 0.08, length(f - vec2(0.5, 0.55))) * step(0.5, hash12(id + vSeedC)) * box2(fract(vec2(uv.x / 3.2, 0.0)), vec2(0.0, -1.0), vec2(0.3, 1.0));
            float blink = step(0.35, hash12(id + floor(uTime * (1.0 + hash12(id) * 5.0))));
            vec3 lcol = mix(acc, vec3(1.0, 0.75, 0.25), step(0.9, hash12(id * 1.3 + vSeedC)));
            cEmi += led * blink * lcol * 2.2 * detail * (1.0 - isTop);
            cEmi += (1.0 - detail) * acc * 0.05 * (1.0 - isTop);
            // Vertical light bar down each rack face.
            float bar = smoothstep(0.05, 0.0, abs(fract(uv.x / 3.2) - 0.02)) * (1.0 - isTop);
            cEmi += bar * acc * (0.8 + beat);
          } else if (vStyleC < 1.5) {
            // RAM MODULE: glossy PCB, memory chips, gold contacts, heat-spreader.
            float hy = h / max(vScaleC.y, 0.001);
            cAlb = vec3(0.01, 0.06, 0.05);
            cRough = 0.25; cMetal = 0.1;
            float cx = fract(uv.x / 2.2);
            float chip = step(0.12, cx) * step(cx, 0.88) * step(0.25, hy) * step(hy, 0.8);
            cAlb = mix(cAlb, vec3(0.02), chip);
            cRough = mix(cRough, 0.5, chip);
            cEmi += chip * smoothstep(0.02, 0.0, abs(hy - 0.72)) * acc * 0.6;
            float pins = step(hy, 0.12) * step(0.5, fract(uv.x * 3.0));
            cAlb = mix(cAlb, vec3(1.0, 0.72, 0.3), pins * (1.0 - isTop));
            cMetal = mix(cMetal, 1.0, pins);
            cRough = mix(cRough, 0.18, pins);
            float spreader = step(0.82, hy) * (1.0 - isTop);
            cAlb = mix(cAlb, vec3(0.08, 0.09, 0.11), spreader);
            cMetal = mix(cMetal, 0.9, spreader);
            cEmi += smoothstep(vScaleC.y - 0.2, vScaleC.y - 0.05, h) * acc * (1.6 + beat) * (1.0 - isTop);
            float trace = smoothstep(0.03, 0.0, abs(fract(h * 1.3 + hash12(vec2(floor(uv.x), vSeedC))) - 0.5)) * (1.0 - chip) * (1.0 - pins);
            float pulse = smoothstep(0.1, 0.0, abs(fract(uv.x * 0.05 - uTime * 0.5 + vSeedC) - 0.5));
            cEmi += trace * acc * (0.08 + pulse * 0.8) * detail;
          } else if (vStyleC < 2.5) {
            // CHIP: ceramic package, machined legs, glowing die.
            cAlb = vec3(0.025, 0.027, 0.032);
            cRough = 0.55; cMetal = 0.2;
            float legs = step(h, 0.45) * step(0.5, fract(uv.x * 2.2)) * (1.0 - isTop);
            cAlb = mix(cAlb, vec3(0.75, 0.78, 0.82), legs);
            cMetal = mix(cMetal, 1.0, legs);
            cRough = mix(cRough, 0.2, legs);
            vec2 tp = lc.xz / (vScaleC.xz * 0.5);
            float bx = max(abs(tp.x), abs(tp.y));
            float die = step(bx, 0.42);
            float grid = step(0.88, fract(lc.x * 1.6)) + step(0.88, fract(lc.z * 1.6));
            float pulse = 0.55 + 0.45 * sin(uTime * 2.0 + vSeedC * 6.0);
            cAlb = mix(cAlb, vec3(0.1, 0.11, 0.13), isTop * die);
            cMetal = mix(cMetal, 0.9, isTop * die);
            cRough = mix(cRough, 0.15, isTop * die);
            cEmi += isTop * die * acc * (0.1 + 0.25 * pulse + grid * 0.3 + beat * 0.5);
            cEmi += isTop * smoothstep(0.9, 0.96, bx) * acc * 1.0;
          } else if (vStyleC < 3.5) {
            // STORAGE: brushed gunmetal drive sleds with activity lights.
            cAlb = vec3(0.16, 0.17, 0.2);
            cRough = 0.3 + 0.2 * vnoise(vec2(uv.x * 60.0, h * 1.5));
            cMetal = 0.95;
            cAlb *= 0.7 + 0.3 * step(0.06, fract(h / 1.6));
            vec2 lp = vec2(fract(uv.x / 5.0), fract(h / 1.6));
            float label = box2(lp, vec2(0.1, 0.25), vec2(0.55, 0.75));
            cAlb = mix(cAlb, vec3(0.02), label);
            cRough = mix(cRough, 0.6, label);
            cEmi += label * step(0.93, fract(lp.x * 12.0)) * acc * 0.25;
            float ledOn = step(0.4, hash12(vec2(floor(uv.x / 5.0), floor(h / 1.6)) + floor(uTime * 7.0)));
            float led = smoothstep(0.05, 0.02, length((lp - vec2(0.85, 0.5)) * vec2(5.0, 1.6)));
            cEmi += led * ledOn * acc * 2.4 * (1.0 - isTop);
          } else if (vStyleC < 4.5) {
            // CORE PROCESSOR / PILLAR: dark alloy with energy rising through it.
            cAlb = vec3(0.03, 0.035, 0.05);
            cRough = 0.2; cMetal = 0.95;
            float band = fract(h * 0.12 - uTime * 0.6 + vSeedC);
            cEmi += smoothstep(0.05, 0.0, abs(band - 0.5)) * mix(uPrimary, vec3(1.0), 0.2) * (1.1 + beat * 2.0);
            cEmi += smoothstep(0.025, 0.0, abs(fract(uv.x * 0.2) - 0.5)) * uSecondary * 0.35;
            cEmi += isTop * uSecondary * 0.35;
          } else {
            // MEGA TOWER: distant stacked servers; windows of light fade to a glow far away.
            cAlb = vec3(0.02, 0.025, 0.035);
            cRough = 0.3; cMetal = 0.9;
            vec2 g = vec2(uv.x / 1.4, h / 1.1);
            vec2 id = floor(g);
            vec2 f = fract(g);
            float win = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.7) * step(0.62, hash12(id + vSeedC));
            float on = step(0.12, hash12(id + floor(uTime * 0.3 + hash12(id) * 7.0)));
            cEmi += win * on * acc * 0.9 * detail;
            cEmi += (1.0 - detail) * acc * 0.06;
            cEmi += smoothstep(vScaleC.y - 1.2, vScaleC.y, h) * acc * 1.2 * (1.0 - isTop);
          }
          // Glowing vertical edges on some pieces.
          float ex = sideX ? abs(lc.z) / (vScaleC.z * 0.5) : abs(lc.x) / (vScaleC.x * 0.5);
          cEmi += smoothstep(0.975, 0.995, ex) * (1.0 - isTop) * acc * 0.9 * step(0.5, hash12(vec2(vSeedC, 2.0)));
          // Contact shadow / ambient occlusion at the base.
          float ao = mix(0.35, 1.0, smoothstep(0.0, 1.6, h));
          cAlb *= ao;
          // Corruption: red rot creeping over components.
          float cn = vnoise(vec2(uv.x * 0.4 + vSeedC * 13.0, h * 0.3));
          float cm = smoothstep(1.0 - uCorrupt * 0.75, 1.06 - uCorrupt * 0.75, cn) * step(0.01, uCorrupt);
          float gl = step(0.55, hash12(vec2(floor(h * 3.0), floor(uTime * 10.0) + vSeedC)));
          cAlb = mix(cAlb, vec3(0.15, 0.0, 0.02), cm);
          cEmi = mix(cEmi, vec3(1.0, 0.08, 0.2) * (0.4 + gl * 0.8), cm * 0.8);
          cRough = mix(cRough, 0.8, cm);
        }`,
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\n compStyle();\n diffuseColor.rgb = cAlb;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = cRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = cMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += cEmi;');
  };
  mat.customProgramCacheKey = () => 'component-pbr';
  return mat;
}

/** Soft additive light shaft (fake volumetric lighting). */
function shaftMaterial(color: 'primary' | 'secondary' | 'white', strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { ...THEME, uStrength: { value: strength }, uWhich: { value: color === 'primary' ? 0 : color === 'secondary' ? 1 : 2 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${GLSL_THEME_UNIFORMS}
      uniform float uStrength;
      uniform float uWhich;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vView;
      ${GLSL_HASH}
      void main() {
        // uv.y runs along the shaft (1 = source). Soft edges via view angle.
        float along = pow(vUv.y, 1.6);
        float edge = pow(abs(dot(normalize(vN), vView)), 1.5);
        float n = 0.65 + 0.35 * vnoise(vec2(vUv.x * 12.0, vUv.y * 3.0 - uTime * 0.4));
        vec3 c = uWhich < 0.5 ? uPrimary : uWhich < 1.5 ? uSecondary : vec3(0.8, 0.9, 1.0);
        float a = along * edge * n * uStrength * (1.0 + uBeat * 0.35);
        gl_FragColor = vec4(c * a, 1.0);
      }`,
  });
}

// ------------------------------------------------------------------ world

interface Batch<T extends Item> {
  items: T[];
  mesh: THREE.InstancedMesh;
  max: number;
  extra?: THREE.InstancedMesh[];
}

export class ComputerWorld {
  private readonly rng = new Random(4242);
  private readonly q: QualitySettings;
  private readonly boxes: Batch<Box>;
  private readonly heatsinks: Batch<Simple>;
  private readonly caps: Batch<Simple>;
  private readonly keys: Batch<Key>;
  private readonly panels: Batch<Panel>;
  private readonly rain: Batch<Simple>;
  private readonly rings: Batch<Simple>;
  private readonly pillars: Batch<Simple>;
  private readonly fans: Batch<Simple>;
  private readonly cables: Batch<Simple>;
  private readonly bridges: Batch<Simple>;
  private readonly tunnel: Batch<Simple>;
  private readonly shafts: Batch<Simple>;

  private readonly aStyle: THREE.InstancedBufferAttribute;
  private readonly aSeed: THREE.InstancedBufferAttribute;
  private readonly aAccent: THREE.InstancedBufferAttribute;
  private readonly pillarSeed: THREE.InstancedBufferAttribute;
  private readonly keyCell: THREE.InstancedBufferAttribute;
  private readonly keyPhase: THREE.InstancedBufferAttribute;
  private readonly panelCell: THREE.InstancedBufferAttribute;
  private readonly panelPhase: THREE.InstancedBufferAttribute;
  private readonly rainPhase: THREE.InstancedBufferAttribute;
  private readonly cablePhase: THREE.InstancedBufferAttribute;

  private cursorNear: [number, number] = [0, 0];
  private cursorFar: [number, number] = [0, 0];
  private cursorMega: [number, number] = [0, 0];
  private cursorFloat = 0;
  private ringCursor = 0;
  private cableCursor = 0;
  private bridgeCursor = 0;
  private tunnelAt = 0;
  private tunnelEnd = -1;
  private tunnelCursor = 0;
  private districtEnd: [number, number] = [0, 0];
  private district: [District, District] = ['server', 'board'];
  private time = 0;

  private readonly m = new THREE.Matrix4();
  private readonly qt = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly spinQ = new THREE.Quaternion();

  private sky!: THREE.Mesh;
  private coreBackdrop!: THREE.Mesh;
  private bits!: THREE.Points;
  private dust?: THREE.Points;

  constructor(scene: THREE.Scene, links: ThemeLinks, lib: MaterialLib, quality: QualitySettings) {
    this.q = quality;
    const D = quality.detail;
    const mk = <T extends Item>(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], max: number, order = 0): Batch<T> => {
      const mesh = new THREE.InstancedMesh(geo, mat, max);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.renderOrder = order;
      scene.add(mesh);
      return { items: [], mesh, max };
    };
    const twin = (geo: THREE.BufferGeometry, mat: THREE.Material, max: number): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geo, mat, max);
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      scene.add(m);
      return m;
    };
    const attr = (geo: THREE.BufferGeometry, name: string, max: number, size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    const n = (base: number): number => Math.round(base * Math.max(0.6, D));

    // Components (PBR) -------------------------------------------------------
    const compMat = componentMaterial();
    const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, -0.5);
    const MAXB = n(320);
    this.aStyle = attr(boxGeo, 'aStyle', MAXB, 1);
    this.aSeed = attr(boxGeo, 'aSeed', MAXB, 1);
    this.aAccent = attr(boxGeo, 'aAccent', MAXB, 1);
    this.boxes = mk<Box>(boxGeo, compMat, MAXB);

    const pillarGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1, true).translate(0, 0.5, -0.5);
    attr(pillarGeo, 'aStyle', 40, 1).array.fill(4);
    this.pillarSeed = attr(pillarGeo, 'aSeed', 40, 1);
    attr(pillarGeo, 'aAccent', 40, 1);
    this.pillars = mk(pillarGeo, compMat, 40);

    // Heat sinks: machined fins.
    const fins: THREE.BufferGeometry[] = [new THREE.BoxGeometry(1, 0.12, 1).translate(0, 0.06, 0)];
    for (let i = 0; i < 11; i++) fins.push(new THREE.BoxGeometry(0.04, 0.85, 1).translate(-0.45 + i * 0.09, 0.54, 0));
    for (let i = 0; i < 3; i++) fins.push(new THREE.CylinderGeometry(0.04, 0.04, 1.05, 8).rotateX(Math.PI / 2).translate(-0.3 + i * 0.3, 0.35, 0));
    this.heatsinks = mk(mergeGeometries(fins)!, lib.gunmetal, n(60));

    // Capacitors: brushed aluminium cans with a glowing vent cross.
    const capBody = mergeGeometries([
      new THREE.CylinderGeometry(0.5, 0.5, 0.96, 24).translate(0, 0.48, 0),
      new THREE.CylinderGeometry(0.46, 0.5, 0.04, 24).translate(0, 0.98, 0),
    ])!;
    this.caps = mk(capBody, lib.gunmetal, n(100));
    const capTop = mergeGeometries([
      new THREE.BoxGeometry(0.7, 0.02, 0.06).translate(0, 1.005, 0),
      new THREE.BoxGeometry(0.06, 0.02, 0.7).translate(0, 1.005, 0),
      new THREE.TorusGeometry(0.47, 0.025, 6, 24).rotateX(Math.PI / 2).translate(0, 0.9, 0),
    ])!;
    this.caps.extra = [twin(capTop, links.basic('secondary', 1.3), n(100))];

    // Keyboard keys: carbon keycaps with glowing legends.
    const keyGeo = new RoundedBoxGeometry(1, 1, 1, 3, 0.14).translate(0, 0.5, 0);
    this.keys = mk(keyGeo, lib.carbon, n(150));
    const keyTopGeo = new THREE.PlaneGeometry(0.8, 0.8).rotateX(-Math.PI / 2).translate(0, 1.004, 0);
    this.keyCell = attr(keyTopGeo, 'aCell', n(150), 2);
    this.keyPhase = attr(keyTopGeo, 'aPhase', n(150), 1);
    const keyMat = worldMaterial(KEY_FRAG, { uMap: { value: keyAtlas() }, uCellSize: { value: new THREE.Vector2(0.25, 0.25) } }, INST_VERT);
    keyMat.transparent = true;
    keyMat.depthWrite = false;
    keyMat.blending = THREE.AdditiveBlending;
    this.keys.extra = [twin(keyTopGeo, keyMat, n(150))];

    // Holographic windows ---------------------------------------------------------
    const panelGeo = new THREE.PlaneGeometry(1, 1);
    this.panelCell = attr(panelGeo, 'aCell', 110, 2);
    this.panelPhase = attr(panelGeo, 'aPhase', 110, 1);
    const panelMat = worldMaterial(PANEL_FRAG, { uMap: { value: panelAtlas() }, uCellSize: { value: new THREE.Vector2(0.25, 0.25) } }, INST_VERT);
    panelMat.transparent = true;
    panelMat.depthWrite = false;
    panelMat.side = THREE.DoubleSide;
    panelMat.blending = THREE.CustomBlending;
    panelMat.blendSrc = THREE.OneFactor;
    panelMat.blendDst = THREE.OneMinusSrcAlphaFactor;
    this.panels = mk(panelGeo, panelMat, 110, 3);
    // Glass frames behind the holo windows.
    const frameGeo = mergeGeometries([
      new THREE.BoxGeometry(1.04, 0.025, 0.03).translate(0, 0.5, -0.02),
      new THREE.BoxGeometry(1.04, 0.025, 0.03).translate(0, -0.5, -0.02),
      new THREE.BoxGeometry(0.025, 1.0, 0.03).translate(0.51, 0, -0.02),
      new THREE.BoxGeometry(0.025, 1.0, 0.03).translate(-0.51, 0, -0.02),
    ])!;
    this.panels.extra = [twin(frameGeo, links.basic('primary', 1.2), 110)];

    // Code rain columns.
    const rainGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    attr(rainGeo, 'aCell', 70, 2);
    this.rainPhase = attr(rainGeo, 'aPhase', 70, 1);
    const rainMat = worldMaterial(RAIN_FRAG, { uGlyphs: { value: glyphAtlas() }, uCellSize: { value: new THREE.Vector2(1, 1) } }, INST_VERT);
    rainMat.transparent = true;
    rainMat.depthWrite = false;
    rainMat.blending = THREE.AdditiveBlending;
    rainMat.side = THREE.DoubleSide;
    this.rain = mk(rainGeo, rainMat, 70, 2);

    // Network gateway rings.
    const ringGeo = new THREE.TorusGeometry(6.6, 0.2, 10, 72);
    const ringMat = worldMaterial(RING_FRAG, {}, RING_VERT);
    this.rings = mk(ringGeo, ringMat, 8);
    const ringFrame = mergeGeometries([
      new THREE.TorusGeometry(6.95, 0.42, 8, 72),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.BoxGeometry(0.9, 1.6, 0.9).translate(Math.cos((i / 8) * Math.PI * 2) * 7.1, Math.sin((i / 8) * Math.PI * 2) * 7.1, 0)),
    ])!;
    this.rings.extra = [twin(ringFrame, lib.darkMetal, 8)];

    // Giant cooling fans: frame + guard + rotating blades --------------------------------
    const bladeParts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.22, 0.22, 0.25, 24).rotateX(Math.PI / 2)];
    for (let i = 0; i < 9; i++) {
      const b = new THREE.BoxGeometry(0.2, 0.86, 0.03).translate(0, 0.62, 0);
      b.rotateY(0.45);
      b.rotateZ((i / 9) * Math.PI * 2);
      bladeParts.push(b);
    }
    this.fans = mk(mergeGeometries(bladeParts)!, lib.darkMetal, n(22));
    const fanFrame = mergeGeometries([
      new THREE.BoxGeometry(2.3, 0.14, 0.4).translate(0, 1.08, 0),
      new THREE.BoxGeometry(2.3, 0.14, 0.4).translate(0, -1.08, 0),
      new THREE.BoxGeometry(0.14, 2.3, 0.4).translate(1.08, 0, 0),
      new THREE.BoxGeometry(0.14, 2.3, 0.4).translate(-1.08, 0, 0),
      new THREE.TorusGeometry(1.02, 0.035, 6, 48),
      new THREE.TorusGeometry(0.7, 0.02, 6, 40).translate(0, 0, 0.12),
      new THREE.BoxGeometry(2.0, 0.03, 0.03).translate(0, 0, 0.14),
      new THREE.BoxGeometry(0.03, 2.0, 0.03).translate(0, 0, 0.14),
    ])!;
    const fanGlow = new THREE.TorusGeometry(1.0, 0.018, 6, 48).translate(0, 0, -0.1);
    this.fans.extra = [twin(fanFrame, lib.gunmetal, n(22)), twin(fanGlow, links.basic('primary', 2.2), n(22))];

    // Fibre-optic cable bundles arching over the track ----------------------------------------
    const cableGeo = (() => {
      const parts: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 4; k++) {
        const off = (k - 1.5) * 0.45;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 24; i++) {
          const t = i / 24;
          const x = -1 + t * 2;
          pts.push(new THREE.Vector3(x, -(1 - x * x) * 0.32 + off * 0.1, off));
        }
        const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.012 + (k % 2) * 0.006, 6, false);
        parts.push(tube);
      }
      return mergeGeometries(parts)!;
    })();
    this.cablePhase = attr(cableGeo, 'aPhase', 30, 1);
    this.cables = mk(cableGeo, worldMaterial(CABLE_FRAG, {}, CABLE_VERT), n(26));

    // Server-room bridges spanning overhead with downlights.
    const bridgeGeo = mergeGeometries([
      new THREE.BoxGeometry(1, 1.2, 3.2),
      new THREE.BoxGeometry(1, 0.2, 3.6).translate(0, 0.7, 0),
      new THREE.BoxGeometry(1, 0.35, 0.3).translate(0, -0.7, 1.4),
      new THREE.BoxGeometry(1, 0.35, 0.3).translate(0, -0.7, -1.4),
    ])!;
    this.bridges = mk(bridgeGeo, lib.darkMetal, 8);
    const bridgeLights = mergeGeometries([
      new THREE.BoxGeometry(1, 0.06, 0.25).translate(0, -0.62, 0.7),
      new THREE.BoxGeometry(1, 0.06, 0.25).translate(0, -0.62, -0.7),
    ])!;
    this.bridges.extra = [twin(bridgeLights, links.basic('secondary', 2.2), 8)];

    // Digital tunnel frames: octagonal rings of panels around the streams.
    const tunnelParts: THREE.BufferGeometry[] = [];
    const tunnelGlow: THREE.BufferGeometry[] = [];
    const R = 7.4;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      if (Math.sin(a) < -0.6) continue; // open at the floor
      const panel = new THREE.BoxGeometry(5.4, 0.35, 1.6).rotateZ(a + Math.PI / 2).translate(Math.cos(a) * R, Math.sin(a) * R + 2.6, 0);
      tunnelParts.push(panel);
      tunnelGlow.push(new THREE.BoxGeometry(5.0, 0.05, 0.12).rotateZ(a + Math.PI / 2).translate(Math.cos(a) * (R - 0.2), Math.sin(a) * (R - 0.2) + 2.6, 0.7));
    }
    this.tunnel = mk(mergeGeometries(tunnelParts)!, lib.darkMetal, n(40));
    this.tunnel.extra = [twin(mergeGeometries(tunnelGlow)!, links.basic('primary', 2.4), n(40))];

    // Light shafts (from fans and bridge downlights).
    const shaftGeo = new THREE.CylinderGeometry(1, 0.35, 1, 24, 1, true).translate(0, -0.5, 0);
    const shaftMat = shaftMaterial('primary', 0.22);
    this.shafts = mk(shaftGeo, shaftMat, quality.volumetrics ? 40 : 0, 5);

    this.buildBackdrop(scene);
    this.reset();
  }

  // ------------------------------------------------------------- backdrop

  private buildBackdrop(scene: THREE.Scene): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(420, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { ...THEME },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: /* glsl */ `
          ${GLSL_THEME_UNIFORMS}
          varying vec3 vDir;
          void main() {
            float y = vDir.y;
            vec3 col = mix(uVoid * 1.6, uVoid * 0.18, smoothstep(-0.02, 0.55, y));
            vec2 g = vec2(atan(vDir.x, -vDir.z) * 14.0, y * 24.0);
            vec2 f = abs(fract(g) - 0.5);
            float line = smoothstep(0.475, 0.5, max(f.x, f.y));
            col += line * uPrimary * 0.035 * smoothstep(0.05, 0.3, y);
            col += uPrimary * 0.07 * exp(-abs(y) * 12.0);
            col += uSecondary * 0.05 * exp(-abs(y) * 4.0) * uCore;
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    scene.add(sky);
    this.sky = sky;

    // THE giant processor on the horizon.
    const coreMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...THEME },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        ${GLSL_THEME_UNIFORMS}
        varying vec2 vUv;
        ${GLSL_HASH}
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float s = mix(0.34, 0.5, uCore);
          float box = max(abs(p.x), abs(p.y));
          float chip = step(box, s);
          float die = step(box, s * 0.55);
          float pins = step(s, box) * step(box, s + 0.07) * step(0.5, fract((abs(p.x) > abs(p.y) ? p.y : p.x) * 26.0));
          float ang = atan(p.y, p.x);
          float ray = smoothstep(0.03, 0.0, abs(fract(ang * 8.0 / 3.14159) - 0.5) - 0.46) * step(s + 0.07, box);
          float pulse = fract(length(p) * 3.0 - uTime * 0.5);
          vec3 c = vec3(0.0);
          float pul = 0.7 + 0.3 * sin(uTime * 2.2) + uBeat * 0.4;
          c += chip * (1.0 - die) * vec3(0.03, 0.035, 0.05);
          // Die with engraved circuit blocks.
          vec2 dp = fract(p * 9.0);
          float blocks = step(0.12, dp.x) * step(0.12, dp.y) * step(0.35, hash12(floor(p * 9.0)));
          c += die * mix(uPrimary, vec3(1.0), 0.15 + 0.3 * uCore) * (0.25 + blocks * 0.35 + pul * 0.15 + uCore * 0.5);
          c += pins * uSecondary * 0.7;
          c += ray * uPrimary * smoothstep(0.1, 0.0, abs(pulse - 0.5)) * exp(-length(p) * 1.4) * 1.4;
          float glow = exp(-max(box - s, 0.0) * 5.0) * (1.0 - chip) * (0.14 + 0.35 * uCore);
          c += uPrimary * glow;
          float a = clamp(chip + pins + glow + ray * 0.5, 0.0, 1.0);
          gl_FragColor = vec4(c, a);
        }`,
    });
    const core = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), coreMat);
    core.position.set(0, 60, -380);
    core.renderOrder = -9;
    core.frustumCulled = false;
    scene.add(core);
    this.coreBackdrop = core;

    // Floating binary + drifting dust: GPU-only, world-locked.
    const mkPoints = (count: number, glyph: boolean, seed: number): THREE.Points => {
      const pos = new Float32Array(count * 3);
      const cell = new Float32Array(count);
      const r = new Random(seed);
      for (let i = 0; i < count; i++) {
        const side = r.chance(0.5) ? -1 : 1;
        pos[i * 3] = glyph ? side * r.range(6, 70) : r.range(-30, 30);
        pos[i * 3 + 1] = glyph ? r.range(1.2, 34) : r.range(0.3, 16);
        pos[i * 3 + 2] = r.range(0, 200);
        cell[i] = r.int(0, 15);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));
      const pts = new THREE.Points(
        geo,
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          uniforms: { ...THEME, uGlyphs: { value: glyphAtlas() }, uScale: { value: 500 }, uGlyph: { value: glyph ? 1 : 0 } },
          vertexShader: /* glsl */ `
            ${GLSL_THEME_UNIFORMS}
            uniform float uScale;
            uniform float uGlyph;
            attribute float aCell;
            varying float vCell;
            varying float vFade;
            void main() {
              vCell = aCell;
              float rel = mod(position.z - uDist * (uGlyph > 0.5 ? 1.0 : 1.0), 200.0) - 15.0;
              vec3 p = vec3(position.x + sin(uTime * 0.3 + position.z) * (1.0 - uGlyph) * 0.8,
                            position.y + sin(uTime * 0.7 + position.z) * 0.6, -rel);
              vec4 mv = modelViewMatrix * vec4(p, 1.0);
              vFade = smoothstep(185.0, 110.0, rel) * smoothstep(-15.0, 0.0, rel);
              gl_PointSize = uScale * (uGlyph > 0.5 ? 0.55 : 0.09) / -mv.z;
              gl_Position = projectionMatrix * mv;
            }`,
          fragmentShader: /* glsl */ `
            ${GLSL_THEME_UNIFORMS}
            uniform sampler2D uGlyphs;
            uniform float uGlyph;
            varying float vCell;
            varying float vFade;
            void main() {
              float g;
              if (uGlyph > 0.5) {
                vec2 c = vec2(mod(vCell, 4.0), floor(vCell / 4.0)) / 4.0;
                g = texture2D(uGlyphs, c + gl_PointCoord / 4.0).r * 0.9;
              } else {
                g = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)) * 0.35;
              }
              vec3 col = mix(uPrimary, uSecondary, step(11.5, vCell));
              gl_FragColor = vec4(col * g * vFade, 1.0);
            }`,
        }),
      );
      pts.frustumCulled = false;
      pts.renderOrder = 4;
      scene.add(pts);
      return pts;
    };
    this.bits = mkPoints(Math.round(520 * this.q.detail), true, 99);
    if (this.q.volumetrics) this.dust = mkPoints(Math.round(700 * this.q.detail), false, 7);
  }

  setViewportHeight(px: number): void {
    (this.bits.material as THREE.ShaderMaterial).uniforms.uScale.value = px;
    if (this.dust) (this.dust.material as THREE.ShaderMaterial).uniforms.uScale.value = px;
  }

  /** True while the player is inside a digital tunnel section. */
  inTunnel(distance: number): boolean {
    return distance > this.tunnelAt && distance < this.tunnelEnd;
  }

  // ------------------------------------------------------------ generation

  private all(): Batch<Item>[] {
    return [this.boxes, this.heatsinks, this.caps, this.keys, this.panels, this.rain, this.rings, this.pillars, this.fans, this.cables, this.bridges, this.tunnel, this.shafts] as Batch<Item>[];
  }

  reset(): void {
    for (const b of this.all()) b.items.length = 0;
    this.rng.reseed(4242);
    this.cursorNear = [-BEHIND, -BEHIND + 4];
    this.cursorFar = [-BEHIND, -BEHIND + 7];
    this.cursorMega = [-BEHIND, -BEHIND + 30];
    this.cursorFloat = -BEHIND;
    this.ringCursor = 60;
    this.cableCursor = 30;
    this.bridgeCursor = 110;
    this.tunnelAt = 520;
    this.tunnelEnd = -1;
    this.tunnelCursor = 520;
    this.districtEnd = [-BEHIND, -BEHIND];
    this.district = ['server', 'board'];
    this.update(0, 0);
  }

  private pickDistrict(dist: number, prev: District): District {
    if (stageAt(dist).id === 7) return 'core';
    const opts: District[] = ['server', 'server', 'ram', 'board', 'keyboard', 'storage'];
    let d = this.rng.pick(opts);
    if (d === prev) d = this.rng.pick(opts);
    return d;
  }

  private push<T extends Item>(b: Batch<T>, item: T): void {
    if (b.items.length < b.max) b.items.push(item);
  }

  private spawnAhead(distance: number): void {
    const rng = this.rng;
    const limit = distance + AHEAD;
    const D = this.q.detail;

    // Digital tunnels: every 550-900 m, 70-120 m long.
    while (this.tunnelCursor < limit) {
      if (this.tunnelCursor >= this.tunnelAt && this.tunnelEnd < this.tunnelAt) this.tunnelEnd = this.tunnelAt + rng.range(70, 120);
      if (this.tunnelCursor < this.tunnelEnd) {
        this.push(this.tunnel, { dist: this.tunnelCursor, len: 2, x: 0, y: 0, s: 1, h: 1, phase: rng.next(), side: 0 });
        this.tunnelCursor += 4.5;
      } else {
        this.tunnelAt = this.tunnelEnd + rng.range(550, 900);
        this.tunnelCursor = this.tunnelAt;
      }
    }
    const inTunnel = (d: number): boolean => d > this.tunnelAt - 6 && d < this.tunnelEnd + 6;

    for (const si of [0, 1] as const) {
      const side = si === 0 ? -1 : 1;
      while (this.cursorNear[si] < limit) {
        const d = this.cursorNear[si];
        if (d >= this.districtEnd[si]) {
          this.district[si] = this.pickDistrict(d, this.district[si]);
          this.districtEnd[si] = d + rng.range(90, 170);
        }
        this.cursorNear[si] += this.spawnNear(this.district[si], side, ROAD_HALF + 2.4, d) / Math.min(1.2, Math.max(0.7, D));
      }
      // Far row: towering racks, with giant fans set into some of them.
      while (this.cursorFar[si] < limit) {
        const d = this.cursorFar[si];
        const core = stageAt(d).id === 7;
        const depth = rng.range(12, 22);
        const w = rng.range(9, 16);
        const x = side * (ROAD_HALF + 20 + rng.range(0, 10) + w / 2);
        const h = core ? rng.range(70, 130) : rng.range(34, 90);
        this.push(this.boxes, {
          dist: d, len: depth, x, y: 0, w, h, style: core ? Style.Core : rng.pick([Style.Rack, Style.Rack, Style.Storage]), seed: rng.next() * 50, accent: rng.chance(0.3) ? 1 : 0,
        });
        if (!core && rng.chance(0.55)) {
          const r = rng.range(4.5, 7.5);
          const fy = rng.range(10, Math.max(12, h - r - 4));
          const fx = x - side * (w / 2 + 0.25);
          this.push(this.fans, { dist: d + depth * 0.5, len: 2, x: fx, y: fy, s: r, h: 1, phase: rng.range(0, 6), side });
          if (this.q.volumetrics) {
            this.push(this.shafts, { dist: d + depth * 0.5, len: 2, x: fx, y: fy, s: r * 0.9, h: Math.abs(fx) - 1, phase: 0, side });
          }
        }
        if (rng.chance(0.35)) {
          const ph = rng.range(6, 10);
          this.push(this.panels, { dist: d + depth * 0.5, len: 2, x: x - side * (w / 2 + 1.5), y: rng.range(16, 34), w: ph * 2, h: ph, yaw: -side * 0.35, cell: this.panelCellFor(d), phase: rng.next() });
        }
        if (rng.chance(0.4)) {
          this.push(this.rain, { dist: d + rng.range(0, depth), len: 2, x: side * rng.range(34, 80), y: 0, s: rng.range(4, 7), h: rng.range(36, 70), phase: rng.next() * 10, side });
        }
        this.cursorFar[si] += depth + rng.range(2, 8);
      }
      // Mega towers in the deep background: sense of enormous scale.
      while (this.cursorMega[si] < limit) {
        const d = this.cursorMega[si];
        const w = rng.range(18, 34);
        const depth = rng.range(18, 34);
        this.push(this.boxes, {
          dist: d, len: depth, x: side * rng.range(70, 140), y: 0, w, h: rng.range(120, 240), style: Style.Tower, seed: rng.next() * 50, accent: rng.chance(0.25) ? 1 : 0,
        });
        this.cursorMega[si] += depth + rng.range(10, 40);
      }
    }

    // Floating holo windows close to the streams (skipped inside tunnels).
    while (this.cursorFloat < limit) {
      const d = this.cursorFloat;
      if (!inTunnel(d)) {
        const side = rng.chance(0.5) ? -1 : 1;
        const h = rng.range(1.8, 3.0);
        this.push(this.panels, {
          dist: d, len: 2, x: side * (ROAD_HALF + rng.range(1.8, 4)), y: rng.range(4, 8.5), w: h * 2, h, yaw: -side * rng.range(0.55, 0.85), cell: this.panelCellFor(d), phase: rng.next(),
        });
      }
      this.cursorFloat += rng.range(12, 26) / Math.max(0.7, D);
    }

    while (this.ringCursor < limit) {
      if (!inTunnel(this.ringCursor)) this.push(this.rings, { dist: this.ringCursor, len: 1, x: 0, y: 2.2, s: 1, h: 1, phase: 0, side: 0 });
      this.ringCursor += rng.range(110, 220);
    }
    while (this.cableCursor < limit) {
      if (!inTunnel(this.cableCursor)) {
        this.push(this.cables, { dist: this.cableCursor, len: 2, x: rng.range(-4, 4), y: rng.range(15, 22), s: rng.range(22, 34), h: rng.range(8, 14), phase: rng.next() * 10, side: rng.range(-0.25, 0.25) });
      }
      this.cableCursor += rng.range(28, 70) / Math.max(0.7, D);
    }
    while (this.bridgeCursor < limit) {
      if (!inTunnel(this.bridgeCursor)) {
        const y = rng.range(12, 16);
        this.push(this.bridges, { dist: this.bridgeCursor, len: 3, x: 0, y, s: 56, h: 1, phase: 0, side: 0 });
        if (this.q.volumetrics) {
          for (const lx of [-3.2, 0, 3.2]) this.push(this.shafts, { dist: this.bridgeCursor, len: 2, x: lx, y: y - 0.7, s: 1.1, h: y - 0.7, phase: 1, side: 0 });
        }
      }
      this.bridgeCursor += rng.range(160, 300);
    }
  }

  private panelCellFor(dist: number): number {
    const st = stageAt(dist);
    const errChance = st.id === 7 ? 0.05 : st.corrupt * 0.75;
    return this.rng.chance(errChance) ? 12 + this.rng.int(0, 3) : this.rng.int(0, 11);
  }

  private spawnNear(district: District, side: -1 | 1, inner: number, d: number): number {
    const rng = this.rng;
    const accent = rng.chance(0.3) ? 1 : 0;
    const seed = rng.next() * 50;
    switch (district) {
      case 'server': {
        const len = rng.range(5, 9);
        const w = rng.range(3, 5);
        this.push(this.boxes, { dist: d, len, x: side * (inner + w / 2), y: 0, w, h: rng.range(12, 30), style: Style.Rack, seed, accent });
        return len + rng.range(0.4, 1.5);
      }
      case 'ram': {
        const count = rng.int(4, 8);
        const h = rng.range(8, 14);
        const len = rng.range(10, 15);
        for (let i = 0; i < count; i++) this.push(this.boxes, { dist: d, len, x: side * (inner + 0.3 + i * 1.5), y: 0, w: 0.4, h, style: Style.Ram, seed: seed + i, accent });
        return len + rng.range(2, 5);
      }
      case 'board': {
        const w = rng.range(4, 7);
        const len = rng.range(5, 8);
        const x = side * (inner + w / 2 + 0.3);
        this.push(this.boxes, { dist: d, len, x, y: 0, w, h: rng.range(0.8, 1.4), style: Style.Chip, seed, accent });
        if (rng.chance(0.6)) this.push(this.heatsinks, { dist: d + len / 2, len: 1, x, y: 1.2, s: Math.min(w, len) * 0.75, h: rng.range(1.6, 3.2), phase: 0, side });
        for (let i = 0, nCaps = rng.int(1, 3); i < nCaps; i++) {
          const r = rng.range(0.5, 1.0);
          this.push(this.caps, { dist: d + rng.range(0, len), len: 1, x: side * (inner + w + 1.2 + rng.range(0, 3)), y: 0, s: r, h: rng.range(2, 4.5), phase: 0, side });
        }
        return len + rng.range(1.5, 4);
      }
      case 'keyboard': {
        for (let r = 0, rows = rng.int(2, 4); r < rows; r++) {
          const w = rng.range(2.0, 2.4);
          this.push(this.keys, { dist: d, len: 3, x: side * (inner + 0.2 + r * 2.6 + w / 2), w, cell: rng.int(0, KEY_LABELS.length - 1), tilt: (rng.next() - 0.5) * 0.06 });
        }
        return 2.7;
      }
      case 'storage': {
        const len = rng.range(6, 10);
        const w = rng.range(3.5, 5);
        for (let i = 0, stack = rng.int(2, 5); i < stack; i++) {
          this.push(this.boxes, { dist: d, len, x: side * (inner + w / 2), y: i * 1.65, w, h: 1.55, style: Style.Storage, seed: seed + i, accent });
        }
        return len + rng.range(1, 3);
      }
      case 'core': {
        const len = rng.range(8, 14);
        const w = rng.range(5, 8);
        this.push(this.boxes, { dist: d, len, x: side * (inner + 1 + w / 2), y: 0, w, h: rng.range(14, 30), style: Style.Core, seed, accent: 1 });
        if (rng.chance(0.6)) this.push(this.pillars, { dist: d + len / 2, len: 2, x: side * (inner + 0.4), y: 0, s: rng.range(0.8, 1.4), h: rng.range(22, 50), phase: rng.next() * 10, side });
        return len + rng.range(1, 4);
      }
    }
  }

  private recycle<T extends Item>(list: T[], distance: number): void {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].dist + list[i].len < distance - BEHIND) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
  }

  // ------------------------------------------------------------------ update

  update(distance: number, dt: number): void {
    this.time += dt;
    for (const b of this.all()) this.recycle(b.items, distance);
    this.spawnAhead(distance);

    const { m, qt, p, s, e } = this;
    const z = (d: number): number => -(d - distance);
    const put = (b: Batch<Item>, i: number): void => {
      b.mesh.setMatrixAt(i, m);
      if (b.extra) for (const x of b.extra) x.setMatrixAt(i, m);
    };
    qt.identity();

    this.boxes.items.forEach((b, i) => {
      p.set(b.x, b.y, z(b.dist));
      s.set(b.w, b.h, b.len);
      m.compose(p, qt, s);
      put(this.boxes as Batch<Item>, i);
      this.aStyle.setX(i, b.style);
      this.aSeed.setX(i, b.seed);
      this.aAccent.setX(i, b.accent);
    });
    this.finish(this.boxes, [this.aStyle, this.aSeed, this.aAccent]);

    this.pillars.items.forEach((b, i) => {
      p.set(b.x, 0, z(b.dist));
      s.set(b.s * 2, b.h, b.s * 2);
      m.compose(p, qt, s);
      put(this.pillars as Batch<Item>, i);
      this.pillarSeed.setX(i, b.phase);
    });
    this.finish(this.pillars, [this.pillarSeed]);

    this.heatsinks.items.forEach((b, i) => {
      p.set(b.x, b.y, z(b.dist));
      s.set(b.s, b.h, b.s);
      m.compose(p, qt, s);
      put(this.heatsinks as Batch<Item>, i);
    });
    this.finish(this.heatsinks, []);

    this.caps.items.forEach((b, i) => {
      p.set(b.x, 0, z(b.dist));
      s.set(b.s * 2, b.h, b.s * 2);
      m.compose(p, qt, s);
      put(this.caps as Batch<Item>, i);
    });
    this.finish(this.caps, []);

    this.keys.items.forEach((k, i) => {
      p.set(k.x, 0, z(k.dist));
      qt.setFromEuler(e.set(k.tilt, 0, k.tilt * 0.5));
      s.set(k.w, 0.9, k.w);
      m.compose(p, qt, s);
      put(this.keys as Batch<Item>, i);
      this.keyCell.setXY(i, (k.cell % 4) / 4, (3 - Math.floor(k.cell / 4)) / 4);
      this.keyPhase.setX(i, (k.cell * 0.137) % 1);
    });
    qt.identity();
    this.finish(this.keys, [this.keyCell, this.keyPhase]);

    this.panels.items.forEach((pn, i) => {
      p.set(pn.x, pn.y, z(pn.dist));
      qt.setFromEuler(e.set(0, pn.yaw, 0));
      s.set(pn.w, pn.h, 1);
      m.compose(p, qt, s);
      put(this.panels as Batch<Item>, i);
      this.panelCell.setXY(i, (pn.cell % 4) / 4, (3 - Math.floor(pn.cell / 4)) / 4);
      this.panelPhase.setX(i, pn.phase);
    });
    qt.identity();
    this.finish(this.panels, [this.panelCell, this.panelPhase]);

    this.rain.items.forEach((r, i) => {
      p.set(r.x, r.y, z(r.dist));
      qt.setFromEuler(e.set(0, r.x < 0 ? 0.5 : -0.5, 0));
      s.set(r.s, r.h, 1);
      m.compose(p, qt, s);
      put(this.rain as Batch<Item>, i);
      this.rainPhase.setX(i, r.phase);
    });
    qt.identity();
    this.finish(this.rain, [this.rainPhase]);

    this.rings.items.forEach((r, i) => {
      p.set(0, r.y, z(r.dist));
      m.compose(p, qt, s.set(1, 1, 1));
      put(this.rings as Batch<Item>, i);
    });
    this.finish(this.rings, []);

    // Fans face the track and spin.
    this.fans.items.forEach((f, i) => {
      p.set(f.x, f.y, z(f.dist));
      qt.setFromEuler(e.set(0, f.side > 0 ? -Math.PI / 2 : Math.PI / 2, 0));
      s.setScalar(f.s);
      m.compose(p, qt, s);
      for (const x of this.fans.extra!) x.setMatrixAt(i, m);
      this.spinQ.setFromAxisAngle(Z_AXIS, this.time * (2.2 + f.phase * 0.3) + f.phase);
      this.spinQ.premultiply(qt);
      m.compose(p, this.spinQ, s);
      this.fans.mesh.setMatrixAt(i, m);
    });
    qt.identity();
    this.finish(this.fans, []);

    this.cables.items.forEach((c, i) => {
      p.set(c.x, c.y, z(c.dist));
      qt.setFromEuler(e.set(0, c.side, 0));
      s.set(c.s, c.h, 1);
      m.compose(p, qt, s);
      put(this.cables as Batch<Item>, i);
      this.cablePhase.setX(i, c.phase);
    });
    qt.identity();
    this.finish(this.cables, [this.cablePhase]);

    this.bridges.items.forEach((b, i) => {
      p.set(0, b.y, z(b.dist));
      s.set(b.s, 1, 1);
      m.compose(p, qt, s);
      put(this.bridges as Batch<Item>, i);
    });
    this.finish(this.bridges, []);

    this.tunnel.items.forEach((t, i) => {
      p.set(0, 0, z(t.dist));
      m.compose(p, qt, s.set(1, 1, 1));
      put(this.tunnel as Batch<Item>, i);
    });
    this.finish(this.tunnel, []);

    // Shafts: fans shine sideways toward the track; bridge lights shine down.
    this.shafts.items.forEach((sh, i) => {
      if (sh.phase > 0.5) {
        p.set(sh.x, sh.y, z(sh.dist));
        qt.identity();
        s.set(sh.s, sh.h, sh.s);
      } else {
        p.set(sh.x, sh.y, z(sh.dist));
        qt.setFromEuler(e.set(0, 0, sh.side > 0 ? -Math.PI / 2 : Math.PI / 2));
        s.set(sh.s, sh.h * 0.8, sh.s);
      }
      m.compose(p, qt, s);
      this.shafts.mesh.setMatrixAt(i, m);
    });
    qt.identity();
    this.finish(this.shafts, []);

    this.coreBackdrop.scale.setScalar(1 + THEME.uCore.value * 0.6);
    void this.sky;
  }

  private finish<T extends Item>(b: Batch<T>, attrs: THREE.InstancedBufferAttribute[]): void {
    const n = Math.min(b.items.length, b.max);
    b.mesh.count = n;
    b.mesh.instanceMatrix.needsUpdate = true;
    if (b.extra) for (const x of b.extra) {
      x.count = n;
      x.instanceMatrix.needsUpdate = true;
    }
    for (const a of attrs) a.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- shaders

const CABLE_VERT = /* glsl */ `
attribute float aPhase;
varying vec2 vUv2;
flat varying float vPh;
#include <fog_pars_vertex>
void main() {
  vUv2 = uv;
  vPh = aPhase;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const CABLE_FRAG = /* glsl */ `
${GLSL_THEME_UNIFORMS}
varying vec2 vUv2;
flat varying float vPh;
#include <fog_pars_fragment>
void main() {
  // Light pulses racing along the fibre.
  float t = fract(vUv2.x * 3.0 - uTime * (0.6 + fract(vPh) * 0.6) + vPh);
  float pulse = smoothstep(0.08, 0.0, abs(t - 0.5));
  vec3 base = mix(uPrimary, uSecondary, step(0.5, fract(vPh * 3.7)));
  vec3 c = base * (0.25 + pulse * 2.4 + uBeat * 0.5);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const RING_VERT = /* glsl */ `
varying vec2 vUv2;
#include <fog_pars_vertex>
void main() {
  vUv2 = uv;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RING_FRAG = /* glsl */ `
${GLSL_THEME_UNIFORMS}
varying vec2 vUv2;
#include <fog_pars_fragment>
void main() {
  float d = fract(vUv2.x * 28.0 - uTime * 1.5);
  vec3 c = mix(uSecondary, uPrimary, step(0.5, d)) * (0.9 + 1.4 * smoothstep(0.15, 0.0, abs(d - 0.5)) + uBeat);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const INST_VERT = /* glsl */ `
attribute vec2 aCell;
attribute float aPhase;
uniform vec2 uCellSize;
varying vec2 vUv;
varying vec2 vLocalUv;
flat varying float vPhase;
#include <fog_pars_vertex>
void main() {
  vLocalUv = uv;
  vUv = aCell + uv * uCellSize;
  vPhase = aPhase;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/** Holographic UI windows: translucent, scanlined, with the odd flicker. */
const PANEL_FRAG = /* glsl */ `
${GLSL_THEME_UNIFORMS}
uniform sampler2D uMap;
varying vec2 vUv;
varying vec2 vLocalUv;
flat varying float vPhase;
#include <fog_pars_fragment>
${GLSL_HASH}
void main() {
  vec4 t = texture2D(uMap, vUv);
  float scan = 0.82 + 0.18 * sin(vLocalUv.y * 180.0 - uTime * 6.0);
  float flickOn = step(0.7, fract(vPhase * 5.13));
  float off = step(0.92, hash12(vec2(floor(uTime * 16.0), vPhase * 40.0))) * flickOn;
  // Holo shimmer band sweeping down.
  float sweep = smoothstep(0.06, 0.0, abs(fract(vLocalUv.y - uTime * 0.25 + vPhase) - 0.5)) * 0.35;
  vec3 tint = mix(vec3(1.0), uPrimary * 1.3, 0.3 * (1.0 - step(0.5, t.a - 0.5)));
  vec3 col = t.rgb * tint * (1.3 * scan) + t.rgb * sweep;
  float a = t.a * 0.9 * (1.0 - off * 0.85);
  gl_FragColor = vec4(col * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Letters glowing on top of giant keyboard keys. */
const KEY_FRAG = /* glsl */ `
${GLSL_THEME_UNIFORMS}
uniform sampler2D uMap;
varying vec2 vUv;
varying vec2 vLocalUv;
flat varying float vPhase;
#include <fog_pars_fragment>
void main() {
  float t = texture2D(uMap, vUv).r;
  float pulse = 0.75 + 0.25 * sin(uTime * 3.0 + vPhase * 20.0);
  vec3 col = mix(uPrimary, uSecondary, step(0.8, vPhase)) * t * 1.7 * pulse;
  gl_FragColor = vec4(col, t);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Falling code columns. */
const RAIN_FRAG = /* glsl */ `
${GLSL_THEME_UNIFORMS}
uniform sampler2D uGlyphs;
varying vec2 vUv;
varying vec2 vLocalUv;
flat varying float vPhase;
#include <fog_pars_fragment>
${GLSL_HASH}
void main() {
  vec2 grid = vec2(5.0, 42.0);
  vec2 g = vLocalUv * grid;
  vec2 id = floor(g);
  vec2 f = fract(g);
  float speed = 6.0 + hash12(vec2(id.x, vPhase)) * 8.0;
  float head = fract(uTime * speed / grid.y + hash12(vec2(id.x, vPhase + 3.0)));
  float y = 1.0 - vLocalUv.y;
  float trail = fract(head - y);
  float bright = smoothstep(0.55, 0.0, trail) * step(0.25, hash12(vec2(id.x, vPhase + 9.0)));
  float gi = floor(hash12(id + floor(uTime * 3.0 + hash12(id) * 5.0)) * 16.0);
  vec2 cell = vec2(mod(gi, 4.0), floor(gi / 4.0)) / 4.0;
  float glyph = texture2D(uGlyphs, cell + f / 4.0).r;
  vec3 c = mix(uPrimary, vec3(1.0), smoothstep(0.03, 0.0, trail)) * glyph * bright;
  c = mix(c, vec3(1.0, 0.1, 0.2) * glyph * bright, uCorrupt * step(0.6, hash12(id + 1.7)));
  float edge = smoothstep(0.0, 0.08, vLocalUv.y) * smoothstep(1.0, 0.8, vLocalUv.y);
  gl_FragColor = vec4(c * edge * 1.4, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

