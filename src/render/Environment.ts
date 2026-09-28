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
  /**
   * All maps are baked once at startup at 128px (the lighting is heavily
   * blurred, so this looks identical to 256px at a quarter of the memory)
   * and never reallocated mid-run: no GPU allocation spikes when a stage
   * changes or a power-up starts.
   */
  private readonly maps = new Map<string, THREE.WebGLRenderTarget>();
  private readonly pmrem: THREE.PMREMGenerator;

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    for (const st of STAGES) this.maps.set(`stage${st.id}`, this.bakeKey(`stage${st.id}`));
    this.maps.set('debug', this.bakeKey('debug'));
    this.maps.set('admin', this.bakeKey('admin'));
    this.pmrem.dispose();
  }

  get(key: string): THREE.Texture {
    return (this.maps.get(key) ?? this.maps.get('stage1')!).texture;
  }

  /** Kept for API compatibility: everything is pre-baked. */
  prewarm(_key: string): void {}

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
    const rt = this.pmrem.fromScene(scene, 0.035, 0.1, 100, { size: 128 });
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    return rt;
  }
}
