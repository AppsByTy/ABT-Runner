/**
 * Graphics quality presets. Everything that costs GPU time reads from here.
 * The default is HIGH everywhere (quality first); if a run can't hold its
 * frame rate the game steps down automatically and remembers it.
 */
export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  /** Max device pixel ratio. */
  pixelRatio: number;
  post: boolean;
  bloom: boolean;
  /** Half-res bloom (true) or quarter (false). */
  bloomHalf: boolean;
  motionBlur: boolean;
  dof: boolean;
  shadows: boolean;
  shadowSize: number;
  /** Planar mirror reflections on the data streams. */
  reflections: boolean;
  reflectionScale: number;
  msaa: number;
  /** Particle count multiplier. */
  particles: number;
  /** Environment density multiplier (instances, props). */
  detail: number;
  /** Volumetric light shafts + dust. */
  volumetrics: boolean;
  /** Film grain / lens effects. */
  lens: boolean;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low', pixelRatio: 1, post: false, bloom: false, bloomHalf: false, motionBlur: false, dof: false,
    shadows: false, shadowSize: 512, reflections: false, reflectionScale: 0.25, msaa: 0, particles: 0.4, detail: 0.55, volumetrics: false, lens: false,
  },
  medium: {
    level: 'medium', pixelRatio: 1.25, post: true, bloom: true, bloomHalf: false, motionBlur: false, dof: false,
    shadows: false, shadowSize: 1024, reflections: false, reflectionScale: 0.25, msaa: 0, particles: 0.7, detail: 0.8, volumetrics: true, lens: false,
  },
  high: {
    level: 'high', pixelRatio: 1.6, post: true, bloom: true, bloomHalf: true, motionBlur: true, dof: true,
    shadows: true, shadowSize: 1024, reflections: true, reflectionScale: 0.3, msaa: 2, particles: 1, detail: 1, volumetrics: true, lens: true,
  },
  ultra: {
    level: 'ultra', pixelRatio: 2, post: true, bloom: true, bloomHalf: true, motionBlur: true, dof: true,
    shadows: true, shadowSize: 2048, reflections: true, reflectionScale: 0.5, msaa: 4, particles: 1.3, detail: 1.25, volumetrics: true, lens: true,
  },
};

export const LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

/**
 * Graphics always run at the top tier. There is no user-facing setting and
 * no automatic downgrade for performance. `?quality=` exists for testing.
 */
export function loadQuality(): QualityLevel {
  const param = new URLSearchParams(location.search).get('quality');
  if (param && (LEVELS as readonly string[]).includes(param)) return param as QualityLevel;
  return 'ultra';
}
