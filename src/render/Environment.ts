import * as THREE from 'three';
import { STAGES } from '../core/Theme';

/**
 * Procedural image-based lighting. For every corruption stage we build a
 * small "neon server room" scene (dark shell + emissive light strips in that
 * stage's colours) and bake it into a prefiltered PMREM environment map.
 * Metals, glass and clearcoats reflect it, which is what makes surfaces read
 * as real materials instead of flat plastic.
 */
export class EnvironmentMaps {
  /** Baked maps, most recently used last. Only a few are kept on the GPU at once (phone memory). */
  private readonly maps = new Map<string, THREE.WebGLRenderTarget>();
  private readonly pmrem: THREE.PMREMGenerator;
  private static readonly KEEP = 3;

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.get('stage1');
  }

  get(key: string): THREE.Texture {
    let rt = this.maps.get(key);
    if (rt) {
      this.maps.delete(key);
    } else {
      rt = this.bakeKey(key);
      while (this.maps.size >= EnvironmentMaps.KEEP) {
        const [oldKey, old] = this.maps.entries().next().value!;
        this.maps.delete(oldKey);
        old.dispose();
      }
    }
    this.maps.set(key, rt);
    return rt.texture;
  }

  /** Bake ahead of time (e.g. the next stage) so the switch itself is instant. */
  prewarm(key: string): void {
    if (this.maps.has(key)) return;
    const current = [...this.maps.keys()].pop();
    this.get(key);
    if (current) this.get(current); // keep the active one most-recent
  }

  private bakeKey(key: string): THREE.WebGLRenderTarget {
    if (key === 'debug') return this.bake('#39ff6a', '#1aff9a', '#010d05', false);
    if (key === 'admin') return this.bake('#ffd23a', '#fff1b0', '#140d02', true);
    const st = STAGES.find((s) => `stage${s.id}` === key) ?? STAGES[0];
    return this.bake(st.primary, st.secondary, st.void, st.id === 7);
  }

  private bake(primary: string, secondary: string, voidColor: string, core: boolean): THREE.WebGLRenderTarget {
    const scene = new THREE.Scene();
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(40, 20, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(voidColor).multiplyScalar(1.6), side: THREE.BackSide }),
    );
    shell.position.y = 6;
    scene.add(shell);
    const strip = (color: string, k: number, w: number, h: number, d: number, x: number, y: number, z: number): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) }));
      m.position.set(x, y, z);
      scene.add(m);
    };
    // Overhead soft white key strips (give metals a readable highlight).
    for (let i = -2; i <= 2; i++) strip('#dfe8ff', 2.2, 1.2, 0.2, 30, i * 5, 15.5, 0);
    // Neon wall strips in the stage palette.
    for (let i = 0; i < 6; i++) {
      strip(primary, 5, 0.3, 14, 0.3, -19.5, 6, -15 + i * 6);
      strip(secondary, 4, 0.3, 14, 0.3, 19.5, 6, -15 + i * 6 + 3);
    }
    strip(primary, 6, 36, 0.4, 0.4, 0, 1, -19.5);
    strip(secondary, 5, 36, 0.4, 0.4, 0, 1, 19.5);
    // Horizon glow band.
    strip(primary, 3, 38, 2.5, 0.3, 0, 4, -19.6);
    if (core) strip('#ffffff', 6, 8, 8, 0.3, 0, 8, -19.6);
    // Floor with faint coloured bounce.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(primary).multiplyScalar(0.08) }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -3.9;
    scene.add(floor);
    const rt = this.pmrem.fromScene(scene, 0.035);
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    return rt;
  }
}
