export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export const makeAABB = (): AABB => ({ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });

export const overlapX = (a: AABB, b: AABB): boolean => a.minX < b.maxX && a.maxX > b.minX;
export const overlapY = (a: AABB, b: AABB): boolean => a.minY < b.maxY && a.maxY > b.minY;
export const overlapZ = (a: AABB, b: AABB): boolean => a.minZ < b.maxZ && a.maxZ > b.minZ;
export const overlaps = (a: AABB, b: AABB): boolean => overlapX(a, b) && overlapY(a, b) && overlapZ(a, b);
