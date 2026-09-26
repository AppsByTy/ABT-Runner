import * as THREE from 'three';
import { glyphAtlas } from '../world/Atlases';

/** Sprite shapes drawn procedurally in the fragment shader. */
export const Shape = { Orb: 0, Spark: 1, Shard: 2, Glyph: 3, Pixel: 4, Streak: 5 } as const;
export type ShapeId = (typeof Shape)[keyof typeof Shape];

export interface BurstOptions {
  count: number;
  color: THREE.ColorRepresentation | THREE.ColorRepresentation[];
  speed: [number, number];
  /** Emission direction bias (normalised internally); omit for a sphere. */
  dir?: [number, number, number];
  spread?: number;
  life: [number, number];
  size: [number, number];
  gravity?: number;
  drag?: number;
  /** Scroll with the road (true) or stay with the camera/player frame (false). */
  world?: boolean;
  jitter?: number;
  /** One shape or a list to cycle through. */
  shape?: ShapeId | readonly ShapeId[];
  /** Spin speed (rad/s) for shards / pixels. */
  spin?: number;
  /** Optional attraction targets (flat xyz array); particle i homes to target i % n. */
  home?: Float32Array | number[];
  /** Seconds before homing kicks in. */
  homeDelay?: number;
  /** Spring stiffness toward home. */
  homeK?: number;
}

/**
 * Pooled GPU sprite system for every spark, shard, glyph and fragment.
 * One draw call per system. Shapes (glow orb, star sparkle, faceted shard,
 * code glyph, glitch pixel, velocity streak) are drawn in the shader, so
 * nothing looks like a plain circle. Particles can home onto target shapes
 * (the bug-fix checkmark assembles out of its own burst).
 */
export class Particles {
  readonly points: THREE.Points;
  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly shape: Float32Array;
  private readonly rot: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly spin: Float32Array;
  private readonly home: Float32Array;
  private readonly homeK: Float32Array;
  private readonly homeDelay: Float32Array;
  private readonly world: Uint8Array;
  private next = 0;
  /** Particle budget scale from graphics quality (0.3 .. 1). */
  density = 1;
  private readonly geo: THREE.BufferGeometry;
  private readonly tmpColor = new THREE.Color();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpBias = new THREE.Vector3();
  readonly material: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, max = 1400, dark = false) {
    this.max = max;
    const f = (n: number) => new Float32Array(max * n);
    this.pos = f(3);
    this.col = f(3);
    this.size = f(1);
    this.alpha = f(1);
    this.shape = f(1);
    this.rot = f(1);
    this.vel = f(3);
    this.life = f(1);
    this.maxLife = f(1);
    this.baseSize = f(1);
    this.grav = f(1);
    this.drag = f(1);
    this.spin = f(1);
    this.home = f(3);
    this.homeK = f(1);
    this.homeDelay = f(1);
    this.world = new Uint8Array(max);

    this.geo = new THREE.BufferGeometry();
    const attr = (arr: Float32Array, n: number) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geo.setAttribute('position', attr(this.pos, 3));
    this.geo.setAttribute('aColor', attr(this.col, 3));
    this.geo.setAttribute('aSize', attr(this.size, 1));
    this.geo.setAttribute('aAlpha', attr(this.alpha, 1));
    this.geo.setAttribute('aShape', attr(this.shape, 1));
    this.geo.setAttribute('aRot', attr(this.rot, 1));
    this.geo.setAttribute('aVel', attr(this.vel, 3));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 }, uGlyphs: { value: glyphAtlas() } },
      defines: dark ? { DARK: 1 } : {},
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aShape;
        attribute float aRot;
        attribute vec3 aVel;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vShape;
        varying float vRot;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vShape = aShape;
          vRot = aRot;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float s = aSize;
          if (aShape > 4.5) {
            // Streak: orient along the projected velocity, lengthen with speed.
            vec4 a = projectionMatrix * mv;
            vec4 b = projectionMatrix * (modelViewMatrix * vec4(position + aVel * 0.04, 1.0));
            vec2 d = b.xy / b.w - a.xy / a.w;
            vRot = atan(d.y, d.x);
            s *= 1.0 + min(length(aVel) * 0.12, 2.5);
          }
          gl_PointSize = s * uScale / max(-mv.z, 0.5);
          gl_Position = projectionMatrix * mv;
          if (aAlpha <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uGlyphs;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vShape;
        varying float vRot;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          c.y = -c.y;
          float cr = cos(vRot), sr = sin(vRot);
          vec2 r = vec2(cr * c.x + sr * c.y, -sr * c.x + cr * c.y);
          float d = length(c);
          float a;
          vec3 col = vColor;
          if (vShape < 0.5) {
            // Glow orb with a hot core.
            a = smoothstep(0.5, 0.0, d);
            a *= a;
            col *= 1.0 + 2.2 * smoothstep(0.18, 0.0, d);
          } else if (vShape < 1.5) {
            // Four-point star sparkle with a thin diagonal glint.
            vec2 q = abs(r);
            float arm = max(smoothstep(0.05, 0.0, q.y) * smoothstep(0.5, 0.0, q.x), smoothstep(0.05, 0.0, q.x) * smoothstep(0.5, 0.0, q.y));
            vec2 q2 = abs(vec2(r.x + r.y, r.x - r.y) * 0.7071);
            float diag = max(smoothstep(0.03, 0.0, q2.y) * smoothstep(0.3, 0.0, q2.x), smoothstep(0.03, 0.0, q2.x) * smoothstep(0.3, 0.0, q2.y)) * 0.5;
            float core = smoothstep(0.2, 0.0, d);
            a = max(max(arm, diag), core * core);
            col *= 1.0 + 2.8 * core;
          } else if (vShape < 2.5) {
            // Faceted crystal shard: diamond with a lit and a shaded facet.
            vec2 q = abs(r) * vec2(2.4, 1.0);
            float dd = q.x + q.y;
            a = smoothstep(0.5, 0.44, dd);
            float facet = r.x > 0.0 ? 1.25 : 0.55;
            col *= facet * (0.9 + 1.4 * smoothstep(0.35, 0.0, dd));
          } else if (vShape < 3.5) {
            // Code glyph from the atlas (vRot carries the glyph index).
            vec2 uv = clamp(c * 1.15 + 0.5, 0.0, 1.0);
            vec2 cell = vec2(mod(vRot, 4.0), floor(mod(vRot, 16.0) / 4.0)) / 4.0;
            a = texture2D(uGlyphs, cell + vec2(uv.x, 1.0 - uv.y) / 4.0).r;
            col *= 1.7;
          } else if (vShape < 4.5) {
            // Glitch pixel: hard square with a bright scan edge.
            vec2 q = abs(r);
            float m = max(q.x, q.y);
            a = step(m, 0.34);
            col *= 1.0 + step(0.27, m) * 0.9 + step(0.0, r.y) * 0.25;
          } else {
            // Velocity streak.
            float dd = length(r * vec2(1.0, 6.0));
            a = smoothstep(0.5, 0.0, dd);
            col *= 1.0 + 2.0 * smoothstep(0.2, 0.0, dd);
          }
          gl_FragColor = vec4(col, a * vAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = dark ? 4 : 5;
    scene.add(this.points);
  }

  setViewportHeight(px: number): void {
    this.material.uniforms.uScale.value = px * 0.5;
  }

  burst(x: number, y: number, z: number, o: BurstOptions): void {
    const colors = Array.isArray(o.color) ? o.color : [o.color];
    const shapes: readonly number[] = o.shape === undefined ? [Shape.Orb] : typeof o.shape === 'number' ? [o.shape] : o.shape;
    const spread = o.spread ?? 1;
    const bias = o.dir ? this.tmpBias.set(...o.dir).normalize() : null;
    const home = o.home;
    const homeN = home ? home.length / 3 : 0;
    // Homing bursts must keep every particle (they draw a shape).
    const count = home ? o.count : Math.max(1, Math.round(o.count * this.density));
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const j = o.jitter ?? 0;
      this.pos[i * 3] = x + (Math.random() - 0.5) * j;
      this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * j;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * j;
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      this.tmpDir.set(r * Math.cos(t), u, r * Math.sin(t));
      if (bias) this.tmpDir.multiplyScalar(spread).add(bias).normalize();
      const sp = o.speed[0] + Math.random() * (o.speed[1] - o.speed[0]);
      this.vel[i * 3] = this.tmpDir.x * sp;
      this.vel[i * 3 + 1] = this.tmpDir.y * sp;
      this.vel[i * 3 + 2] = this.tmpDir.z * sp;
      this.tmpColor.set(colors[n % colors.length]);
      this.col[i * 3] = this.tmpColor.r;
      this.col[i * 3 + 1] = this.tmpColor.g;
      this.col[i * 3 + 2] = this.tmpColor.b;
      const life = o.life[0] + Math.random() * (o.life[1] - o.life[0]);
      this.life[i] = this.maxLife[i] = life;
      this.baseSize[i] = o.size[0] + Math.random() * (o.size[1] - o.size[0]);
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
      this.world[i] = o.world === false ? 0 : 1;
      const sh = shapes[n % shapes.length];
      this.shape[i] = sh;
      this.rot[i] = sh === Shape.Glyph ? Math.floor(Math.random() * 16) : Math.random() * Math.PI * 2;
      this.spin[i] = sh === Shape.Glyph ? 0 : (o.spin ?? 0) * (Math.random() - 0.5) * 2;
      if (home && homeN > 0) {
        const h = n % homeN;
        this.home[i * 3] = home[h * 3];
        this.home[i * 3 + 1] = home[h * 3 + 1];
        this.home[i * 3 + 2] = home[h * 3 + 2];
        this.homeK[i] = o.homeK ?? 60;
        this.homeDelay[i] = o.homeDelay ?? 0.1;
      } else {
        this.homeK[i] = 0;
      }
    }
  }

  /** @param scroll world distance travelled this frame (moves world-locked particles toward the camera). */
  update(dt: number, scroll: number): void {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const i3 = i * 3;
      const sc = this.world[i] ? scroll : 0;
      if (this.homeK[i] > 0) {
        this.home[i3 + 2] += sc;
        const age = this.maxLife[i] - this.life[i];
        if (age > this.homeDelay[i]) {
          // Critically damped spring onto the target shape.
          const k = this.homeK[i];
          const damp = Math.max(0, 1 - 2 * Math.sqrt(k) * dt);
          for (let a = 0; a < 3; a++) this.vel[i3 + a] = this.vel[i3 + a] * damp + (this.home[i3 + a] - this.pos[i3 + a]) * k * dt;
        }
      } else {
        const k = Math.max(0, 1 - this.drag[i] * dt);
        this.vel[i3] *= k;
        this.vel[i3 + 1] = this.vel[i3 + 1] * k - this.grav[i] * dt;
        this.vel[i3 + 2] *= k;
      }
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt + sc;
      if (this.pos[i3 + 1] < 0.02) {
        this.pos[i3 + 1] = 0.02;
        this.vel[i3 + 1] *= -0.35;
      }
      this.rot[i] += this.spin[i] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = Math.min(1, t * 2.2);
      // Homing particles hold their size so the formed shape stays crisp.
      this.size[i] = this.baseSize[i] * (this.homeK[i] > 0 ? Math.min(1, t * 3) : 0.4 + 0.6 * t);
    }
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha', 'aShape', 'aRot', 'aVel']) this.geo.getAttribute(name).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
  }
}
