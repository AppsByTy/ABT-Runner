import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { THEME } from '../core/Theme';
import type { QualitySettings } from '../render/Quality';

/**
 * Cinematic post chain, scaled by quality:
 *   scene -> [depth of field] -> bloom -> final (motion blur, glitch, chromatic
 *   aberration, tint, vignette, grain, beat pulse) -> output
 */
export class PostFX {
  readonly enabled: boolean;
  private composer?: EffectComposer;
  private bloom?: UnrealBloomPass;
  private bokeh?: BokehPass;
  private final?: ShaderPass;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly q: QualitySettings;

  aberrationPulse = 0;
  glitchPulse = 0;
  private flashColor = new THREE.Color();
  private flash = 0;
  readonly tint = new THREE.Color(0, 0, 0);
  tintAmount = 0;
  danger = 0;
  hype = 0;
  readonly hypeColor = new THREE.Color('#b4ff1e');
  /** 0..1 radial motion blur (speed, boosts). */
  motion = 0;
  /** 0..1 depth-of-field amount; focus distance in world units. */
  dof = 0;
  focus = 4;
  motionBlurOn: boolean;
  dofOn: boolean;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, quality: QualitySettings) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.q = quality;
    this.enabled = quality.post;
    this.motionBlurOn = quality.motionBlur;
    this.dofOn = quality.dof;
    if (!this.enabled) return;

    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: quality.msaa });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    if (quality.dof) {
      this.bokeh = new BokehPass(scene, camera, { focus: 4, aperture: 0.004, maxblur: 0.01 });
      this.bokeh.enabled = false;
      this.composer.addPass(this.bokeh);
    }
    if (quality.bloom) {
      const div = quality.bloomHalf ? 2 : 4;
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / div, size.y / div), 0.62, 0.36, 0.95);
      this.composer.addPass(this.bloom);
    }
    this.final = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTime: THEME.uTime,
        uBeat: THEME.uBeat,
        uAberration: { value: 0.0015 },
        uVignette: { value: 0.35 },
        uFlash: { value: new THREE.Vector4(0, 0, 0, 0) },
        uGlitch: { value: 0 },
        uTint: { value: new THREE.Vector4(0, 0, 0, 0) },
        uDanger: { value: 0 },
        uHype: { value: new THREE.Vector4(0, 0, 0, 0) },
        uMotion: { value: 0 },
        uGrain: { value: quality.lens ? 1 : 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uBeat;
        uniform float uAberration;
        uniform float uVignette;
        uniform vec4 uFlash;
        uniform float uGlitch;
        uniform vec4 uTint;
        uniform float uDanger;
        uniform vec4 uHype;
        uniform float uMotion;
        uniform float uGrain;
        varying vec2 vUv;
        float h(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main() {
          vec2 uv = vUv;
          // Digital glitch: horizontal block displacement (only when pulsed).
          float tq = floor(uTime * 18.0);
          float row = floor(uv.y * 28.0);
          float blk = step(1.0 - uGlitch * 0.35, h(vec2(row, tq)));
          uv.x += blk * (h(vec2(row + 7.0, tq)) - 0.5) * 0.12 * uGlitch;
          float big = step(1.0 - uGlitch * 0.12, h(vec2(floor(uv.y * 5.0), tq + 3.0)));
          uv.x += big * 0.05 * sign(h(vec2(tq, 1.0)) - 0.5);
          // Pixel displacement blocks.
          vec2 pb = floor(uv * vec2(40.0, 22.0));
          float px = step(1.0 - uGlitch * 0.08, h(pb + tq));
          uv += px * (vec2(h(pb), h(pb + 3.1)) - 0.5) * 0.03;

          vec2 d = uv - 0.5;
          vec2 off = d * uAberration * 2.0 + vec2(uGlitch * 0.006 * (blk + big), 0.0);
          vec3 col;
          if (uMotion > 0.01) {
            // Radial speed blur: stronger toward the edges, the centre stays sharp.
            float w = smoothstep(0.12, 0.7, length(d * vec2(1.0, 0.8))) * uMotion;
            vec3 acc = vec3(0.0);
            float tot = 0.0;
            for (int i = 0; i < 8; i++) {
              float k = float(i) / 7.0;
              vec2 su = uv - d * k * 0.07 * w;
              float wt = 1.0 - k * 0.6;
              acc += vec3(texture2D(tDiffuse, su + off).r, texture2D(tDiffuse, su).g, texture2D(tDiffuse, su - off).b) * wt;
              tot += wt;
            }
            col = acc / tot;
          } else {
            col = vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
          }

          // Scanlines + noise only while glitching (or in debug mode).
          float scan = 0.5 + 0.5 * sin(uv.y * 900.0);
          col *= 1.0 - (uGlitch * 0.14 + uTint.a * 0.05) * scan;
          col += (h(uv * 800.0 + tq) - 0.5) * uGlitch * 0.12;

          float lum = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(col, lum * uTint.rgb * 1.6 + col * 0.35, uTint.a * 0.4);

          float v = smoothstep(0.85, 0.2, length(d * vec2(1.0, 0.85)));
          col *= mix(1.0 - uVignette, 1.0, v);
          float pulse = 0.6 + 0.4 * sin(uTime * 6.0);
          col += vec3(1.0, 0.05, 0.15) * (1.0 - v) * uDanger * pulse * 0.6;
          col += uHype.rgb * (1.0 - v) * (uHype.a * 0.45 + uBeat * uHype.a * 0.25);
          col += uFlash.rgb * uFlash.a * (1.0 - v * 0.6);
          // Fine film grain.
          col += (h(uv * vec2(1920.0, 1080.0) + fract(uTime * 7.0) * 100.0) - 0.5) * 0.025 * uGrain;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.composer.addPass(this.final);
    this.composer.addPass(new OutputPass());
  }

  pulse(amount: number): void {
    this.aberrationPulse = Math.min(1, this.aberrationPulse + amount);
  }

  glitch(amount: number): void {
    this.glitchPulse = Math.min(1.5, this.glitchPulse + amount);
  }

  flashScreen(color: THREE.ColorRepresentation, strength: number): void {
    this.flashColor.set(color);
    this.flash = Math.max(this.flash, strength);
  }

  setSize(w: number, h: number): void {
    this.composer?.setSize(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    const div = this.q.bloomHalf ? 2 : 4;
    this.bloom?.resolution.set(w / div, h / div);
  }

  /** Performance fallback: drop the heaviest optional passes. */
  degrade(): void {
    this.motionBlurOn = false;
    this.dofOn = false;
    if (this.bokeh) this.bokeh.enabled = false;
  }

  tick(dt: number): void {
    this.aberrationPulse = Math.max(0, this.aberrationPulse - dt * 2.5);
    this.glitchPulse = Math.max(0, this.glitchPulse - dt * 2.4);
    this.flash = Math.max(0, this.flash - dt * 3);
  }

  render(dt: number, speedFactor: number): void {
    if (!this.composer || !this.final) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const u = this.final.uniforms;
    u.uAberration.value = 0.0008 + speedFactor * 0.0018 + this.aberrationPulse * 0.012;
    u.uVignette.value = 0.34 + speedFactor * 0.1;
    u.uGlitch.value = Math.min(1, THEME.uGlitch.value * 0.5 + this.glitchPulse);
    (u.uFlash.value as THREE.Vector4).set(this.flashColor.r, this.flashColor.g, this.flashColor.b, this.flash);
    (u.uTint.value as THREE.Vector4).set(this.tint.r, this.tint.g, this.tint.b, this.tintAmount);
    u.uDanger.value = this.danger;
    (u.uHype.value as THREE.Vector4).set(this.hypeColor.r, this.hypeColor.g, this.hypeColor.b, this.hype);
    u.uMotion.value = this.motionBlurOn ? this.motion : 0;
    if (this.bokeh) {
      const on = this.dofOn && this.dof > 0.02;
      this.bokeh.enabled = on;
      if (on) {
        const bu = this.bokeh.uniforms as Record<string, THREE.IUniform>;
        bu.focus.value = this.focus;
        bu.aperture.value = 0.0035 * this.dof;
        bu.maxblur.value = 0.012 * this.dof;
      }
    }
    this.composer.render(dt);
  }
}
