import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { THEME } from '../../core/Theme';
import type { MaterialLib } from '../../render/MaterialLib';
import { glyphAtlas } from '../../world/ComputerWorld';
import { BossModel, energyMaterial, type BossPose } from '../BossModel';

const CYAN = '#00e5ff';
const VIOLET = '#9a6bff';

/**
 * CODE BREAKER - an encryption-cracking android. Chrome armour, energy blades
 * for arms, a head of spinning cipher rings around a violet core, glitch
 * wings, and a lower body that dissolves into a data stream. It assembles
 * itself out of glitch fragments, teleports between lanes and slices.
 * Weak point: the core inside the cipher rings.
 */
export class CodeBreaker extends BossModel {
  readonly height = 8;
  readonly hover = 3.6;
  private readonly body = new THREE.Group();
  private readonly rings: THREE.Mesh[] = [];
  private readonly arms: { shoulder: THREE.Group; elbow: THREE.Group; blade: THREE.Mesh; side: number }[] = [];
  private readonly wings: THREE.Mesh[] = [];
  private readonly parts: { obj: THREE.Object3D; home: THREE.Vector3; rot: THREE.Euler; from: THREE.Vector3; spin: THREE.Euler }[] = [];
  private readonly ringU = { uTime: THEME.uTime, uGlyphs: { value: glyphAtlas() }, uColor: { value: new THREE.Color(VIOLET) }, uRage: this.u.rage, uHurt: this.u.hurt };
  private readonly bladeMat: THREE.ShaderMaterial;

  constructor(lib: MaterialLib) {
    super(lib);
    const chrome = this.armorMaterial(0x2a2e3a, CYAN, { rough: 0.18, rimStrength: 1.1 });
    const dark = this.armorMaterial(0x0d0e14, VIOLET, { rough: 0.32, emissive: 0x060210 });
    const trim = this.glow(CYAN, 2.2);
    const coreMat = energyMaterial(VIOLET, this.u, { veins: 0.8, power: 1.2 });
    this.bladeMat = energyMaterial(CYAN, this.u, { veins: 0.3, power: 0.8 });
    const stream = energyMaterial(VIOLET, this.u, { veins: 1.6, power: 2.2 });

    this.root.add(this.body);
    const add = (obj: THREE.Object3D, parent: THREE.Object3D = this.body): THREE.Object3D => {
      parent.add(obj);
      this.parts.push({ obj, home: obj.position.clone(), rot: obj.rotation.clone(), from: new THREE.Vector3(), spin: new THREE.Euler() });
      return obj;
    };

    // Chest, waist and the data-stream lower body.
    const chest = new THREE.Mesh(new RoundedBoxGeometry(2.3, 1.7, 1.2, 4, 0.22), chrome);
    chest.position.y = 1.2;
    add(chest);
    const plate = new THREE.Mesh(new RoundedBoxGeometry(1.5, 1.0, 0.3, 3, 0.1), dark);
    plate.position.set(0, 1.25, 0.62);
    add(plate);
    const chestCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), trim);
    chestCore.position.set(0, 1.3, 0.8);
    add(chestCore);
    const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.45, 0.9, 16), dark);
    waist.position.y = 0.05;
    add(waist);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.4, 20, 1, true).rotateX(Math.PI).translate(0, -1.7, 0), stream);
    tail.position.y = -0.35;
    add(tail);

    // Shoulders, arms and energy blades.
    for (const side of [-1, 1]) {
      const pauldron = new THREE.Mesh(new THREE.SphereGeometry(0.72, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.6), chrome);
      pauldron.position.set(side * 1.45, 1.75, 0);
      pauldron.rotation.z = -side * 0.4;
      add(pauldron);
      const edge = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.04, 6, 32), trim);
      edge.rotation.x = Math.PI / 2;
      edge.position.y = 0.1;
      pauldron.add(edge);
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 1.55, 1.45, 0);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 1.3, 12).translate(0, -0.65, 0), dark);
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -1.3;
      const fore = new THREE.Mesh(new RoundedBoxGeometry(0.42, 1.3, 0.42, 2, 0.08).translate(0, -0.65, 0), chrome);
      elbow.add(fore);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3.4, 0.36).translate(0, -1.7, 0), this.bladeMat);
      blade.position.y = -1.25;
      elbow.add(blade);
      shoulder.add(elbow);
      add(shoulder);
      this.arms.push({ shoulder, elbow, blade, side });
    }

    // Head: violet core inside three counter-rotating cipher rings.
    const head = new THREE.Group();
    head.position.y = 2.75;
    add(head);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 3), coreMat);
    head.add(core);
    this.core.position.set(0, 2.75, 0.3);
    const ringMat = new THREE.ShaderMaterial({
      uniforms: this.ringU,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uGlyphs; uniform vec3 uColor; uniform float uRage; uniform float uHurt;
        varying vec2 vUv;
        void main() {
          vec2 g = vec2(fract(vUv.x * 28.0 - uTime * 0.6), vUv.y);
          float cell = floor(vUv.x * 28.0 - uTime * 0.6);
          float id = mod(cell * 7.0 + floor(uTime * 3.0), 16.0);
          vec2 c = vec2(mod(id, 4.0), floor(id / 4.0)) / 4.0;
          float glyph = texture2D(uGlyphs, c + g / 4.0).r;
          vec3 col = mix(uColor, vec3(1.0, 0.2, 0.5), uRage * 0.7) * (0.35 + glyph * 1.8);
          gl_FragColor = vec4(mix(col, vec3(2.0), uHurt * 0.7), 1.0);
        }`,
    });
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.85 + i * 0.28, 0.85 + i * 0.28, 0.22, 48, 1, true), ringMat);
      head.add(r);
      this.rings.push(r);
    }

    // Glitch wings: grids of light behind the shoulders.
    const wingMat = energyMaterial(CYAN, this.u, { veins: 2, power: 3 });
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.6, 6, 8), wingMat);
      w.position.set(side * 1.9, 2.2, -0.7);
      w.rotation.set(0.1, side * 0.6, side * 0.35);
      (w.material as THREE.ShaderMaterial).side = THREE.DoubleSide;
      (w.material as THREE.ShaderMaterial).wireframe = true;
      add(w);
      this.wings.push(w);
    }
    this.body.position.y = 0;

    this.breakable(...this.arms.map((a) => a.shoulder), head, chest, ...this.wings, tail);
    this.finish();
    for (const pt of this.parts) {
      pt.from.set((Math.random() - 0.5) * 16, Math.random() * 10 - 2, (Math.random() - 0.5) * 10);
      pt.spin.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    }
  }

  protected animate(p: BossPose): void {
    const t = p.time;
    const rage = this.u.rage.value;
    const spin = 1 + rage * 2.2 + (p.mode === 'intro' ? Math.max(0, p.introT - 2) * 2 : 0);
    this.rings.forEach((r, i) => {
      r.rotation.set(Math.sin(t * 0.7 + i) * 0.9, t * spin * (i % 2 ? -1.3 : 1) * (0.8 + i * 0.3), Math.cos(t * 0.5 + i * 2) * 0.7);
    });

    // Intro: every part flies in from scattered glitch fragments.
    let asm = 1;
    if (p.mode === 'intro') asm = Math.min(1, Math.max(0, (p.introT - 0.4) / 1.8));
    const e = 1 - Math.pow(1 - asm, 3);
    if (p.mode !== 'defeat') {
      for (const pt of this.parts) {
        pt.obj.position.copy(pt.from).lerp(pt.home, e);
        pt.obj.rotation.set(pt.rot.x + pt.spin.x * (1 - e), pt.rot.y + pt.spin.y * (1 - e), pt.rot.z + pt.spin.z * (1 - e));
        pt.obj.visible = asm >= 1 || Math.random() > (1 - asm) * 0.35;
      }
      if (asm >= 1) this.wings.forEach((w, i) => w.rotation.set(0.1, (i ? 1 : -1) * (0.6 + Math.sin(t * 2) * 0.1), (i ? 1 : -1) * 0.35));
    }

    // Blades ignite at the end of the intro.
    const ignite = p.mode === 'intro' ? Math.min(1, Math.max(0, (p.introT - 2.4) / 0.5)) : p.mode === 'defeat' ? Math.max(0, 1 - p.defeatT) : 1;
    // Arms: idle guard, slash, raised for the cipher rain.
    const k = Math.min(1, p.attackT);
    const rel = Math.max(0, p.attackT - 1);
    this.arms.forEach((a) => {
      let sx = 0.25;
      let sz = a.side * 0.25;
      let ex = -0.7;
      if (p.mode === 'fight' && p.attack === 'slash') {
        sx = -1.6 * k + (rel > 0 ? Math.min(1, rel * 5) * 2.6 : 0);
        ex = -0.2;
      } else if (p.mode === 'fight' && p.attack === 'rain') {
        sx = -2.6 * k;
        sz = a.side * (0.25 + 0.5 * k);
        ex = -0.3;
      } else if (p.roar > 0) {
        sz = a.side * (0.25 + 1.2 * Math.sin(p.roar * Math.PI));
        sx = -0.8 * Math.sin(p.roar * Math.PI);
      }
      if (asm >= 1 && p.mode !== 'defeat') a.shoulder.rotation.set(sx + Math.sin(t * 1.5 + a.side) * 0.05, 0, sz);
      a.elbow.rotation.x = ex;
      a.blade.scale.set(1, Math.max(0.01, ignite), 1);
    });

    // Hover, sway and glitch; teleport flicker.
    const glitchy = p.attack === 'glitch' ? Math.min(1, p.attackT) : 0;
    this.body.position.y = Math.sin(t * 1.6) * 0.3;
    this.body.rotation.y = Math.sin(t * 0.6) * 0.12;
    this.body.position.x = (rage > 0.5 && Math.sin(t * 37) > 0.93) || (glitchy > 0.2 && Math.sin(t * 60) > 0.3) ? (Math.random() - 0.5) * 0.9 : 0;
    this.body.visible = !(glitchy > 0.4 && glitchy < 1 && Math.sin(t * 80) > 0.2);
    this.bladeMat.uniforms.uColor.value.set(rage > 0.6 ? '#ff2b8a' : CYAN);
    this.ringU.uColor.value.set(VIOLET);
  }
}
