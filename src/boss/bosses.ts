import type { MaterialLib } from '../render/MaterialLib';
import type { Random } from '../utils/Random';
import type { ObstacleKind } from '../world/Obstacles';
import type { BossModel } from './BossModel';
import { CodeBreaker } from './models/CodeBreaker';
import { FirewallBoss } from './models/FirewallBoss';
import { MalwareBeast } from './models/MalwareBeast';
import { SystemCrash } from './models/SystemCrash';

/**
 * Boss catalogue. Everything that makes a boss itself lives here as data:
 * model, stats, phases and attack patterns. The BossDirector runs any of
 * them, so adding a boss = adding an entry (and a model).
 *
 * Attack rows are hazards built from the runner's own obstacle kinds, so
 * the fight is played with the same lanes / jump / slide as the run. A row
 * never blocks all three lanes with something you can't jump or slide.
 */
export interface Row {
  /** Seconds after the attack's first hazard arrives. */
  at: number;
  lanes: number[];
  kind: ObstacleKind;
  depth?: number;
  /** Decoy hologram: harmless, flickers, no floor warning (Code Breaker). */
  fake?: boolean;
}

export interface AttackCtx {
  rng: Random;
  /** 0-based phase. */
  phase: number;
  /** Lane the runner is in now. */
  lane: number;
  /** Boss colour for energy hazards. */
  color: string;
}

export interface AttackDef {
  /** Model animation to play. */
  anim: string;
  /** HUD call-out the first time it is used. */
  call: string;
  rows: (c: AttackCtx) => Row[];
  /** Optional screen effect while it plays. */
  fx?: 'glitch' | 'bluescreen' | 'teleport';
  /** Big telegraphed attack: slow motion wind-up; a clean dodge earns a COUNTER. */
  heavy?: boolean;
  /** Area attack: the open lanes light up green as safe zones. */
  area?: boolean;
  /** Left/right controls are swapped while it plays. */
  reverse?: boolean;
}

/** The player's side of the fight: touch attack sequences (see Combat.ts). */
export interface CombatDef {
  /** Sequence pool per phase (T tap, L/R swipe left/right, U/D swipe up/down). */
  seqs: string[][];
  /** The long sequence that unleashes the special attack. */
  special: string;
  /** Seconds allowed per input in phase 1 (shrinks each phase). */
  perStep: number;
  /** Weak points per opening, per phase (the final boss has several). */
  weak?: number[];
}

export interface PhaseDef {
  /** Starts when health falls to this fraction (1 = the start). */
  at: number;
  label: string;
  attacks: string[];
}

export interface BossDef {
  id: string;
  name: string;
  title: string;
  /** Main + accent colours (lighting, HUD, energy hazards). */
  color: string;
  accent: string;
  make: (lib: MaterialLib) => BossModel;
  /** Metres in front of the runner it holds during the fight. */
  z: number;
  scale: number;
  hp: number;
  phases: PhaseDef[];
  attacks: Record<string, AttackDef>;
  /** Intro length (s) and when its entrance lands (shake, impact sound). */
  intro: number;
  impactAt: number;
  /** Reaction time (s) from hazard appearing to reaching the runner, phase 1. */
  lead: number;
  /** Rest between attacks (s), phase 1. */
  gap: number;
  combat: CombatDef;
}

// ------------------------------------------------------------ helpers

const ALL = [0, 1, 2];
const others = (l: number): number[] => ALL.filter((x) => x !== l);
/** n lanes, leaving at least one free (prefers covering the runner's lane). */
const lanes = (c: AttackCtx, n: number): number[] => {
  const pick = c.rng.shuffle([...ALL]).slice(0, Math.min(2, n));
  if (!pick.includes(c.lane) && c.rng.chance(0.6)) pick[0] = c.lane;
  return [...new Set(pick)];
};
/** Walls in two lanes; the free lane moves by at most `step` lanes each row. */
const zigzag = (c: AttackCtx, rows: number, spacing: number, depth: number, step = 1, kind: ObstacleKind = 'corruptBlock'): Row[] => {
  const out: Row[] = [];
  let free = c.rng.pick(others(c.lane));
  for (let i = 0; i < rows; i++) {
    out.push({ at: i * spacing, lanes: others(free), kind, depth });
    const opts = ALL.filter((l) => l !== free && Math.abs(l - free) <= step);
    free = c.rng.pick(opts);
  }
  return out;
};
const full = (kind: ObstacleKind, at: number): Row => ({ at, lanes: [...ALL], kind });

// ------------------------------------------------------------ shared attacks

/** Claws rake two lanes from one side: dodge to the open edge (then the middle). */
const CLAW: AttackDef = {
  anim: 'slam',
  call: 'CLAW SWIPE · DODGE TO THE OPEN SIDE',
  heavy: true,
  rows: (c) => {
    const free = c.rng.pick([0, 2]);
    const out: Row[] = [{ at: 0, lanes: others(free), kind: 'corruptBlock', depth: 3 }];
    if (c.phase >= 1) out.push({ at: 1.15, lanes: others(1), kind: 'corruptBlock', depth: 3 });
    if (c.phase >= 2) out.push({ at: 2.2, lanes: others(2 - free), kind: 'corruptBlock', depth: 3 });
    return out;
  },
};
/** Hard wall in two lanes, fire in the third: move AND jump. */
const WALLSLAM: AttackDef = {
  anim: 'lockdown',
  call: 'WALL SLAM · MOVE, THEN JUMP',
  heavy: true,
  rows: (c) => {
    const free = c.rng.pick(others(c.lane));
    const out: Row[] = [{ at: 0, lanes: others(free), kind: 'corruptBlock', depth: 4 }, { at: 0, lanes: [free], kind: 'firewall' }];
    if (c.phase >= 2) {
      const f2 = c.rng.pick(ALL.filter((l) => Math.abs(l - free) === 1));
      out.push({ at: 1.25, lanes: others(f2), kind: 'corruptBlock', depth: 4 }, { at: 1.25, lanes: [f2], kind: 'firewall' });
    }
    return out;
  },
};
/** Burning lanes: long walls that deny two lanes; the safe zone glows green. */
const BURN: AttackDef = {
  anim: 'flame',
  call: 'BURNING LANES · GET TO THE GREEN SAFE ZONE',
  area: true,
  rows: (c) => zigzag(c, 1 + Math.min(2, c.phase), 1.35, 13),
};
/** Decoys: holograms fill the open lanes. Trust the floor warnings. */
const DECOY: AttackDef = {
  anim: 'glitch',
  call: 'FAKE CODE · ONLY WARNED LANES ARE REAL',
  fx: 'glitch',
  rows: (c) => {
    const out: Row[] = [];
    const n = 1 + Math.min(2, c.phase);
    for (let i = 0; i < n; i++) {
      const real = lanes(c, c.phase >= 1 ? 2 : 1);
      out.push({ at: i * 1.1, lanes: real, kind: 'corruptBlock', depth: 4 });
      out.push({ at: i * 1.1, lanes: ALL.filter((l) => !real.includes(l)), kind: 'corruptBlock', depth: 4, fake: true });
    }
    return out;
  },
};
/** Mirror: controls reversed while walls weave. */
const MIRROR: AttackDef = {
  anim: 'rain',
  call: 'CONTROLS REVERSED · SWIPE THE OTHER WAY',
  fx: 'glitch',
  reverse: true,
  rows: (c) => zigzag(c, 2 + Math.min(1, c.phase), 1.25, 4),
};

// ------------------------------------------------------------ the bosses

export const BOSSES: readonly BossDef[] = [
  {
    id: 'malware',
    name: 'MALWARE BEAST',
    title: 'CORRUPTED SYSTEM ENTITY',
    color: '#ff2a4a',
    accent: '#ff2bd6',
    make: (lib) => new MalwareBeast(lib),
    z: 27,
    scale: 1.55,
    hp: 100,
    intro: 6.2,
    impactAt: 1.0,
    lead: 1.75,
    gap: 2.1,
    phases: [
      { at: 1, label: 'HUNTING', attacks: ['spit', 'claw', 'slam'] },
      { at: 0.62, label: 'FRENZY', attacks: ['claw', 'brood', 'clones', 'spit'] },
      { at: 0.3, label: 'ENRAGED', attacks: ['claw', 'clones', 'slam', 'brood'] },
    ],
    combat: { seqs: [['TTT', 'TLT', 'RTT'], ['TLT', 'RTT', 'TTU', 'LTR'], ['TTU', 'TLRT', 'RTLT', 'TDTU']], special: 'TTLRUT', perStep: 0.62 },
    attacks: {
      claw: CLAW,
      clones: {
        anim: 'brood',
        call: 'VIRUS CLONES · WEAVE BETWEEN LANES',
        rows: (c) => zigzag(c, 3 + c.phase, 0.62 - c.phase * 0.04, 1, 1, 'glitchBug'),
      },
      spit: {
        anim: 'spit',
        call: 'CORRUPT PACKETS · JUMP OR DODGE',
        rows: (c) => [0, 0.85, 1.6].slice(0, 1 + c.phase).map((at) => ({ at, lanes: lanes(c, c.rng.chance(0.5) ? 2 : 1), kind: 'packet' as const })),
      },
      slam: {
        anim: 'slam',
        call: 'SHOCKWAVE · JUMP',
        heavy: true,
        rows: (c) => [full('shock', 0), ...(c.phase >= 1 ? [{ at: 1.0, lanes: lanes(c, 2), kind: 'packet' as const }] : [])],
      },
      brood: {
        anim: 'brood',
        call: 'BUG SWARM · DODGE',
        rows: (c) => [{ at: 0, lanes: lanes(c, c.phase >= 2 ? 2 : 1), kind: 'glitchBug' as const }, { at: 1.1, lanes: lanes(c, 1), kind: 'glitchBug' as const }],
      },
    },
  },
  {
    id: 'firewall',
    name: 'FIREWALL',
    title: 'PERIMETER DEFENSE SYSTEM',
    color: '#ff6a1a',
    accent: '#ffd23a',
    make: (lib) => new FirewallBoss(lib),
    z: 30,
    scale: 1.05,
    hp: 120,
    intro: 6.6,
    impactAt: 2.2,
    lead: 1.7,
    gap: 1.9,
    phases: [
      { at: 1, label: 'SCANNING', attacks: ['flame', 'lockdown', 'wallslam'] },
      { at: 0.65, label: 'LOCKDOWN', attacks: ['burn', 'scan', 'wallslam', 'lockdown'] },
      { at: 0.32, label: 'MELTDOWN', attacks: ['burn', 'scan', 'wallslam', 'flame', 'lockdown'] },
    ],
    combat: { seqs: [['TLT', 'TRT', 'LRT'], ['LRT', 'TRL', 'RLTT', 'TLRT'], ['LRLT', 'RLRT', 'TLRU', 'LTRT']], special: 'LRLRTU', perStep: 0.58 },
    attacks: {
      wallslam: WALLSLAM,
      burn: BURN,
      flame: {
        anim: 'flame',
        call: 'FLAME WALL · JUMP',
        rows: (c) => (c.phase >= 2 ? [full('firewall', 0), full('firewall', 0.9)] : [{ at: 0, lanes: c.phase >= 1 ? [...ALL] : lanes(c, 2), kind: 'firewall' }]),
      },
      lockdown: {
        anim: 'lockdown',
        call: 'LANE LOCKDOWN · MOVE',
        rows: (c) => zigzag(c, 1 + c.phase, 1.0 - c.phase * 0.08, 6),
      },
      scan: {
        anim: 'scan',
        call: 'SCAN LASER · SLIDE',
        heavy: true,
        rows: (c) => [full('laser', 0), ...(c.phase >= 1 ? [{ at: 1.0, lanes: lanes(c, 2), kind: 'firewall' as const }] : []), ...(c.phase >= 2 ? [full('laser', 1.9)] : [])],
      },
    },
  },
  {
    id: 'breaker',
    name: 'CODE BREAKER',
    title: 'ENCRYPTION CRACKER',
    color: '#9a6bff',
    accent: '#00e5ff',
    make: (lib) => new CodeBreaker(lib),
    z: 26,
    scale: 1.5,
    hp: 140,
    intro: 6.4,
    impactAt: 2.3,
    lead: 1.6,
    gap: 1.8,
    phases: [
      { at: 1, label: 'DECRYPTING', attacks: ['slash', 'decoy', 'glitch'] },
      { at: 0.66, label: 'BRUTE FORCE', attacks: ['mirror', 'decoy', 'slash', 'rain'] },
      { at: 0.33, label: 'OVERCLOCKED', attacks: ['mirror', 'decoy', 'slash', 'rain', 'glitch'] },
    ],
    combat: { seqs: [['TLRT', 'RTLT', 'TUTD'], ['TLRT', 'UDTT', 'RLTU', 'TDUT'], ['TLRDT', 'RUTLT', 'LRUDT', 'TTLRT']], special: 'TLRUDTT', perStep: 0.56 },
    attacks: {
      decoy: DECOY,
      mirror: MIRROR,
      slash: {
        anim: 'slash',
        call: 'BLADE SWEEP · SLIDE, THEN JUMP',
        heavy: true,
        rows: (c) => [full('laser', 0), ...(c.phase >= 1 ? [full('shock', 0.95)] : []), ...(c.phase >= 2 ? [full('laser', 1.8)] : [])],
      },
      rain: {
        anim: 'rain',
        call: 'CIPHER RAIN · MOVE',
        rows: (c) => zigzag(c, 2 + c.phase, 0.95, 4.5, c.phase >= 2 ? 2 : 1),
      },
      glitch: {
        anim: 'glitch',
        call: 'GLITCH STRIKE · SLIDE OR DODGE',
        fx: 'teleport',
        rows: (c) => [0, 0.9].slice(0, 1 + Math.min(1, c.phase)).map((at) => ({ at, lanes: lanes(c, 2), kind: 'errorWindow' as const })),
      },
    },
  },
  {
    id: 'crash',
    name: 'SYSTEM CRASH',
    title: 'FATAL EXCEPTION · FINAL BOSS',
    color: '#ff1e3c',
    accent: '#2a6bff',
    make: (lib) => new SystemCrash(lib),
    z: 31,
    scale: 1.15,
    hp: 180,
    intro: 7.4,
    impactAt: 3.2,
    lead: 1.6,
    gap: 1.8,
    phases: [
      { at: 1, label: 'ERROR', attacks: ['storm', 'collapse', 'claw'] },
      { at: 0.72, label: 'CORRUPTION', attacks: ['bluescreen', 'wallslam', 'decoy', 'collapse'] },
      { at: 0.46, label: 'MELTDOWN', attacks: ['mirror', 'burn', 'claw', 'bluescreen', 'storm'] },
      { at: 0.2, label: 'KERNEL PANIC', attacks: ['panic', 'mirror', 'wallslam', 'decoy'] },
    ],
    combat: {
      seqs: [['TLT', 'RTT', 'TTU'], ['TLRT', 'RTLT', 'TTDU'], ['TLRDT', 'LRLTU', 'UTDTR'], ['TLRUT', 'RLUDT', 'TTLRDU']],
      special: 'TLRUDLRT',
      perStep: 0.56,
      weak: [1, 1, 2, 2],
    },
    attacks: {
      claw: { ...CLAW, anim: 'collapse' },
      wallslam: { ...WALLSLAM, anim: 'collapse' },
      burn: { ...BURN, anim: 'storm' },
      decoy: { ...DECOY, anim: 'storm' },
      mirror: { ...MIRROR, anim: 'storm' },
      storm: {
        anim: 'storm',
        call: 'ERROR STORM · SLIDE OR DODGE',
        rows: (c) => [0, 0.85, 1.7].slice(0, 2 + (c.phase >= 2 ? 1 : 0)).map((at) => ({ at, lanes: lanes(c, 2), kind: 'errorWindow' as const })),
      },
      collapse: {
        anim: 'collapse',
        call: 'FLOOR COLLAPSE · MOVE',
        rows: (c) => zigzag(c, 1 + Math.min(2, c.phase), 1.05, 11),
      },
      bluescreen: {
        anim: 'storm',
        call: 'BLUE SCREEN · JUMP, THEN SLIDE',
        fx: 'bluescreen',
        rows: () => [full('shock', 0), full('laser', 0.95)],
      },
      panic: {
        anim: 'collapse',
        call: 'KERNEL PANIC · FINAL ATTACK',
        fx: 'glitch',
        heavy: true,
        rows: (c) => [
          { at: 0, lanes: lanes(c, 2), kind: 'packet' },
          full('laser', 0.8),
          ...zigzag(c, 1, 1, 6).map((r) => ({ ...r, at: 1.6 })),
          full('shock', 2.45),
        ],
      },
    },
  },
];

/** Progress distances (metres of running, boss fights excluded) where bosses attack. */
export const BOSS_AT: readonly number[] = [1050, 2550, 3450, 4450];
/** After the final boss, they come back tougher every this many metres. */
export const BOSS_REPEAT = 1500;
