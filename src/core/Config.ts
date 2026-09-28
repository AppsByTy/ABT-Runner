/**
 * Central tuning values. Everything gameplay-feel related lives here so it can
 * be tweaked (or later exposed to a debug panel / remote config) in one place.
 */
export const CONFIG = {
  lanes: {
    count: 3,
    width: 2.6,
  },

  speed: {
    start: 15,
    max: 40,
    /** Distance (m) over which speed approaches max (exponential ease). */
    rampDistance: 3300,
    /** Fraction of speed lost when taking a hit. */
    hitPenalty: 0.22,
  },

  player: {
    height: 1.8,
    slideHeight: 0.75,
    width: 0.7,
    depth: 0.6,
    /** Target jump apex height in world units. Kept constant as speed rises. */
    jumpHeight: 2.0,
    /** Base gravity; scaled up with speed so jumps stay snappy at high speed. */
    gravity: 36,
    gravitySpeedScale: 0.45,
    fastFallVelocity: -30,
    slideDuration: 0.72,
    /** Seconds to settle into a new lane (exponential smoothing time constant). */
    laneChangeTime: 0.055,
    /** Jump pressed shortly before landing still fires on landing. */
    jumpBuffer: 0.15,
    /** Front hits with less x-penetration than this while changing lanes are grazes (less damage). */
    grazeTolerance: 0.55,
    /** Invulnerability after taking a hit. */
    hitInvuln: 1.3,
    /** Lane change time multiplier while RAM BOOST is active. */
    ramLaneFactor: 0.6,
  },

  spawn: {
    /** How far ahead of the player content is generated. */
    aheadDistance: 160,
    /** How far behind the player content is recycled. */
    despawnBehind: 14,
    /** Empty runway at the start of a run. */
    startRunway: 55,
    /** Seconds between obstacle rows at difficulty 0 and 1. */
    rowIntervalEasy: 1.3,
    rowIntervalHard: 0.74,
    /** Distance (m) at which difficulty reaches 1. */
    difficultyDistance: 4200,
  },

  track: {
    segmentLength: 24,
    segmentCount: 9,
  },

  coin: {
    spacing: 2.3,
    pickupRadiusXZ: 1.05,
    pickupRadiusY: 1.3,
    score: 5,
  },

  camera: {
    fov: 62,
    fovSpeedBoost: 10,
    offset: { x: 0, y: 3.0, z: 5.7 },
    lookAhead: 7,
    lookHeight: 1.1,
    followX: 0.85,
    followY: 0.35,
    smoothing: 10,
  },

  combo: {
    /** Seconds without a scoring action before the DEBUG COMBO drops. */
    window: 3.4,
    /** Combo count needed for each multiplier tier. */
    tiers: [
      [0, 1],
      [5, 2],
      [12, 3],
      [25, 5],
      [45, 10],
    ] as readonly (readonly [number, number])[],
    points: { clear: 1, dodge: 1, nearMiss: 2, bugFix: 1, badBug: 1, patch: 1 },
    /** Coins / code top up the combo timer by this much. */
    coinKeepAlive: 0.3,
  },

  health: {
    max: 100,
    hit: 20,
    graze: 10,
    bugFix: 5,
    patch: 10,
    boss: 30,
  },

  score: {
    coin: 10,
    code: 25,
    chip: 100,
    xpFile: 50,
    bugFix: 250,
    patch: 50,
    power: 200,
    clear: 20,
    nearMiss: 100,
    badBugFixed: 300,
    deleted: 150,
    bossPatch: 300,
    boss: 5000,
  },

  xp: {
    bugFix: 10,
    xpFile: 50,
    chip: 5,
    power: 5,
    boss: 200,
    badBugFixed: 15,
  },

  nearMiss: {
    /** Horizontal gap (m) between hitboxes that counts as a near miss. */
    lateralGap: 0.55,
    /** Vertical clearance (m) over a hurdle / under a bar that counts as a near miss. */
    verticalClearance: 0.3,
    /** Leaving an obstacle's lane this recently before it arrives counts as a dodge. */
    dodgeWindow: 0.9,
    /** ...and this recently counts as a last-second near miss. */
    lateDodge: 0.25,
    /** Jumping / sliding this soon before an obstacle arrives counts as a near miss. */
    lateAction: 0.16,
  },

  sim: {
    fixedStep: 1 / 120,
    maxSubSteps: 10,
  },
} as const;

export const LANE_X: readonly number[] = [-CONFIG.lanes.width, 0, CONFIG.lanes.width];
