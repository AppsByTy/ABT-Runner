import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLSL_HASH, THEME } from '../../core/Theme';
import type { MaterialLib } from '../../render/MaterialLib';
import { canvasTexture } from '../../utils/textures';
import { BossModel, chain, energyMaterial, type BossPose } from '../BossModel';

const RED = '#ff1e3c';
const BLUE = '#2a6bff';

/** Crash screen atlas: top half the blue "sad" screen, bottom half the red KERNEL PANIC. */
function crashScreen(): THREE.CanvasTexture {
  return canvasTexture(512, 640, (g, w) => {
    const face = (y0: number, bg: string, fg: string, angry: boolean, lines: string[]): void => {
      g.fillStyle = bg;
      g.fillRect(0, y0, w, 320);
      g.fillStyle = fg;
      g.font = 'bold 150px "SF Mono", Menlo, Consolas, monospace';
      g.textBaseline = 'top';
      g.fillText(angry ? '>:(' : ':(', 36, y0 + 18);
      g.font = 'bold 26px "SF Mono", Menlo, Consolas, monospace';
      lines.forEach((l, i) => g.fillText(l, 38, y0 + 196 + i * 34));
      g.fillStyle = fg;
      g.fillRect(38, y0 + 290, 300 * (angry ? 1 : 0.62), 10);
    };
    face(0, '#1238c8', '#e8f0ff', false, ['FATAL_EXCEPTION 0xAPPSBYTY', 'SYSTEM_CRASH.EXE HAS TAKEN OVER']);
    face(320, '#7a0014', '#ffd6dc', true, ['KERNEL PANIC — CORE MELTDOWN', 'ALL PROCESSES TERMINATED']);
  });
}

/**
 * SYSTEM CRASH - the final boss: a colossal corrupted monitor wearing the
 * blue screen of death as a face, a caged kernel core beneath it, orbiting
 * shards of broken screens, tendril cables and a crown of warning signs.
 * The screen turns red and angry as it loses control. Weak point: the kernel.
 */
export class SystemCrash extends BossModel {
  readonly height = 12;
  readonly hover = 7.4;
  private readonly monitor = new THREE.Group();
  private readonly shards = new THREE.Group();
  private readonly shardList: THREE.Mesh[] = [];
  private readonly tendrils: THREE.Object3D[][] = [];
  private readonly crown = new THREE.Group();
  private readonly cage = new THREE.Group();
  private readonly tex = crashScreen();
  private readonly screenU = {
    uTex: { value: this.tex },
    uTime: THEME.uTime,
    uRage: this.u.rage,
    uHurt: this.u.hurt,
    uHot: this.u.hot,
    uBoot: { value: 0 },
  };

  constructor(lib: MaterialLib) {
    super(lib);
    const bezel = this.armorMaterial(0x121318, RED, { rough: 0.22, rimStrength: 1.0 });
    const dark = this.armorMaterial(0x09090c, BLUE, { rough: 0.4, rimStrength: 0.7, emissive: 0x020410 });
    const trim = this.glow(RED, 2.4);
    const kernel = energyMaterial('#ff3355', this.u, { veins: 1.2, power: 1.1 });

    this.root.add(this.monitor);
    // Monitor bezel + screen.
    const frame = new THREE.Mesh(new RoundedBoxGeometry(9.4, 6.2, 1.1, 4, 0.35), bezel);
    const back = new THREE.Mesh(new RoundedBoxGeometry(7.2, 4.6, 1.6, 3, 0.4), dark);
    back.position.z = -1.0;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(8.5, 5.3),
      new THREE.ShaderMaterial({
        uniforms: this.screenU,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: /* glsl */ `
          uniform sampler2D uTex; uniform float uTime; uniform float uRage; uniform float uHurt; uniform float uHot; uniform float uBoot;
          varying vec2 vUv;
          ${GLSL_HASH}
          void main() {
            vec2 uv = vUv;
            // Glitch bands tear the image sideways.
            float band = floor(uv.y * 24.0);
            float tear = step(0.86 - uRage * 0.2, hash12(vec2(band, floor(uTime * 14.0))));
            uv.x += tear * (hash12(vec2(band, 3.0)) - 0.5) * 0.12;
            float angry = step(0.55, uRage) + step(0.35, uRage) * step(0.9, hash12(vec2(floor(uTime * 9.0), 1.0)));
            angry = clamp(angry, 0.0, 1.0);
            vec2 at = vec2(uv.x, 0.5 + uv.y * 0.5 - angry * 0.5);
            vec3 r = texture2D(uTex, at + vec2(0.004 + tear * 0.01, 0.0)).rgb;
            vec3 g = texture2D(uTex, at).rgb;
            vec3 b = texture2D(uTex, at - vec2(0.004 + tear * 0.01, 0.0)).rgb;
            vec3 col = vec3(r.r, g.g, b.b);
            // Scanlines, cracks and the boot flicker.
            col *= 0.82 + 0.18 * sin(vUv.y * 420.0);
            float crack = smoothstep(0.02, 0.0, abs(vnoise(vUv * vec2(9.0, 6.0)) - 0.5)) * uRage;
            col += crack * vec3(1.0, 0.9, 0.9) * 1.5;
            float boot = uBoot < 1.0 ? step(hash12(vec2(floor(uTime * 20.0), 7.0)), uBoot) : 1.0;
            col *= boot * (1.25 + uHot);
            col = mix(col, vec3(2.0), uHurt * 0.6);
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    screen.position.z = 0.56;
    this.monitor.add(frame, back, screen);
    // Status LEDs along the bezel.
    for (let i = 0; i < 5; i++) {
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), i === 4 ? trim : this.glow(BLUE, 2.2));
      led.position.set(-4.2 + i * 0.35, -2.85, 0.56);
      this.monitor.add(led);
    }

    // Caged kernel core beneath the screen (weak point).
    this.cage.position.set(0, -4.4, 0.2);
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 3), kernel);
    this.cage.add(orb);
    for (let i = 0; i < 3; i++) {
      const bar = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.08, 8, 40), bezel);
      bar.rotation.set(i * 1.05, i * 0.6, 0);
      this.cage.add(bar);
    }
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 1.4, 12), dark);
    mount.position.y = 1.2;
    this.cage.add(mount);
    this.monitor.add(this.cage);
    this.core.position.set(0, -4.4, 1.2);

    // Crown of warning triangles.
    const tri = new THREE.Shape();
    tri.moveTo(0, 1.1);
    tri.lineTo(0.95, -0.55);
    tri.lineTo(-0.95, -0.55);
    tri.lineTo(0, 1.1);
    const hole = new THREE.Path();
    hole.moveTo(0, 0.72);
    hole.lineTo(0.62, -0.36);
    hole.lineTo(-0.62, -0.36);
    hole.lineTo(0, 0.72);
    tri.holes.push(hole);
    const triGeo = new THREE.ExtrudeGeometry(tri, { depth: 0.18, bevelEnabled: false });
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(triGeo, trim);
      m.position.set((i - 1) * 2.6, 4.2 + (i === 1 ? 0.5 : 0), 0);
      m.scale.setScalar(i === 1 ? 1.2 : 0.9);
      this.crown.add(m);
    }
    this.monitor.add(this.crown);

    // Shards of broken screens orbiting it.
    const shardTex = this.tex;
    for (let i = 0; i < 12; i++) {
      const sh = new THREE.Shape();
      const n = 3 + (i % 2);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + Math.random() * 0.6;
        const r = 0.6 + Math.random() * 0.7;
        if (k === 0) sh.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else sh.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      const geo = new THREE.ShapeGeometry(sh);
      const uv = geo.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) uv.setXY(k, 0.3 + uv.getX(k) * 0.2, 0.5 + uv.getY(k) * 0.2 + (i % 2) * 0.25);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: shardTex, side: THREE.DoubleSide, color: new THREE.Color(1.4, 1.4, 1.4) }));
      m.userData = { a: (i / 12) * Math.PI * 2, r: 6.2 + (i % 3) * 1.1, y: (i % 4) * 1.4 - 2, s: 0.5 + (i % 3) * 0.25 };
      this.shards.add(m);
      this.shardList.push(m);
    }
    this.root.add(this.shards);

    // Tendril cables hanging from the bottom corners.
    for (let c = 0; c < 4; c++) {
      const segs: THREE.Object3D[] = [];
      for (let k = 0; k < 9; k++) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.16 - k * 0.012, 0.16 - k * 0.012, 0.7, 10).translate(0, -0.35, 0), k % 3 === 2 ? trim : k % 2 ? dark : bezel);
        segs.push(m);
      }
      const anchor = new THREE.Group();
      anchor.position.set((c < 2 ? -1 : 1) * (3.2 + (c % 2) * 1.2), -3.0, -0.3);
      this.monitor.add(anchor);
      chain(segs, anchor, new THREE.Vector3(0, -0.7, 0));
      this.tendrils.push(segs);
    }

    this.breakable(frame, back, screen, this.crown, ...this.tendrils.map((t) => t[0].parent!), ...this.shardList.slice(0, 6));
    this.finish();
  }

  protected animate(p: BossPose): void {
    const t = p.time;
    const rage = this.u.rage.value;
    let drop = 0;
    let spiral = 1;
    let slam = 0;
    if (p.mode === 'intro') {
      const it = p.introT;
      this.screenU.uBoot.value = Math.min(1, Math.max(0, (it - 0.6) / 1.4));
      drop = Math.max(0, 1 - Math.max(0, it - 1.2) / 2.0);
      drop = drop * drop * (3 - 2 * drop);
      spiral = Math.min(1, Math.max(0, (it - 1.8) / 1.8));
    } else {
      this.screenU.uBoot.value = p.mode === 'defeat' ? Math.max(0, 1 - Math.max(0, p.defeatT - 1.2)) : 1;
      if (p.mode === 'fight' && p.attack === 'collapse') slam = Math.min(1, p.attackT);
    }
    this.monitor.position.y = 26 * drop + Math.sin(t * 0.9) * 0.4;
    this.monitor.rotation.set(Math.sin(t * 0.7) * 0.05 - slam * 0.15, Math.sin(t * 0.45) * 0.1, Math.sin(t * 0.6) * 0.04 + (p.roar > 0 ? Math.sin(p.roar * 40) * 0.05 : 0));
    this.cage.rotation.y = t * (0.8 + rage * 2);
    this.crown.children.forEach((c, i) => ((c as THREE.Mesh).scale.setScalar((i === 1 ? 1.2 : 0.9) * (1 + Math.max(0, Math.sin(t * 6 + i)) * 0.12 * (1 + rage)))));
    // Shards orbit; faster and wider as it loses control, and in the error storm.
    const storm = p.attack === 'storm' ? Math.min(1, p.attackT) : 0;
    if (p.mode !== 'defeat') this.shardList.forEach((m, i) => {
      const d = m.userData as { a: number; r: number; y: number; s: number };
      const a = d.a + t * (0.35 + rage * 0.8 + storm * 2) * (i % 2 ? 1 : -1);
      const r = d.r * (0.25 + 0.75 * spiral) * (1 + storm * 0.25);
      m.position.set(Math.cos(a) * r, this.monitor.position.y + d.y, Math.sin(a) * r * 0.5 - 1);
      m.rotation.set(t * 0.6 + i, t * 0.8 + i * 2, 0);
      m.scale.setScalar(d.s * spiral);
    });
    this.tendrils.forEach((segs, ci) =>
      segs.forEach((s, k) => {
        s.rotation.z = Math.sin(t * 2.1 + ci * 1.3 + k * 0.5) * (0.12 + rage * 0.12) + (ci < 2 ? -1 : 1) * 0.04;
        s.rotation.x = slam * (k === 0 ? -1.1 : 0.1) + Math.sin(t * 1.7 + k) * 0.06;
      }),
    );
  }
}
