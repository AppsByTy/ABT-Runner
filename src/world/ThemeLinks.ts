import * as THREE from 'three';
import { THEME } from '../core/Theme';

type Slot = 'primary' | 'secondary';

/** Unlit glow materials whose colour follows the current stage palette. */
export class ThemeLinks {
  private readonly links: { mat: THREE.MeshBasicMaterial; slot: Slot; k: number }[] = [];

  basic(slot: Slot, intensity: number, opts: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial(opts);
    this.links.push({ mat, slot, k: intensity });
    this.apply();
    return mat;
  }

  apply(): void {
    for (const l of this.links) {
      const src = l.slot === 'primary' ? THEME.uPrimary.value : THEME.uSecondary.value;
      l.mat.color.copy(src).multiplyScalar(l.k);
    }
  }
}
