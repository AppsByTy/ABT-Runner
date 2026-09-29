import * as THREE from 'three';
import { CONFIG, LANE_X } from '../core/Config';
import { THEME } from '../core/Theme';

/**
 * Floor telegraphs for boss attacks: a glowing strip in the lane where a
 * hazard is about to land, shown before it materialises so every attack can
 * be read in time. Colour + pattern say what to do:
 *   red, hazard stripes  - get out of this lane
 *   gold, chevrons       - jump
 *   cyan, bars           - slide
 */
export type WarnKind = 'move' | 'jump' | 'slide';

const COLORS: Record<WarnKind, string> = { move: '#ff2a4a', jump: '#ffd23a', slide: '#00e5ff' };
const KIND_ID: Record<WarnKind, number> = { move: 0, jump: 1, slide: 2 };
const LENGTH = 9;

interface Warn {
  mesh: THREE.Mesh;
  u: { uColor: { value: THREE.Color }; uKind: { value: number }; uAlpha: { value: number }; uTime: { value: number } };
  dist: number;
  age: number;
  active: boolean;
}

export class LaneWarnings {
  private readonly pool: Warn[] = [];

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(CONFIG.lanes.width * 0.92, LENGTH).rotateX(-Math.PI / 2);
    for (let i = 0; i < 14; i++) {
      const u = { uColor: { value: new THREE.Color() }, uKind: { value: 0 }, uAlpha: { value: 0 }, uTime: THEME.uTime };
      const mesh = new THREE.Mesh(
        geo,
        new THREE.ShaderMaterial({
          uniforms: u,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
          fragmentShader: /* glsl */ `
            uniform vec3 uColor; uniform float uKind; uniform float uAlpha; uniform float uTime;
            varying vec2 vUv;
            void main() {
              vec2 p = vUv;
              float border = smoothstep(0.06, 0.0, min(p.x, 1.0 - p.x)) * 0.9;
              float pat;
              if (uKind < 0.5) {
                // Hazard stripes.
                pat = step(0.5, fract((p.x + p.y * 4.0) * 3.0 - uTime * 1.5));
              } else if (uKind < 1.5) {
                // Chevrons pointing at the hazard (jump).
                float y = fract(p.y * 5.0 + abs(p.x - 0.5) * 1.6 - uTime * 2.2);
                pat = smoothstep(0.0, 0.1, y) * smoothstep(0.35, 0.25, y);
              } else {
                // Low bars (slide under).
                float y = fract(p.y * 7.0 - uTime * 2.2);
                pat = smoothstep(0.0, 0.08, y) * smoothstep(0.3, 0.22, y);
              }
              float fade = smoothstep(0.0, 0.25, p.y) * smoothstep(1.0, 0.8, p.y);
              float pulse = 0.7 + 0.3 * sin(uTime * 14.0);
              gl_FragColor = vec4(uColor * (pat * 0.8 + border + 0.12) * fade * pulse * uAlpha, 1.0);
            }`,
        }),
      );
      mesh.position.y = 0.035;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.pool.push({ mesh, u, dist: 0, age: 0, active: false });
    }
  }

  /** Mark `lane` from where a hazard will stand (`dist`) back toward the runner. */
  show(lane: number, dist: number, kind: WarnKind): void {
    const w = this.pool.find((x) => !x.active) ?? this.pool.reduce((a, x) => (x.dist < a.dist ? x : a));
    w.active = true;
    w.dist = dist;
    w.age = 0;
    w.u.uColor.value.set(COLORS[kind]).multiplyScalar(1.6);
    w.u.uKind.value = KIND_ID[kind];
    w.mesh.position.x = LANE_X[lane];
    w.mesh.visible = true;
  }

  update(distance: number, dt: number): void {
    for (const w of this.pool) {
      if (!w.active) continue;
      w.age += dt;
      const ahead = w.dist - distance;
      // The strip ends at the hazard and reaches toward the runner.
      w.mesh.position.z = -ahead + LENGTH / 2;
      const inA = Math.min(1, w.age / 0.15);
      const out = Math.min(1, Math.max(0, ahead / 6));
      w.u.uAlpha.value = inA * out;
      if (ahead < -2) {
        w.active = false;
        w.mesh.visible = false;
      }
    }
  }

  clear(): void {
    for (const w of this.pool) {
      w.active = false;
      w.mesh.visible = false;
    }
  }
}
