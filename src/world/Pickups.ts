import * as THREE from 'three';
import { CONFIG, LANE_X } from '../core/Config';
import { canvasTexture } from '../utils/textures';
import { rimify } from '../utils/rim';

export type PowerType = 'debug' | 'firewall' | 'boost' | 'magnet' | 'ram' | 'admin';
export type PickupKind = 'coin' | 'code' | 'chip' | 'xp' | 'patch' | 'goodBug' | 'bossPatch' | 'power';

export const POWER_INFO: Record<PowerType, { name: string; color: string; duration: number }> = {
  debug: { name: 'DEBUG MODE', color: '#39ff6a', duration: 8 },
  firewall: { name: 'FIREWALL', color: '#ff7a1a', duration: 20 },
  boost: { name: 'CODE BOOST', color: '#00e5ff', duration: 5 },
  magnet: { name: 'BUG MAGNET', color: '#ff2bd6', duration: 10 },
  ram: { name: 'RAM BOOST', color: '#9a6bff', duration: 10 },
  admin: { name: 'ADMIN ACCESS', color: '#ffd23a', duration: 7 },
};
export const POWER_TYPES: readonly PowerType[] = ['debug', 'firewall', 'boost', 'magnet', 'ram', 'admin'];

export interface Pickup {
  kind: PickupKind;
  power?: PowerType;
  x: number;
  y: number;
  dist: number;
  collected: boolean;
  popT: number;
  lockAhead?: number;
  phase: number;
  /** Being pulled toward the player by a magnet. */
  mag: boolean;
  /** Friendly bugs wander toward the player. */
  vx: number;
}

const MONO = '"SF Mono", "Cascadia Mono", Menlo, Consolas, "Courier New", monospace';
const MAX = 320;

// ---------------------------------------------------------------- textures

function coinFace(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(100, 90, 10, 128, 128, 128);
    g.addColorStop(0, '#fff3a8');
    g.addColorStop(0.55, '#ffc21a');
    g.addColorStop(1, '#b87400');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#7a4a00';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(128, 128, 104, 0, Math.PI * 2);
    ctx.stroke();
    // AppsByTy "A" mark.
    ctx.fillStyle = '#1a1000';
    ctx.beginPath();
    ctx.moveTo(114, 52);
    ctx.lineTo(142, 52);
    ctx.lineTo(96, 200);
    ctx.lineTo(62, 200);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(136, 62);
    ctx.lineTo(152, 62);
    ctx.lineTo(196, 200);
    ctx.lineTo(172, 200);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(98, 146, 104, 18);
  });
}

function iconTex(draw: (ctx: CanvasRenderingContext2D) => void, w = 256, h = 256): THREE.CanvasTexture {
  return canvasTexture(w, h, draw);
}

function codeFace(): THREE.CanvasTexture {
  return iconTex((ctx) => {
    ctx.fillStyle = '#021a24';
    ctx.fillRect(0, 0, 256, 180);
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, 246, 170);
    ctx.fillStyle = '#7ff4ff';
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 14;
    ctx.font = `900 96px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('</>', 128, 94);
  }, 256, 180);
}

function chipFace(): THREE.CanvasTexture {
  return iconTex((ctx) => {
    ctx.fillStyle = '#0a0d10';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#d9a640';
    for (let i = 0; i < 6; i++) {
      const o = 40 + i * 35;
      ctx.fillRect(o, 0, 14, 36);
      ctx.fillRect(o, 220, 14, 36);
      ctx.fillRect(0, o, 36, 14);
      ctx.fillRect(220, o, 36, 14);
    }
    ctx.fillStyle = '#10301c';
    ctx.fillRect(40, 40, 176, 176);
    ctx.fillStyle = '#39ff6a';
    ctx.shadowColor = '#39ff6a';
    ctx.shadowBlur = 18;
    ctx.fillRect(84, 84, 88, 88);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#062010';
    ctx.font = `900 34px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DATA', 128, 130);
  });
}

function xpFace(): THREE.CanvasTexture {
  return iconTex((ctx) => {
    ctx.fillStyle = '#2a0c5a';
    ctx.beginPath();
    ctx.moveTo(20, 10);
    ctx.lineTo(160, 10);
    ctx.lineTo(216, 66);
    ctx.lineTo(216, 300);
    ctx.lineTo(20, 300);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#c59bff';
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.fillStyle = '#c59bff';
    ctx.beginPath();
    ctx.moveTo(160, 10);
    ctx.lineTo(160, 66);
    ctx.lineTo(216, 66);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#f0e2ff';
    ctx.font = `900 86px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('XP', 118, 170);
    ctx.fillStyle = '#c59bff';
    for (let i = 0; i < 3; i++) ctx.fillRect(50, 226 + i * 22, 136 - i * 30, 10);
  }, 236, 310);
}

function patchFace(gold: boolean): THREE.CanvasTexture {
  const main = gold ? '#ffd23a' : '#39ff6a';
  return iconTex((ctx) => {
    // Shield.
    ctx.fillStyle = gold ? '#2a1c00' : '#042010';
    ctx.strokeStyle = main;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(128, 14);
    ctx.lineTo(232, 50);
    ctx.lineTo(220, 150);
    ctx.quadraticCurveTo(200, 212, 128, 244);
    ctx.quadraticCurveTo(56, 212, 36, 150);
    ctx.lineTo(24, 50);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = main;
    ctx.shadowColor = main;
    ctx.shadowBlur = 16;
    if (gold) {
      ctx.lineWidth = 26;
      ctx.strokeStyle = main;
      ctx.beginPath();
      ctx.moveTo(78, 128);
      ctx.lineTo(114, 166);
      ctx.lineTo(182, 90);
      ctx.stroke();
    } else {
      ctx.fillRect(108, 62, 40, 124);
      ctx.fillRect(66, 104, 124, 40);
    }
  });
}

function bugIcon(): THREE.CanvasTexture {
  // Floating "fix me" marker above friendly bugs: wrench in a green bubble.
  return iconTex((ctx) => {
    ctx.fillStyle = 'rgba(57,255,106,0.22)';
    ctx.strokeStyle = '#39ff6a';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(128, 118, 96, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(108, 210);
    ctx.lineTo(128, 250);
    ctx.lineTo(148, 210);
    ctx.fill();
    ctx.save();
    ctx.translate(128, 118);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = '#d8ffe0';
    ctx.fillRect(-12, -10, 24, 90);
    ctx.beginPath();
    ctx.arc(0, -34, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(4,40,16,1)';
    ctx.fillRect(-12, -76, 24, 44);
    ctx.restore();
  });
}

export function powerIcon(type: PowerType): THREE.CanvasTexture {
  const { color, name } = POWER_INFO[type];
  return iconTex((ctx) => {
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.clearRect(0, 0, 256, 256);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.save();
    ctx.translate(128, 104);
    switch (type) {
      case 'debug': {
        // Bug with a check.
        ctx.beginPath();
        ctx.ellipse(0, 10, 44, 58, 0, 0, Math.PI * 2);
        ctx.stroke();
        for (const s of [-1, 1]) {
          for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(s * 44, -10 + i * 26);
            ctx.lineTo(s * 76, -24 + i * 30);
            ctx.stroke();
          }
        }
        ctx.beginPath();
        ctx.moveTo(-20, 12);
        ctx.lineTo(-4, 30);
        ctx.lineTo(24, -6);
        ctx.stroke();
        break;
      }
      case 'firewall': {
        ctx.beginPath();
        ctx.moveTo(0, -70);
        ctx.lineTo(62, -48);
        ctx.lineTo(54, 20);
        ctx.quadraticCurveTo(40, 60, 0, 78);
        ctx.quadraticCurveTo(-40, 60, -54, 20);
        ctx.lineTo(-62, -48);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, 46);
        ctx.quadraticCurveTo(-30, 20, -8, -20);
        ctx.quadraticCurveTo(0, 0, 8, -34);
        ctx.quadraticCurveTo(34, 10, 0, 46);
        ctx.fill();
        break;
      }
      case 'boost': {
        for (const o of [-34, 18]) {
          ctx.beginPath();
          ctx.moveTo(o - 16, -50);
          ctx.lineTo(o + 28, 0);
          ctx.lineTo(o - 16, 50);
          ctx.stroke();
        }
        break;
      }
      case 'magnet': {
        ctx.lineWidth = 26;
        ctx.beginPath();
        ctx.arc(0, -4, 46, Math.PI, 0);
        ctx.lineTo(46, 54);
        ctx.moveTo(-46, -4);
        ctx.lineTo(-46, 54);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-60, 44, 28, 22);
        ctx.fillRect(32, 44, 28, 22);
        break;
      }
      case 'ram': {
        ctx.lineWidth = 10;
        ctx.strokeRect(-80, -34, 160, 64);
        for (let i = 0; i < 4; i++) ctx.fillRect(-70 + i * 38, -22, 26, 38);
        for (let i = 0; i < 10; i++) ctx.fillRect(-74 + i * 16, 36, 8, 18);
        break;
      }
      case 'admin': {
        ctx.beginPath();
        ctx.moveTo(-70, 40);
        ctx.lineTo(-76, -40);
        ctx.lineTo(-36, -6);
        ctx.lineTo(0, -60);
        ctx.lineTo(36, -6);
        ctx.lineTo(76, -40);
        ctx.lineTo(70, 40);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(-70, 50, 140, 16);
        break;
      }
    }
    ctx.restore();
    ctx.shadowBlur = 8;
    ctx.font = `900 ${name.length > 10 ? 26 : 30}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 128, 222);
  });
}

// ------------------------------------------------------------ manager

interface Renderer {
  meshes: THREE.InstancedMesh[];
  /** Per-kind pose: returns false to skip drawing. */
  tilt?: number;
}

export class PickupManager {
  private readonly items: Pickup[] = [];
  private readonly free: Pickup[] = [];
  private readonly renderers: Record<Exclude<PickupKind, 'power'>, Renderer>;
  private readonly powerMeshes: Record<PowerType, THREE.Group[]>;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private time = 0;

  constructor(scene: THREE.Scene) {
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], order = 0): THREE.InstancedMesh => {
      const im = new THREE.InstancedMesh(geo, mat, MAX);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      im.renderOrder = order;
      scene.add(im);
      return im;
    };
    const faceMats = (tex: THREE.Texture, side: THREE.ColorRepresentation, k = 1.3): THREE.Material[] => {
      const edge = new THREE.MeshStandardMaterial({ color: new THREE.Color(side).lerp(new THREE.Color(1, 1, 1), 0.4), metalness: 1, roughness: 0.2, emissive: new THREE.Color(side), emissiveIntensity: 0.6 * k });
      const face = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1, 1, 1).multiplyScalar(k), transparent: true, alphaTest: 0.1 });
      return [edge, edge, edge, edge, face, face];
    };

    // Coin: gold disc with the A mark on both faces.
    // Minted gold: embossed face (bump from the artwork), reeded rim, real metal reflections.
    const coinGeo = new THREE.CylinderGeometry(0.37, 0.37, 0.07, 40).rotateX(Math.PI / 2);
    const rimGeo = new THREE.TorusGeometry(0.385, 0.05, 10, 48);
    const face = coinFace();
    const coinSide = new THREE.MeshStandardMaterial({ color: 0xffc640, emissive: 0x7a4a00, emissiveIntensity: 0.9, metalness: 1, roughness: 0.22 });
    const coinFaceMat = new THREE.MeshStandardMaterial({
      map: face, bumpMap: face, bumpScale: 2.5, color: 0xffe6a0, metalness: 1, roughness: 0.28,
      emissive: 0xffffff, emissiveMap: face, emissiveIntensity: 0.55,
    });

    // Friendly bug: small cyan-green beetle with a wrench marker overhead.
    const goodShell = rimify(
      new THREE.MeshPhysicalMaterial({
        color: 0x2adf5a, emissive: 0x0a4a1a, metalness: 0.4, roughness: 0.18,
        clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.6, iridescenceIOR: 1.4, iridescenceThicknessRange: [200, 500],
      }),
      '#00e5ff', 1.0, 2.5, false,
    );
    const goodEyes = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const markerMat = new THREE.MeshBasicMaterial({ map: bugIcon(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

    this.renderers = {
      coin: { meshes: [inst(coinGeo, [coinSide, coinFaceMat, coinFaceMat]), inst(rimGeo, coinSide)] },
      code: { meshes: [inst(new THREE.BoxGeometry(0.62, 0.44, 0.08), faceMats(codeFace(), '#00e5ff'))] },
      chip: { meshes: [inst(new THREE.BoxGeometry(0.62, 0.62, 0.08), faceMats(chipFace(), '#39ff6a'))] },
      xp: { meshes: [inst(new THREE.BoxGeometry(0.5, 0.66, 0.06), faceMats(xpFace(), '#c59bff'))] },
      patch: { meshes: [inst(new THREE.BoxGeometry(0.7, 0.7, 0.08), faceMats(patchFace(false), '#39ff6a'))] },
      bossPatch: { meshes: [inst(new THREE.BoxGeometry(1.0, 1.0, 0.1), faceMats(patchFace(true), '#ffd23a', 1.6))] },
      goodBug: {
        meshes: [
          inst(new THREE.SphereGeometry(0.3, 32, 20).scale(1, 0.62, 1.25).translate(0, 0.25, 0), goodShell),
          inst(new THREE.SphereGeometry(0.075, 14, 10).translate(-0.1, 0.36, -0.33), goodEyes),
          inst(new THREE.SphereGeometry(0.075, 14, 10).translate(0.1, 0.36, -0.33), goodEyes),
          inst(new THREE.PlaneGeometry(0.75, 0.75).translate(0, 1.15, 0), markerMat, 6),
        ],
      },
    };

    // Power-ups: a few pooled holographic cubes per type.
    this.powerMeshes = {} as Record<PowerType, THREE.Group[]>;
    for (const t of POWER_TYPES) {
      this.powerMeshes[t] = [];
      const color = new THREE.Color(POWER_INFO[t].color);
      const icon = powerIcon(t);
      for (let i = 0; i < 2; i++) {
        const g = new THREE.Group();
        const cube = new THREE.BoxGeometry(1.1, 1.1, 1.1);
        g.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube), new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(2) })));
        g.add(
          new THREE.Mesh(
            cube,
            new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.25), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
          ),
        );
        const iconMesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1.2, 1.2),
          new THREE.MeshBasicMaterial({ map: icon, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: new THREE.Color(1.6, 1.6, 1.6) }),
        );
        iconMesh.name = 'icon';
        g.add(iconMesh);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.04, 6, 40), new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.8) }));
        ring.name = 'ring';
        g.add(ring);
        g.visible = false;
        g.userData.busy = false;
        g.traverse((c) => (c.frustumCulled = false));
        scene.add(g);
        this.powerMeshes[t].push(g);
      }
    }
  }

  spawn(kind: PickupKind, lane: number, dist: number, y = 0.9, power?: PowerType): Pickup | null {
    if (this.items.length >= MAX - 1) return null;
    const c = this.free.pop() ?? ({} as Pickup);
    c.kind = kind;
    c.power = power;
    c.x = LANE_X[lane];
    c.y = y;
    c.dist = dist;
    c.collected = false;
    c.popT = 0;
    c.phase = Math.random() * 10;
    c.mag = false;
    c.vx = kind === 'goodBug' ? (Math.random() < 0.5 ? -1 : 1) * 0.6 : 0;
    this.items.push(c);
    return c;
  }

  get active(): readonly Pickup[] {
    return this.items;
  }

  collect(c: Pickup): void {
    c.collected = true;
    c.popT = 0;
  }

  private releaseAt(i: number): void {
    const c = this.items[i];
    const last = this.items.pop()!;
    if (i < this.items.length) this.items[i] = last;
    this.free.push(c);
  }

  /**
   * @param magnet  attraction radius (m) toward the player, 0 = off
   * @param magnetKinds which kinds the magnet pulls
   */
  update(dt: number, distance: number, player: { x: number; y: number }, magnet: number, magnetKinds: ReadonlySet<PickupKind>): void {
    this.time += dt;
    const a = this.items;
    for (let i = a.length - 1; i >= 0; i--) {
      const c = a[i];
      const ahead = c.dist - distance;
      if (c.collected) {
        // Pop in the player's frame (don't let the world scroll it into the camera).
        if (c.popT === 0) c.lockAhead = Math.max(0.2, Math.min(1.5, ahead));
        c.dist = distance + (c.lockAhead ?? 0.5);
        c.popT += dt;
        if (c.popT >= 0.2) this.releaseAt(i);
        continue;
      }
      if (-ahead > CONFIG.spawn.despawnBehind) {
        this.releaseAt(i);
        continue;
      }
      // Friendly bugs scuttle about in their lane and toward the player.
      if (c.kind === 'goodBug' && ahead < 60) {
        c.dist -= 2.2 * dt;
        c.x += c.vx * dt;
        const lane = Math.round(c.x / CONFIG.lanes.width) * CONFIG.lanes.width;
        if (Math.abs(c.x - lane) > 0.45) c.vx = -c.vx;
      }
      // Magnet pull.
      if (magnet > 0 && magnetKinds.has(c.kind) && ahead < magnet && ahead > -1) c.mag = true;
      if (c.mag) {
        const k = 1 - Math.exp(-14 * dt);
        c.x += (player.x - c.x) * k;
        c.y += (player.y + 0.9 - c.y) * k;
        c.dist += (distance - c.dist) * k;
      }
    }
    this.render(distance);
  }

  private render(distance: number): void {
    const counts: Record<string, number> = {};
    const { m, q, e, p, s } = this;
    for (const r of Object.values(this.renderers)) for (const im of r.meshes) im.count = 0;
    for (const list of Object.values(this.powerMeshes)) for (const g of list) {
      g.visible = false;
      g.userData.busy = false;
    }

    for (const c of this.items) {
      const z = -(c.dist - distance);
      if (z < -CONFIG.spawn.aheadDistance - 10) continue;
      const t = this.time + c.phase;
      let scale = 1;
      let y = c.y + Math.sin(t * 3) * 0.06;
      let rotY = t * 2.2;
      if (c.collected) {
        const k = c.popT / 0.2;
        scale = k < 0.4 ? 1 + k * 0.6 : Math.max(0.01, 1.24 * (1 - (k - 0.4) / 0.6));
        y += k * 0.9;
        rotY += k * 10;
      }
      if (c.kind === 'power') {
        const list = this.powerMeshes[c.power!];
        const g = list.find((x) => !x.userData.busy);
        if (!g) continue;
        g.userData.busy = true;
        g.visible = true;
        g.position.set(c.x, 1.3 + Math.sin(t * 2.5) * 0.15, z);
        g.rotation.set(0, t * 0.8, 0);
        g.scale.setScalar(scale);
        g.getObjectByName('icon')!.rotation.y = -t * 0.8; // keep icon facing the camera
        const ring = g.getObjectByName('ring')!;
        ring.rotation.set(Math.PI / 2 + Math.sin(t) * 0.3, t * 2, 0);
        continue;
      }
      const r = this.renderers[c.kind];
      const i = counts[c.kind] ?? 0;
      counts[c.kind] = i + 1;
      if (c.kind === 'goodBug') {
        rotY = Math.PI + Math.sin(t * 9) * 0.25 + (c.vx > 0 ? -0.3 : 0.3);
        y = c.collected ? y - c.y : Math.abs(Math.sin(t * 14)) * 0.03;
      } else if (c.kind === 'coin') {
        rotY = t * 3.2;
      } else {
        rotY = Math.sin(t * 1.6) * 0.6;
      }
      p.set(c.x, y, z);
      q.setFromEuler(e.set(0, rotY, 0));
      s.setScalar(scale * (c.kind === 'bossPatch' ? 1 + Math.sin(t * 6) * 0.08 : 1));
      m.compose(p, q, s);
      for (let k = 0; k < r.meshes.length; k++) {
        if (c.kind === 'goodBug' && k === 3) {
          // Marker billboard: no spin.
          q.identity();
          p.y = (c.collected ? y : 0) + Math.sin(t * 4) * 0.08;
          m.compose(p, q, s);
        }
        r.meshes[k].setMatrixAt(i, m);
      }
    }
    for (const [kind, r] of Object.entries(this.renderers)) {
      const n = counts[kind] ?? 0;
      for (const im of r.meshes) {
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  clear(): void {
    while (this.items.length) this.releaseAt(this.items.length - 1);
    this.render(0);
  }
}
