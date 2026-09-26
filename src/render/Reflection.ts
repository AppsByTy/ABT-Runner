import * as THREE from 'three';

/**
 * Planar mirror for the y = 0 floor (the data streams). Renders the scene
 * from a camera mirrored below the floor into a low-res target, with an
 * oblique near plane so nothing under the floor leaks in. The road shader
 * samples it through `textureMatrix` for glossy neon reflections.
 */
export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  private readonly cam = new THREE.PerspectiveCamera();
  private readonly scale: number;
  private readonly plane = new THREE.Plane();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly origin = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();
  private readonly look = new THREE.Vector3();
  private readonly target3 = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();

  constructor(width: number, height: number, scale: number) {
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(Math.max(64, width * scale), Math.max(64, height * scale), { type: THREE.HalfFloatType });
    this.target.texture.generateMipmaps = false;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(64, width * this.scale), Math.max(64, height * this.scale));
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hide: THREE.Object3D[]): void {
    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    this.view.subVectors(this.origin, this.camPos);
    if (this.view.dot(this.normal) > 0) return; // camera under the floor
    this.view.reflect(this.normal).negate().add(this.origin);

    this.rot.extractRotation(camera.matrixWorld);
    this.look.set(0, 0, -1).applyMatrix4(this.rot).add(this.camPos);
    this.target3.subVectors(this.origin, this.look).reflect(this.normal).negate().add(this.origin);

    const vc = this.cam;
    vc.position.copy(this.view);
    vc.up.set(0, 1, 0).applyMatrix4(this.rot).reflect(this.normal);
    vc.lookAt(this.target3);
    vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // Oblique near plane = the floor (Lengyel's technique, as in three's Reflector).
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.origin);
    this.plane.applyMatrix4(vc.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = vc.projectionMatrix;
    this.q.x = (Math.sign(this.clip.x) + pm.elements[8]) / pm.elements[0];
    this.q.y = (Math.sign(this.clip.y) + pm.elements[9]) / pm.elements[5];
    this.q.z = -1.0;
    this.q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    this.clip.multiplyScalar(2.0 / this.clip.dot(this.q));
    pm.elements[2] = this.clip.x;
    pm.elements[6] = this.clip.y;
    pm.elements[10] = this.clip.z + 1.0 - 0.003;
    pm.elements[14] = this.clip.w;

    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, vc);
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = prevXr;
    hide.forEach((o, i) => (o.visible = vis[i]));
  }
}
