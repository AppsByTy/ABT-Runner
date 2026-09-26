import * as THREE from 'three';

const COUNT = 80;

/** Streaks rushing past the camera; visible only at higher speeds or on a boost pulse. */
export class SpeedLines {
  private readonly pos = new Float32Array(COUNT * 6);
  private readonly z = new Float32Array(COUNT);
  private readonly x = new Float32Array(COUNT);
  private readonly y = new Float32Array(COUNT);
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.LineBasicMaterial;
  private pulse = 0;

  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(0xbff8ff).multiplyScalar(1.6),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(this.geo, this.mat);
    lines.frustumCulled = false;
    lines.renderOrder = 6;
    scene.add(lines);
    for (let i = 0; i < COUNT; i++) this.respawn(i, -Math.random() * 80);
  }

  private respawn(i: number, z: number): void {
    // Keep the centre (where the player and obstacles are) clear.
    const side = Math.random() < 0.5 ? -1 : 1;
    if (Math.random() < 0.3) {
      this.x[i] = (Math.random() - 0.5) * 14;
      this.y[i] = 4.5 + Math.random() * 3.5;
    } else {
      this.x[i] = side * (3.6 + Math.random() * 6);
      this.y[i] = 0.3 + Math.random() * 6.5;
    }
    this.z[i] = z;
  }

  boost(amount: number): void {
    this.pulse = Math.min(1, this.pulse + amount);
  }

  update(dt: number, speed: number, speedFactor: number, cameraX: number): void {
    this.pulse = Math.max(0, this.pulse - dt * 1.8);
    const vis = Math.max(0, (speedFactor - 0.3) / 0.7) * 0.45 + this.pulse * 0.6;
    this.mat.opacity = vis;
    const len = 1.5 + speed * 0.12;
    const v = speed * 1.7;
    for (let i = 0; i < COUNT; i++) {
      this.z[i] += v * dt;
      if (this.z[i] > 10) this.respawn(i, -70 - Math.random() * 20);
      const x = this.x[i] + cameraX;
      const o = i * 6;
      this.pos[o] = this.pos[o + 3] = x;
      this.pos[o + 1] = this.pos[o + 4] = this.y[i];
      this.pos[o + 2] = this.z[i];
      this.pos[o + 5] = this.z[i] - len;
    }
    this.geo.getAttribute('position').needsUpdate = true;
  }
}
