import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { rimify } from '../utils/rim';

/**
 * Sculpted, textured, rigged 3D model of the runner (generated from the
 * AppsByTy character art) driven by the existing animation system:
 *
 *  - The RUN is the model's own motion-captured clip, time-locked to the
 *    gameplay stride phase so footsteps stay in sync with speed.
 *  - Everything else (jump tuck, slide, idle stance, landing, flinch, death)
 *    is retargeted live from the procedural rig: each procedural joint's
 *    local rotation is converted into the model's bone space.
 *  - A skinned inverted-hull outline gives the bold, readable silhouette of
 *    premium mobile runners.
 */

/** Procedural joint -> model bone. */
const MAP: Record<string, string> = {
  hips: 'Hips',
  spine: 'Spine02',
  chest: 'Spine01',
  neck: 'neck',
  head: 'Head',
  thighL: 'LeftUpLeg',
  kneeL: 'LeftLeg',
  footL: 'LeftFoot',
  thighR: 'RightUpLeg',
  kneeR: 'RightLeg',
  footR: 'RightFoot',
  shoulderL: 'LeftArm',
  elbowL: 'LeftForeArm',
  handL: 'LeftHand',
  shoulderR: 'RightArm',
  elbowR: 'RightForeArm',
  handR: 'RightHand',
};

interface Bound {
  bone: THREE.Bone;
  /** Parent's bind-pose orientation in model space. */
  pBind: THREE.Quaternion;
  pBindInv: THREE.Quaternion;
  /** Extra rest correction (A-pose arms -> relaxed), bone-local. */
  rest: THREE.Quaternion | null;
  /** Bind-pose local rotation (reset every frame before blending). */
  bind: THREE.Quaternion;
}

const OUTLINE_VERT = /* glsl */ `
  uniform float uOutline;
`;

export class ModelAvatar {
  /** Add to the character body group; rotated to face the run direction. */
  readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly run: THREE.AnimationAction | null;
  private readonly runDuration: number;
  private readonly bound = new Map<string, Bound>();
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();
  private readonly qI = new THREE.Quaternion();
  private readonly R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  private readonly feet: [THREE.Bone | null, THREE.Bone | null];
  /** Stride phase (radians) at which the clip's left foot plants. */
  phaseOffset = 0;
  readonly outlineUniform = { value: 0.9 };

  constructor(gltf: GLTF, albedo: THREE.Texture | null = null) {
    const scene = gltf.scene;
    this.root.add(scene);

    // Materials: the generator bakes the texture into emissive and marks it
    // fully metallic - convert to a lit, fabric-like stylized surface.
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const src = mesh.material as THREE.MeshStandardMaterial;
      const mat = new THREE.MeshStandardMaterial({
        map: albedo ?? src.map,
        color: 0xd8d8d8,
        roughness: 0.82,
        metalness: 0,
        envMapIntensity: 0.35,
      });
      if (mat.map) {
        mat.map.colorSpace = THREE.SRGBColorSpace;
        mat.map.anisotropy = 8;
      }
      mesh.material = rimify(mat, '#9fe8ff', 0.45, 2.6);
      if (mesh.isSkinnedMesh) this.addOutline(mesh);
    });

    // Bind-pose bookkeeping.
    scene.updateMatrixWorld(true);
    const rootInv = new THREE.Quaternion();
    scene.getWorldQuaternion(rootInv).invert();
    const bones = new Map<string, THREE.Bone>();
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    });
    for (const [joint, name] of Object.entries(MAP)) {
      const bone = bones.get(name);
      if (!bone) continue;
      const pBind = new THREE.Quaternion();
      bone.parent!.getWorldQuaternion(pBind);
      pBind.premultiply(rootInv);
      this.bound.set(joint, { bone, pBind, pBindInv: pBind.clone().invert(), rest: null, bind: bone.quaternion.clone() });
    }
    // A-pose -> relaxed arms hanging slightly out from the body.
    for (const [side, arm, fore] of [
      [1, 'shoulderL', 'LeftForeArm'],
      [-1, 'shoulderR', 'RightForeArm'],
    ] as const) {
      const b = this.bound.get(arm);
      const f = bones.get(fore);
      if (!b || !f) continue;
      const a = new THREE.Vector3().setFromMatrixPosition(b.bone.matrixWorld);
      const e = new THREE.Vector3().setFromMatrixPosition(f.matrixWorld);
      const dir = e.sub(a).normalize();
      const target = new THREE.Vector3(side * 0.16, -1, 0.02).normalize();
      const qm = new THREE.Quaternion().setFromUnitVectors(dir, target);
      // Rotation expressed in the arm's own bind frame.
      const own = b.pBind.clone().multiply(b.bone.quaternion);
      b.rest = own.clone().invert().multiply(qm).multiply(own);
    }
    this.feet = [bones.get('LeftFoot') ?? null, bones.get('RightFoot') ?? null];

    this.mixer = new THREE.AnimationMixer(scene);
    const clip = gltf.animations.find((a) => /run/i.test(a.name)) ?? gltf.animations[0] ?? null;
    if (clip) {
      // In-place: keep the vertical bob, drop forward / sideways root travel.
      for (const t of clip.tracks) {
        if (t.name === 'Hips.position') {
          const v = t.values;
          for (let i = 0; i < v.length; i += 3) {
            v[i] = v[0];
            v[i + 2] = v[2];
          }
        }
      }
      this.run = this.mixer.clipAction(clip);
      this.run.play();
      this.run.setEffectiveWeight(0);
      this.runDuration = clip.duration;
      // Sync the clip's left-foot plant with the gameplay stride phase (pi/2).
      let best = 0;
      let lowest = Infinity;
      const p = new THREE.Vector3();
      this.run.setEffectiveWeight(1);
      for (let i = 0; i < 32; i++) {
        this.run.time = (i / 32) * clip.duration;
        this.mixer.update(0);
        scene.updateMatrixWorld(true);
        const y = this.feet[0] ? this.feet[0].getWorldPosition(p).y : 0;
        if (y < lowest) {
          lowest = y;
          best = i / 32;
        }
      }
      this.phaseOffset = best * Math.PI * 2 - Math.PI / 2;
      this.run.setEffectiveWeight(0);
      this.mixer.update(0);
      for (const b of this.bound.values()) b.bone.quaternion.copy(b.bind);
    } else {
      this.run = null;
      this.runDuration = 1;
    }
    // Orient last so all bind-pose measurements above are in model space.
    this.root.rotation.y = Math.PI; // model faces +Z; the runner faces -Z
    this.root.scale.setScalar(1.08); // a touch of hero scale for readability
  }

  private addOutline(mesh: THREE.SkinnedMesh): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0x07070c, side: THREE.BackSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uOutline = this.outlineUniform;
      shader.vertexShader = OUTLINE_VERT + shader.vertexShader.replace(
        '#include <skinning_vertex>',
        '#include <skinning_vertex>\n  transformed += normalize(objectNormal) * uOutline;',
      );
    };
    mat.customProgramCacheKey = () => 'avatar-outline';
    const outline = new THREE.SkinnedMesh(mesh.geometry, mat);
    outline.bind(mesh.skeleton, mesh.bindMatrix);
    outline.frustumCulled = false;
    outline.renderOrder = -1;
    mesh.parent!.add(outline);
    outline.position.copy(mesh.position);
    outline.quaternion.copy(mesh.quaternion);
    outline.scale.copy(mesh.scale);
  }

  /**
   * @param joints procedural joint rotations (already smoothed, run excluded)
   * @param runWeight 0..1 blend of the running clip
   * @param phase stride phase (radians) from the gameplay animation
   */
  update(joints: Record<string, THREE.Object3D>, runWeight: number, phase: number): void {
    // Bones not driven by an active clip keep their last value, so reset first.
    for (const b of this.bound.values()) b.bone.quaternion.copy(b.bind);
    if (this.run) {
      const cyc = ((((phase + this.phaseOffset) / (Math.PI * 2)) % 1) + 1) % 1;
      this.run.time = cyc * this.runDuration;
      this.run.setEffectiveWeight(runWeight);
    }
    this.mixer.update(0);

    const qA = this.qA;
    const qB = this.qB;
    for (const [joint, b] of this.bound) {
      // Rest correction fades out while the clip (which has its own arm pose) plays.
      if (b.rest) {
        qA.copy(this.qI).slerp(b.rest, 1 - runWeight);
        b.bone.quaternion.multiply(qA);
      }
      const src = joints[joint];
      if (!src) continue;
      // Procedural local rotation, character space -> model space -> parent-bind space.
      qB.copy(src.quaternion);
      qB.premultiply(this.R).multiply(this.R); // R^-1 == R for a half turn (up to sign)
      qA.copy(b.pBindInv).multiply(qB).multiply(b.pBind);
      b.bone.quaternion.premultiply(qA);
    }
  }

  getFootWorld(side: 0 | 1, out: THREE.Vector3): THREE.Vector3 | null {
    const f = this.feet[side];
    if (!f) return null;
    return f.getWorldPosition(out);
  }
}

/** Decode a data: URL (inlined asset) to bytes without fetch() (works under strict page CSPs). */
function dataUrlBytes(url: string): Uint8Array<ArrayBuffer> {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function bytesOf(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('data:')) return dataUrlBytes(url).buffer;
  return (await fetch(url)).arrayBuffer();
}

/**
 * Load the runner model. Deliberately avoids every browser feature a strict
 * embed can block: no network fetch for inlined assets, no WebAssembly
 * decoders, no blob:/data: image URLs (the texture is decoded straight from
 * bytes with createImageBitmap).
 */
export async function loadAvatar(meshUrl: string, albedoUrl: string): Promise<ModelAvatar> {
  const [meshBuf, texBuf] = await Promise.all([bytesOf(meshUrl), bytesOf(albedoUrl)]);
  const gltf = await new GLTFLoader().parseAsync(meshBuf, '');
  let albedo: THREE.Texture | null = null;
  try {
    const bmp = await createImageBitmap(new Blob([texBuf], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    albedo = new THREE.Texture(bmp);
    albedo.flipY = false;
    albedo.colorSpace = THREE.SRGBColorSpace;
    albedo.needsUpdate = true;
  } catch {
    albedo = null;
  }
  return new ModelAvatar(gltf, albedo);
}
