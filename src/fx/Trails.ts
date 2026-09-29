import * as THREE from 'three';

const SAMPLES = 12;

/** Shared by both sneaker trails: the shop's trail style (colour or RGB cycle). */
export const TRAIL_STYLE = {
  uColor: { value: new THREE.Color('#ff2bd6').multiplyScalar(1.4) },
  uRainbow: { value: 0 },
  uTime: { value: 0 },
};

/** Shop trail style. Uniforms only, so it never rebuilds the shader. */
export function setTrailStyle(color: THREE.ColorRepresentation, rainbow = false): void {
  TRAIL_STYLE.uColor.value.set(color).multiplyScalar(1.4);
  TRAIL_STYLE.uRainbow.value = rainbow ? 1 : 0;
}

/**
 * Glowing ribbon trail behind one sneaker. Samples are world-locked: every
 * frame they scroll toward the camera with the road, so the trail stretches
 * with speed exactly like a real light streak.
 */
export class Trail {
  private readonly pts: THREE.Vector3[] = [];
  private readonly geo = new THREE.BufferGeometry();
  private readonly posArr = new Float32Array(SAMPLES * 2 * 3);
  private readonly alphaArr = new Float32Array(SAMPLES * 2);
  private count = 0;
  readonly mesh: THREE.Mesh;
  /** 0..1 overall visibility (fades out on death / menu). */
  intensity = 0;

  constructor(scene: THREE.Scene, width = 0.11) {
    this.width = width;
    for (let i = 0; i < SAMPLES; i++) this.pts.push(new THREE.Vector3());
    const idx: number[] = [];
    for (let i = 0; i < SAMPLES - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphaArr, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: TRAIL_STYLE,
      vertexShader: 'attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uColor; uniform float uRainbow; uniform float uTime; varying float vA;
        vec3 hue(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
        void main(){
          vec3 rgb = hue(fract(uTime * 0.45 + gl_FragCoord.y * 0.0025 + gl_FragCoord.x * 0.001)) * 1.5;
          gl_FragColor = vec4(mix(uColor, rgb, uRainbow), vA);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
  }

  private readonly width: number;

  reset(): void {
    this.count = 0;
    this.intensity = 0;
    this.geo.setDrawRange(0, 0);
  }

  update(head: THREE.Vector3, scroll: number): void {
    for (let i = 0; i < this.count; i++) this.pts[i].z += scroll;
    // Shift and insert newest sample at index 0.
    const last = this.pts.pop()!;
    this.pts.unshift(last.copy(head));
    this.count = Math.min(SAMPLES, this.count + 1);

    const hw = this.width / 2;
    for (let i = 0; i < this.count; i++) {
      const p = this.pts[i];
      const t = i / (SAMPLES - 1);
      const w = hw * (1 - t * 0.7);
      const o = i * 6;
      this.posArr[o] = p.x - w;
      this.posArr[o + 1] = p.y;
      this.posArr[o + 2] = p.z;
      this.posArr[o + 3] = p.x + w;
      this.posArr[o + 4] = p.y;
      this.posArr[o + 5] = p.z;
      const a = (1 - t) * (1 - t) * this.intensity * 0.6;
      this.alphaArr[i * 2] = this.alphaArr[i * 2 + 1] = a;
    }
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('aAlpha').needsUpdate = true;
    this.geo.setDrawRange(0, Math.max(0, this.count - 1) * 6);
  }
}
