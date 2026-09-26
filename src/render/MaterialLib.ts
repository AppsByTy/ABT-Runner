import * as THREE from 'three';
import { Random } from '../utils/Random';

/**
 * Procedural surface textures (generated once at startup, no image files):
 * brushed metal, carbon fibre, fabric weave, knit rib, micro-scratches and
 * PCB relief, each with a matching normal map derived from a height field.
 */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

/** Convert a greyscale height canvas into a tangent-space normal map. */
function heightToNormal(src: HTMLCanvasElement, strength: number, repeat: [number, number]): THREE.CanvasTexture {
  const w = src.width;
  const h = src.height;
  const hd = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  const [out, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const H = (x: number, y: number): number => hd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return tex(out, repeat, false);
}

function tex(c: HTMLCanvasElement, repeat: [number, number], srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export class MaterialLib {
  readonly brushedNormal: THREE.Texture;
  readonly brushedRough: THREE.Texture;
  readonly carbonNormal: THREE.Texture;
  readonly carbonColor: THREE.Texture;
  readonly fabricNormal: THREE.Texture;
  readonly ribNormal: THREE.Texture;
  readonly scratchRough: THREE.Texture;
  readonly meshNormal: THREE.Texture;

  // Shared PBR materials.
  readonly darkMetal: THREE.MeshStandardMaterial;
  readonly gunmetal: THREE.MeshStandardMaterial;
  readonly chrome: THREE.MeshStandardMaterial;
  readonly carbon: THREE.MeshPhysicalMaterial;
  readonly glass: THREE.MeshPhysicalMaterial;
  readonly rubber: THREE.MeshStandardMaterial;

  constructor() {
    const rng = new Random(11);

    // Brushed metal: long horizontal streaks.
    {
      const [c, g] = canvas(256, 256);
      g.fillStyle = '#808080';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 1400; i++) {
        const v = 100 + rng.int(0, 60);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.globalAlpha = 0.35;
        g.fillRect(rng.range(-40, 256), rng.range(0, 256), rng.range(30, 160), rng.range(0.5, 1.4));
      }
      g.globalAlpha = 1;
      this.brushedNormal = heightToNormal(c, 1.2, [2, 2]);
      this.brushedRough = tex(c, [2, 2], false);
    }
    // Carbon fibre twill.
    {
      const [c, g] = canvas(128, 128);
      const [cc, gc] = canvas(128, 128);
      const cell = 16;
      for (let y = 0; y < 128; y += cell) {
        for (let x = 0; x < 128; x += cell) {
          const horiz = ((x + y) / cell) % 2 === 0;
          const grd = horiz ? g.createLinearGradient(x, y, x, y + cell) : g.createLinearGradient(x, y, x + cell, y);
          grd.addColorStop(0, '#303030');
          grd.addColorStop(0.5, '#d0d0d0');
          grd.addColorStop(1, '#303030');
          g.fillStyle = grd;
          g.fillRect(x, y, cell, cell);
          const gg = horiz ? gc.createLinearGradient(x, y, x, y + cell) : gc.createLinearGradient(x, y, x + cell, y);
          gg.addColorStop(0, '#0b0c0f');
          gg.addColorStop(0.5, '#2a2d33');
          gg.addColorStop(1, '#0b0c0f');
          gc.fillStyle = gg;
          gc.fillRect(x, y, cell, cell);
        }
      }
      this.carbonNormal = heightToNormal(c, 2.2, [6, 6]);
      this.carbonColor = tex(cc, [6, 6], true);
    }
    // Fabric (cotton fleece) weave.
    {
      const [c, g] = canvas(128, 128);
      g.fillStyle = '#7f7f7f';
      g.fillRect(0, 0, 128, 128);
      for (let y = 0; y < 128; y += 2) {
        for (let x = 0; x < 128; x += 2) {
          const v = 110 + ((x + y) % 4 === 0 ? 40 : 0) + rng.int(-18, 18);
          g.fillStyle = `rgb(${v},${v},${v})`;
          g.fillRect(x, y, 2, 2);
        }
      }
      this.fabricNormal = heightToNormal(c, 1.4, [10, 10]);
    }
    // Knit rib (cuffs, hem, waistband).
    {
      const [c, g] = canvas(64, 64);
      for (let x = 0; x < 64; x++) {
        const v = 128 + Math.sin((x / 64) * Math.PI * 16) * 90;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(x, 0, 1, 64);
      }
      this.ribNormal = heightToNormal(c, 3, [4, 1]);
    }
    // Micro scratches (roughness variation).
    {
      const [c, g] = canvas(256, 256);
      g.fillStyle = '#6a6a6a';
      g.fillRect(0, 0, 256, 256);
      g.strokeStyle = '#b0b0b0';
      for (let i = 0; i < 220; i++) {
        g.globalAlpha = rng.range(0.1, 0.5);
        g.lineWidth = rng.range(0.4, 1.2);
        g.beginPath();
        const x = rng.range(0, 256);
        const y = rng.range(0, 256);
        const a = rng.range(0, Math.PI);
        const l = rng.range(6, 40);
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        g.stroke();
      }
      g.globalAlpha = 1;
      this.scratchRough = tex(c, [3, 3], false);
    }
    // Sneaker mesh (engineered knit).
    {
      const [c, g] = canvas(128, 128);
      g.fillStyle = '#909090';
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#404040';
      for (let y = 0; y < 128; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < 128; x += 8) {
        g.beginPath();
        g.arc(x, y, 2.4, 0, Math.PI * 2);
        g.fill();
      }
      this.meshNormal = heightToNormal(c, 1.6, [5, 5]);
    }

    this.darkMetal = new THREE.MeshStandardMaterial({
      color: 0x161a22, metalness: 0.85, roughness: 0.42, normalMap: this.brushedNormal, roughnessMap: this.brushedRough, normalScale: new THREE.Vector2(0.35, 0.35),
    });
    this.gunmetal = new THREE.MeshStandardMaterial({
      color: 0x3a4250, metalness: 0.9, roughness: 0.32, normalMap: this.brushedNormal, roughnessMap: this.scratchRough, normalScale: new THREE.Vector2(0.4, 0.4),
    });
    this.chrome = new THREE.MeshStandardMaterial({ color: 0xc8d0dc, metalness: 1, roughness: 0.14, roughnessMap: this.scratchRough });
    this.carbon = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, map: this.carbonColor, metalness: 0.2, roughness: 0.35, normalMap: this.carbonNormal, normalScale: new THREE.Vector2(0.6, 0.6),
      clearcoat: 1, clearcoatRoughness: 0.08,
    });
    this.glass = new THREE.MeshPhysicalMaterial({
      color: 0x9fdcff, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.22, envMapIntensity: 2.2, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false,
    });
    this.rubber = new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0, roughness: 0.85 });
  }
}
