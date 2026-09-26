import * as THREE from 'three';
import { CHARACTER_RIM } from './toon';

/**
 * Adds a fresnel rim light to any lit material (standard/physical), with the
 * optional character-wide override used for power-up transformations.
 */
export function rimify<T extends THREE.MeshStandardMaterial>(mat: T, color: THREE.ColorRepresentation, strength: number, power = 3, global = true): T {
  const rimColor = new THREE.Color(color);
  const g = global ? CHARACTER_RIM : { color: { value: new THREE.Color() }, mix: { value: 0 }, boost: { value: 0 } };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r);
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: strength };
    shader.uniforms.uRimPower = { value: power };
    shader.uniforms.uGRim = g.color;
    shader.uniforms.uGMix = g.mix;
    shader.uniforms.uGBoost = g.boost;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uRimPower;\nuniform vec3 uGRim;\nuniform float uGMix;\nuniform float uGBoost;',
      )
      .replace(
        '#include <opaque_fragment>',
        `float rimF = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
         vec3 rimC = mix(uRimColor, uGRim, uGMix);
         outgoingLight += rimC * pow(rimF, mix(uRimPower, 1.8, uGMix)) * (uRimStrength + uGMix * uGBoost);
         #include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `rim-${mat.type}-${global ? 1 : 0}-${!!mat.map}-${!!mat.normalMap}-${mat.vertexColors}`;
  return mat;
}
