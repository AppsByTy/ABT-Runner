import * as THREE from 'three';

/**
 * Cel-shaded materials with a fresnel rim light, giving characters the
 * anime "neon edge glow" look. All toon materials share one gradient ramp.
 */
let ramp: THREE.DataTexture | null = null;

function gradientRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const tones = new Uint8Array([70, 70, 70, 255, 165, 165, 165, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(tones, 3, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

export interface ToonOptions {
  color: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  rim?: THREE.ColorRepresentation;
  rimStrength?: number;
  rimPower?: number;
  vertexColors?: boolean;
  map?: THREE.Texture;
  side?: THREE.Side;
  /** Follow the character-wide rim override (power-up transformations). */
  global?: boolean;
}

/** Shared rim override for the player character (debug mode, admin, boosts). */
export const CHARACTER_RIM = {
  color: { value: new THREE.Color(0x39ff6a) },
  mix: { value: 0 },
  boost: { value: 1.6 },
};
const NO_OVERRIDE = { color: { value: new THREE.Color() }, mix: { value: 0 }, boost: { value: 0 } };

export function toon(o: ToonOptions): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    color: o.color,
    gradientMap: gradientRamp(),
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.emissiveIntensity ?? 1,
    vertexColors: o.vertexColors ?? false,
    map: o.map ?? null,
    side: o.side ?? THREE.FrontSide,
  });
  const rimColor = new THREE.Color(o.rim ?? 0xff2bd6);
  const rimStrength = o.rimStrength ?? 1.2;
  const rimPower = o.rimPower ?? 2.6;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: rimStrength };
    shader.uniforms.uRimPower = { value: rimPower };
    const g = o.global ? CHARACTER_RIM : NO_OVERRIDE;
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
  mat.customProgramCacheKey = () => 'toon-rim';
  return mat;
}
