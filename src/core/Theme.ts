import * as THREE from 'three';
import { damp } from '../utils/math';

/**
 * Computer corruption stages. Distance thresholds drive the palette, glitch
 * intensity and hazard mix. Every world material reads the shared THEME
 * uniforms, so the whole computer re-colours smoothly between stages.
 */
export interface StageDef {
  id: number;
  name: string;
  /** Run distance where this stage begins. */
  at: number;
  primary: string;
  secondary: string;
  /** Background / fog colour. */
  void: string;
  /** 0..1 how much red corruption creeps over circuits. */
  corrupt: number;
  /** 0..1 baseline screen glitch. */
  glitch: number;
  /** Share of low/high hazards that are bad bugs instead of static errors. */
  bugShare: number;
  /** Chance per row of a friendly bug to fix. */
  goodBugChance: number;
  /** Ambient light level (lighting mood). */
  ambient: number;
  /** 0..1 red warning strobe. */
  strobe: number;
}

export const STAGES: readonly StageDef[] = [
  { id: 1, name: 'CLEAN COMPUTER', at: 0, primary: '#00e5ff', secondary: '#b4ff1e', void: '#020a18', corrupt: 0, glitch: 0, bugShare: 0.1, goodBugChance: 0.34, ambient: 1.0, strobe: 0 },
  { id: 2, name: 'MINOR BUGS', at: 450, primary: '#5b7cff', secondary: '#b26bff', void: '#05061a', corrupt: 0.1, glitch: 0, bugShare: 0.3, goodBugChance: 0.32, ambient: 0.9, strobe: 0 },
  { id: 3, name: 'SYSTEM ERRORS', at: 1050, primary: '#ff8a1e', secondary: '#00e5ff', void: '#120810', corrupt: 0.3, glitch: 0.02, bugShare: 0.38, goodBugChance: 0.3, ambient: 0.85, strobe: 0 },
  { id: 4, name: 'CORRUPTED SYSTEM', at: 1750, primary: '#ff2a4a', secondary: '#ff7a1a', void: '#140306', corrupt: 0.5, glitch: 0.04, bugShare: 0.45, goodBugChance: 0.28, ambient: 0.7, strobe: 0.25 },
  { id: 5, name: 'VIRUS INFECTION', at: 2550, primary: '#39ff6a', secondary: '#ff2255', void: '#010604', corrupt: 0.66, glitch: 0.05, bugShare: 0.55, goodBugChance: 0.26, ambient: 0.45, strobe: 0 },
  { id: 6, name: 'CRITICAL SYSTEM FAILURE', at: 3450, primary: '#ff1e3c', secondary: '#ffb020', void: '#120104', corrupt: 0.85, glitch: 0.07, bugShare: 0.6, goodBugChance: 0.24, ambient: 0.6, strobe: 0.6 },
  { id: 7, name: 'THE CORE', at: 4450, primary: '#35d8ff', secondary: '#ffd23a', void: '#050d1c', corrupt: 0.08, glitch: 0.02, bugShare: 0.55, goodBugChance: 0.3, ambient: 1.1, strobe: 0 },
];

export function stageAt(distance: number): StageDef {
  let s = STAGES[0];
  for (const st of STAGES) if (distance >= st.at) s = st;
  return s;
}

/** Shared uniforms (by reference) used by world shaders. */
export const THEME = {
  uPrimary: { value: new THREE.Color(STAGES[0].primary) },
  uSecondary: { value: new THREE.Color(STAGES[0].secondary) },
  uVoid: { value: new THREE.Color(STAGES[0].void) },
  uCorrupt: { value: 0 },
  uGlitch: { value: 0 },
  /** 0..1 blend toward THE CORE look. */
  uCore: { value: 0 },
  /** 0..1 debug-mode "matrix" look. */
  uDebug: { value: 0 },
  uTime: { value: 0 },
  /** 0..1 music beat pulse (kick/snare), decays quickly. */
  uBeat: { value: 0 },
  /** Run distance (world scroll) for world-locked patterns. */
  uDist: { value: 0 },
};

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();
const tmpC = new THREE.Color();
const DEBUG_GREEN = new THREE.Color('#39ff6a');

/** Smoothly moves THEME toward a stage (and debug/admin overrides). */
export function updateTheme(stage: StageDef, dt: number, time: number, dist: number, debug: number, extraGlitch: number): void {
  const k = damp(1.4, dt);
  tmpA.set(stage.primary);
  tmpB.set(stage.secondary);
  tmpC.set(stage.void);
  if (debug > 0) {
    tmpA.lerp(DEBUG_GREEN, debug);
    tmpB.lerp(DEBUG_GREEN, debug * 0.6);
    tmpC.lerp(new THREE.Color('#010d05'), debug);
  }
  const kd = debug > 0 ? damp(6, dt) : k;
  THEME.uPrimary.value.lerp(tmpA, kd);
  THEME.uSecondary.value.lerp(tmpB, kd);
  THEME.uVoid.value.lerp(tmpC, kd);
  THEME.uCorrupt.value += (stage.corrupt * (1 - debug) - THEME.uCorrupt.value) * k;
  THEME.uGlitch.value += (stage.glitch + extraGlitch - THEME.uGlitch.value) * damp(4, dt);
  THEME.uCore.value += ((stage.id === 7 ? 1 : 0) - THEME.uCore.value) * damp(0.8, dt);
  THEME.uDebug.value = debug;
  THEME.uTime.value = time;
  THEME.uDist.value = dist;
}

export function resetTheme(): void {
  const s = STAGES[0];
  THEME.uPrimary.value.set(s.primary);
  THEME.uSecondary.value.set(s.secondary);
  THEME.uVoid.value.set(s.void);
  THEME.uCorrupt.value = 0;
  THEME.uGlitch.value = 0;
  THEME.uCore.value = 0;
  THEME.uDebug.value = 0;
}

/** Shared GLSL helpers. */
export const GLSL_HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

export const GLSL_THEME_UNIFORMS = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform vec3 uVoid;
uniform float uCorrupt;
uniform float uGlitch;
uniform float uCore;
uniform float uDebug;
uniform float uTime;
uniform float uDist;
uniform float uBeat;
`;
