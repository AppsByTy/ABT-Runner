import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/Config';
import { GLSL_HASH, GLSL_THEME_UNIFORMS, THEME } from '../core/Theme';
import type { ThemeLinks } from './ThemeLinks';
import type { MaterialLib } from '../render/MaterialLib';

interface Segment {
  group: THREE.Group;
  /** Run distance of the segment's near edge. */
  dist: number;
}

export const ROAD_WIDTH = CONFIG.lanes.width * 3 + 0.9;

export const worldVert = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const roadVert = /* glsl */ `
uniform mat4 uReflectMatrix;
varying vec3 vWorld;
varying vec4 vReflUv;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vReflUv = uReflectMatrix * wp;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/** Three data streams: dark glass channels with packets of light flowing forward, glossy reflections. */
const roadFrag = /* glsl */ `
${GLSL_THEME_UNIFORMS}
uniform float uLaneW;
uniform float uRoadW;
uniform sampler2D uReflect;
uniform float uReflectOn;
varying vec3 vWorld;
varying vec4 vReflUv;
#include <fog_pars_fragment>
${GLSL_HASH}
void main() {
  float x = vWorld.x;
  float run = uDist - vWorld.z;          // world-locked coordinate along the track
  float ax = abs(x);
  vec3 col = mix(vec3(0.01, 0.02, 0.04), uVoid * 0.6, 0.5);

  // Lane channels.
  float lanePos = (x + uLaneW * 1.5) / uLaneW;       // 0..3 across the road
  float laneIdx = floor(lanePos);
  float lx = fract(lanePos) - 0.5;                   // -0.5..0.5 within a lane
  float chan = smoothstep(0.47, 0.44, abs(lx)) * step(ax, uLaneW * 1.5);
  col += chan * uPrimary * 0.035;
  // Chevrons pointing forward, drifting with the flow.
  float chev = fract((run - abs(lx) * 2.2 - uTime * 6.0) * 0.25);
  col += chan * smoothstep(0.08, 0.0, abs(chev - 0.5)) * uPrimary * 0.05;

  // Data packets: 5 sub-columns per lane, flowing away from the player.
  float sub = floor((lx + 0.5) * 5.0);
  float subx = fract((lx + 0.5) * 5.0) - 0.5;
  float speed = 14.0 + hash12(vec2(laneIdx, sub)) * 10.0;
  float s = run - uTime * speed;
  float cell = floor(s / 3.2);
  float cf = fract(s / 3.2);
  float on = step(0.62, hash12(vec2(cell, laneIdx * 7.0 + sub)));
  float len = 0.1 + hash12(vec2(cell, sub)) * 0.18;
  float packet = on * smoothstep(len, len - 0.05, cf) * smoothstep(0.0, 0.04, cf) * smoothstep(0.16, 0.06, abs(subx));
  float fw = fwidth(run);
  float detail = 1.0 - smoothstep(0.4, 1.2, fw);
  vec3 pc = mix(uPrimary, uSecondary, step(0.8, hash12(vec2(cell, sub + 3.0))));
  col += packet * pc * (0.35 + 0.35 * (1.0 - cf / len)) * chan * detail;
  col += chan * uPrimary * 0.025 * (1.0 - detail);

  // Lane dividers and road edges.
  float divider = smoothstep(0.035, 0.0, abs(abs(lx) - 0.5) * uLaneW) * step(ax, uLaneW * 1.5 - 0.1);
  float pulse = 0.6 + 0.4 * sin(run * 0.35 - uTime * 8.0);
  col += divider * uPrimary * (0.4 + 0.3 * pulse);
  float edge = smoothstep(0.09, 0.0, abs(ax - uRoadW * 0.5 + 0.12));
  col += edge * uSecondary * 0.8;

  // Corruption creeping in: dead, darkened floor broken into flickering
  // glitch tiles with hot red edges and scanlines (not flat colour).
  vec2 tg = vec2(x * 2.2, run * 1.1);
  vec2 bq = floor(tg);
  vec2 tf = fract(tg);
  float n = vnoise(vec2(x * 0.35, run * 0.08)) * 0.75 + hash12(bq) * 0.25;
  float cm = smoothstep(1.0 - uCorrupt * 0.72, 1.02 - uCorrupt * 0.72, n) * step(0.01, uCorrupt);
  float tileEdge = smoothstep(0.07, 0.0, min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y)));
  float tileOn = step(0.62, hash12(bq + floor(uTime * 9.0 + hash12(bq) * 5.0)));
  float scanC = smoothstep(0.3, 0.0, abs(fract(run * 4.0 + uTime * 2.5) - 0.5)) * 0.5;
  vec3 corruptCol = vec3(1.0, 0.07, 0.2) * (tileEdge * 0.55 * (0.5 + tileOn) + tileOn * 0.1 + scanC * 0.05);
  col = mix(col, col * 0.2 + corruptCol, cm * 0.9);

  // Core: bright energy floor.
  col += uCore * chan * vec3(0.55, 0.85, 1.0) * 0.06;

  // Glossy glass: planar reflection (HIGH/ULTRA) or a cheap glow falloff.
  vec3 toCam = normalize(cameraPosition - vWorld);
  float fres = 0.18 + 0.82 * pow(1.0 - max(toCam.y, 0.0), 4.0);
  float gloss = mix(0.55, 1.0, chan) * (1.0 - cm * 0.7);
  if (uReflectOn > 0.5) {
    vec4 ruv = vReflUv;
    // Slight ripple from the data packets and micro-surface.
    ruv.xy += vec2(vnoise(vWorld.xz * 3.0 + uTime) - 0.5, vnoise(vWorld.zx * 2.0) - 0.5) * 0.012 * ruv.w;
    vec3 refl = texture2DProj(uReflect, ruv).rgb;
    col += refl * fres * gloss * 0.85;
  } else {
    col += uPrimary * 0.03 * fres * gloss;
  }
  // Beat pulse travelling along the lane dividers.
  col += divider * uPrimary * uBeat * 0.6;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Giant motherboard: traces, vias and pulses of current. */
const boardFrag = /* glsl */ `
${GLSL_THEME_UNIFORMS}
varying vec3 vWorld;
#include <fog_pars_fragment>
${GLSL_HASH}
float seg(float d, float w) { return smoothstep(w, w * 0.4, d); }
void main() {
  float run = uDist - vWorld.z;
  vec2 p = vec2(vWorld.x, run) / 2.4;
  vec2 id = floor(p);
  vec2 f = fract(p);
  float h = hash12(id);
  float h2 = hash12(id + 17.3);
  vec3 base = mix(vec3(0.008, 0.025, 0.03), uVoid * 0.8, 0.6);
  vec3 col = base;

  // Traces: each cell draws a horizontal and/or vertical trace, sometimes a diagonal.
  float w = 0.06;
  float t = 0.0;
  if (h > 0.35) t = max(t, seg(abs(f.y - 0.5), w));
  if (h2 > 0.45) t = max(t, seg(abs(f.x - 0.5), w));
  if (h > 0.8) t = max(t, seg(abs(f.x - f.y), w * 1.2));
  // Vias.
  float via = step(0.7, hash12(id + 5.1));
  float vd = length(f - 0.5);
  float ring = seg(abs(vd - 0.12), 0.03) * via;

  float fw = fwidth(p.y);
  float detail = 1.0 - smoothstep(0.08, 0.3, fw);
  // Current pulses running along traces.
  float pulseT = fract(run * 0.06 + h * 3.0 - uTime * (0.35 + h2 * 0.5));
  float pulse = smoothstep(0.1, 0.0, abs(pulseT - 0.5)) * step(0.55, h2);
  vec3 trace = uPrimary * (0.08 + 0.8 * pulse);
  col += t * trace * detail + ring * uSecondary * 0.35 * detail;
  col += (1.0 - detail) * uPrimary * 0.03;

  // Large chip pads scattered on the board.
  vec2 bp = vec2(vWorld.x, run) / 14.0;
  vec2 bid = floor(bp);
  vec2 bf = fract(bp) - 0.5;
  float pad = step(0.75, hash12(bid + 9.0)) * step(max(abs(bf.x), abs(bf.y)), 0.22);
  col = mix(col, vec3(0.02, 0.02, 0.03), pad * 0.85);
  col += pad * step(0.2, max(abs(bf.x), abs(bf.y))) * uSecondary * 0.4;

  // Corruption: red rot spreading over the board.
  float n = vnoise(p * 0.35 + 3.0) * 0.65 + vnoise(p * 1.7) * 0.35;
  float cm = smoothstep(1.0 - uCorrupt, 1.08 - uCorrupt, n) * step(0.01, uCorrupt);
  float flick = step(0.6, hash12(vec2(floor(run), floor(uTime * 9.0))));
  col = mix(col, vec3(0.2, 0.0, 0.03) + vec3(1.0, 0.1, 0.2) * t * (0.4 + 0.6 * flick), cm * 0.85);

  // Core: energised golden traces.
  col += uCore * t * uSecondary * 0.35 * detail;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Fibre-optic cables running beside the streams, pulsing with data. */
const cableRunFrag = /* glsl */ `
${GLSL_THEME_UNIFORMS}
varying vec3 vWorld;
#include <fog_pars_fragment>
${GLSL_HASH}
void main() {
  float run = uDist - vWorld.z;
  float lane = floor(vWorld.y * 20.0 + sign(vWorld.x) * 3.0);
  float sp = 30.0 + hash12(vec2(lane, 1.0)) * 25.0;
  float t = fract((run - uTime * sp) / 14.0 + hash12(vec2(lane, 3.0)));
  float pulse = smoothstep(0.06, 0.0, abs(t - 0.5));
  vec3 base = mix(uPrimary, uSecondary, step(0.5, hash12(vec2(lane, 7.0))));
  gl_FragColor = vec4(base * (0.18 + pulse * 2.6 + uBeat * 0.3), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export function worldMaterial(frag: string, extra: Record<string, THREE.IUniform> = {}, vert = worldVert): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...THEME, ...extra },
    vertexShader: vert,
    fragmentShader: frag,
    fog: true,
  });
}

/**
 * Endless digital pathway built from a ring of pooled segments. Patterns are
 * computed from the world-locked run coordinate, so segments tile seamlessly.
 */
export class Track {
  private readonly segments: Segment[] = [];
  private readonly len = CONFIG.track.segmentLength;

  readonly group = new THREE.Group();
  readonly reflectUniforms = {
    uReflect: { value: null as THREE.Texture | null },
    uReflectMatrix: { value: new THREE.Matrix4() },
    uReflectOn: { value: 0 },
  };

  constructor(scene: THREE.Scene, links: ThemeLinks, lib: MaterialLib) {
    const L = this.len;
    scene.add(this.group);
    const roadMat = worldMaterial(
      roadFrag,
      {
        uLaneW: { value: CONFIG.lanes.width },
        uRoadW: { value: ROAD_WIDTH },
        ...this.reflectUniforms,
      },
      roadVert,
    );
    const boardMat = worldMaterial(boardFrag);
    const cableMat = worldMaterial(cableRunFrag);

    const railMat = lib.darkMetal;
    const glowMat = links.basic('primary', 0.9);
    const nodeGlow = links.basic('secondary', 0.7);

    const roadGeo = new THREE.PlaneGeometry(ROAD_WIDTH, L, 1, 1).rotateX(-Math.PI / 2);
    const boardGeo = new THREE.PlaneGeometry(220, L, 1, 1).rotateX(-Math.PI / 2).translate(0, -0.2, 0);

    const dark: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];
    const nodes: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const x = sx * (ROAD_WIDTH / 2 + 0.18);
      dark.push(new THREE.BoxGeometry(0.34, 0.4, L).translate(x, 0.12, 0));
      glow.push(new THREE.BoxGeometry(0.36, 0.035, L).translate(x, 0.33, 0));
      // Data nodes: connector blocks along the rail.
      for (let k = 0; k < 3; k++) {
        const z = -L / 2 + (k + 0.5) * (L / 3);
        dark.push(new THREE.BoxGeometry(0.7, 0.55, 0.9).translate(sx * (ROAD_WIDTH / 2 + 0.55), 0.22, z));
        nodes.push(new THREE.BoxGeometry(0.72, 0.05, 0.3).translate(sx * (ROAD_WIDTH / 2 + 0.55), 0.52, z));
      }
    }
    // Chamfered carbon trim along the rails and fibre bundles beside them.
    const cables: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const r = 0.035 + (k % 2) * 0.015;
        cables.push(new THREE.CylinderGeometry(r, r, L, 6, 1, true).rotateX(Math.PI / 2).translate(sx * (ROAD_WIDTH / 2 + 1.05 + k * 0.12), 0.04 + (k % 2) * 0.05, 0));
      }
    }
    const darkGeo = mergeGeometries(dark)!;
    const glowGeo = mergeGeometries(glow)!;
    const nodeGeo = mergeGeometries(nodes)!;
    const cableGeo = mergeGeometries(cables)!;

    for (let i = 0; i < CONFIG.track.segmentCount; i++) {
      const g = new THREE.Group();
      g.add(
        new THREE.Mesh(roadGeo, roadMat),
        new THREE.Mesh(boardGeo, boardMat),
        new THREE.Mesh(darkGeo, railMat),
        new THREE.Mesh(glowGeo, glowMat),
        new THREE.Mesh(nodeGeo, nodeGlow),
        new THREE.Mesh(cableGeo, cableMat),
      );
      this.group.add(g);
      this.segments.push({ group: g, dist: 0 });
    }
    this.reset();
  }

  reset(): void {
    const behind = CONFIG.spawn.despawnBehind;
    this.segments.forEach((s, i) => {
      s.dist = -behind + i * this.len;
    });
    this.update(0);
  }

  update(distance: number): void {
    const behind = CONFIG.spawn.despawnBehind;
    const total = this.segments.length * this.len;
    for (const s of this.segments) {
      while (s.dist + this.len < distance - behind) s.dist += total;
      s.group.position.z = -(s.dist - distance) - this.len / 2;
    }
  }
}
