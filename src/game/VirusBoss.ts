import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LANE_X } from '../core/Config';
import { events } from '../core/EventBus';
import { GLSL_HASH, THEME } from '../core/Theme';

export type BossPhase = 'idle' | 'intro' | 'active' | 'deleted' | 'escaped';

/** Distances at which THE VIRUS attacks; after the list, every `repeat` m. */
const SCHEDULE = [1350, 3000, 4700];
const REPEAT = 1700;

/**
 * THE VIRUS: a giant corrupted creature that hovers over the data streams
 * and drops corrupt packets. It is not fought directly: the player survives
 * the sequence and collects security patches until the system patch hits 100%.
 */
export class VirusBoss {
  readonly root = new THREE.Group();
  phase: BossPhase = 'idle';
  progress = 0;
  needed = 6;
  timeLeft = 0;
  count = 0;
  private phaseT = 0;
  private nextAt = SCHEDULE[0];
  private x = 0;
  private hurt = 0;
  private dist = 0;
  private readonly body: THREE.Mesh;
  private readonly spikes: THREE.Mesh;
  private readonly eye: THREE.Mesh;
  private readonly pupil: THREE.Mesh;
  private readonly rings: THREE.Mesh[] = [];
  private readonly tentacles: THREE.Mesh[] = [];
  private readonly uniforms = { uTime: THEME.uTime, uHurt: { value: 0 }, uDissolve: { value: 0 } };

  constructor(scene: THREE.Scene) {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uDissolve;
        varying vec3 vN;
        varying vec3 vP;
        ${GLSL_HASH}
        void main() {
          vN = normalize(normalMatrix * normal);
          vP = position;
          vec3 p = position;
          // Pulsing lumpy membrane + glitch slices.
          float w = sin(p.x * 3.0 + uTime * 3.0) * sin(p.y * 2.5 - uTime * 2.0) * sin(p.z * 3.5 + uTime * 2.5);
          p += normal * w * 0.35;
          float slice = floor(p.y * 5.0);
          p.x += step(0.9, hash12(vec2(slice, floor(uTime * 12.0)))) * 0.5;
          p *= 1.0 + uDissolve * 0.6;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uHurt;
        uniform float uDissolve;
        varying vec3 vN;
        varying vec3 vP;
        ${GLSL_HASH}
        void main() {
          float fres = pow(1.0 - abs(vN.z), 2.0);
          float veins = smoothstep(0.45, 0.5, vnoise(vP.xy * 2.0 + uTime * 0.4) * vnoise(vP.yz * 2.5 - uTime * 0.3) * 2.0);
          vec3 col = mix(vec3(0.08, 0.0, 0.02), vec3(0.35, 0.0, 0.08), fres);
          col += veins * vec3(1.0, 0.15, 0.3) * 1.2;
          col += fres * vec3(0.2, 1.0, 0.4) * 0.8;
          col = mix(col, vec3(1.0), uHurt * 0.7);
          if (hash12(floor(vP.xy * 12.0) + floor(uTime * 20.0)) < uDissolve) discard;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.body = new THREE.Mesh(new THREE.IcosahedronGeometry(3.2, 4), mat);
    this.root.add(this.body);

    const spikeParts: THREE.BufferGeometry[] = [];
    const ico = new THREE.IcosahedronGeometry(1, 1);
    const pos = ico.getAttribute('position');
    const up = new THREE.Vector3(0, 1, 0);
    const seen = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
      const k = v.toArray().map((n) => n.toFixed(2)).join();
      if (seen.has(k)) continue;
      seen.add(k);
      const c = new THREE.ConeGeometry(0.28, 1.7, 5).translate(0, 3.6, 0);
      c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, v));
      spikeParts.push(c);
    }
    this.spikes = new THREE.Mesh(mergeGeometries(spikeParts)!, new THREE.MeshBasicMaterial({ color: new THREE.Color('#39ff6a').multiplyScalar(1.6) }));
    this.root.add(this.spikes);

    this.eye = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffe8ea').multiplyScalar(1.2) }));
    this.eye.position.set(0, 0.2, 2.6);
    this.pupil = new THREE.Mesh(new THREE.SphereGeometry(0.65, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff1133').multiplyScalar(2.6) }));
    this.pupil.position.set(0, 0, 0.85);
    this.eye.add(this.pupil);
    this.root.add(this.eye);

    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(
        new THREE.TorusGeometry(5 + i * 0.9, 0.08, 6, 64),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(i === 1 ? '#39ff6a' : '#ff2255').multiplyScalar(1.8) }),
      );
      this.rings.push(r);
      this.root.add(r);
    }
    // Tentacles made of corrupted code cubes.
    for (let i = 0; i < 6; i++) {
      const cubes: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 7; k++) cubes.push(new THREE.BoxGeometry(0.5 - k * 0.05, 0.5 - k * 0.05, 0.5 - k * 0.05).translate(0, -3.2 - k * 0.7, 0));
      const t = new THREE.Mesh(mergeGeometries(cubes)!, new THREE.MeshBasicMaterial({ color: new THREE.Color(i % 2 ? '#ff2255' : '#8a0a2a').multiplyScalar(1.4) }));
      t.rotation.z = (i - 2.5) * 0.35;
      this.tentacles.push(t);
      this.root.add(t);
    }

    this.root.visible = false;
    this.root.traverse((c) => (c.frustumCulled = false));
    scene.add(this.root);
  }

  reset(): void {
    this.phase = 'idle';
    this.phaseT = 0;
    this.progress = 0;
    this.count = 0;
    this.nextAt = SCHEDULE[0];
    this.root.visible = false;
    this.uniforms.uDissolve.value = 0;
  }

  get fighting(): boolean {
    return this.phase === 'intro' || this.phase === 'active';
  }

  update(dt: number, distance: number, playerX: number, lane: number): void {
    this.phaseT += dt;
    this.dist = distance;
    this.hurt = Math.max(0, this.hurt - dt * 3);
    this.uniforms.uHurt.value = this.hurt;

    switch (this.phase) {
      case 'idle':
        if (distance >= this.nextAt) this.begin();
        break;
      case 'intro':
        if (this.phaseT > 2.4) {
          this.phase = 'active';
          this.phaseT = 0;
          events.emit('bossActive');
        }
        break;
      case 'active':
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.phase = 'escaped';
          this.phaseT = 0;
          events.emit('bossEscaped');
        }
        break;
      case 'deleted':
        this.uniforms.uDissolve.value = Math.min(1, this.phaseT / 1.4);
        if (this.phaseT > 1.6) this.finish();
        break;
      case 'escaped':
        if (this.phaseT > 2.2) this.finish();
        break;
    }
    if (!this.root.visible) return;

    // Hover above the streams, drifting toward the player's lane.
    const tx = (LANE_X[lane] + playerX) * 0.5 * 0.7;
    this.x += (tx - this.x) * Math.min(1, dt * 1.2);
    const introT = this.phase === 'intro' ? Math.min(1, this.phaseT / 1.6) : 1;
    const e = 1 - Math.pow(1 - introT, 3);
    const leave = this.phase === 'escaped' ? Math.min(1, this.phaseT / 2) : 0;
    const t = THEME.uTime.value;
    this.root.position.set(this.x, 9 + Math.sin(t * 1.3) * 0.8 + (1 - e) * 25 + leave * 30, -52 - leave * 60);
    this.root.rotation.z = Math.sin(t * 0.8) * 0.12;
    this.body.rotation.y = t * 0.3;
    this.spikes.rotation.set(t * 0.2, t * 0.5, 0);
    this.rings.forEach((r, i) => r.rotation.set(Math.PI / 2 + Math.sin(t * 0.7 + i) * 0.5, t * (0.4 + i * 0.3) * (i % 2 ? -1 : 1), 0));
    this.tentacles.forEach((tt, i) => (tt.rotation.x = Math.sin(t * 2 + i) * 0.35));
    // The eye tracks the player.
    this.pupil.position.x = Math.max(-0.4, Math.min(0.4, (playerX - this.x) * 0.1));
    this.pupil.position.y = -0.35;
    const s = this.phase === 'deleted' ? 1 + this.phaseT * 0.4 : 1 + this.hurt * 0.08;
    this.root.scale.setScalar(s);
  }

  private begin(): void {
    this.phase = 'intro';
    this.phaseT = 0;
    this.progress = 0;
    this.needed = 6 + Math.min(4, this.count);
    this.timeLeft = 34 + this.needed * 1.5;
    this.root.visible = true;
    this.uniforms.uDissolve.value = 0;
    events.emit('bossStart', { name: 'THE VIRUS', needed: this.needed });
  }

  /** A security patch landed. */
  patch(): void {
    if (this.phase !== 'active') return;
    this.progress = Math.min(this.needed, this.progress + 1);
    this.hurt = 1;
    events.emit('bossPatched', { progress: this.progress, needed: this.needed });
    if (this.progress >= this.needed) {
      this.phase = 'deleted';
      this.phaseT = 0;
      events.emit('bossDeleted');
    }
  }

  private finish(): void {
    this.phase = 'idle';
    this.phaseT = 0;
    this.count++;
    this.root.visible = false;
    // Always leave a decent stretch of normal running before the next attack.
    this.nextAt = Math.max(SCHEDULE[this.count] ?? this.dist + REPEAT, this.dist + 800);
    events.emit('bossEnd');
  }

  /** World position of the virus mouth, for drop beams. */
  get mouth(): THREE.Vector3 {
    return this.root.position;
  }
}
