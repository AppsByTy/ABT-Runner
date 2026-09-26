import type * as THREE from 'three';

/**
 * Guards against a black 3D view on devices whose GPU/driver rejects part of
 * the render pipeline (typically iOS: half-float / multisampled targets, or a
 * shader producing NaNs). For the first seconds it samples a few pixels of
 * the finished frame; if the frame keeps coming out pure black it asks the
 * game to step down (see GameManager.recoverBlackScreen). Also collects
 * shader / WebGL errors for the on-screen diagnostics panel.
 */
export class RenderWatchdog {
  readonly errors: string[] = [];
  done = false;
  private dark = 0;
  private good = 0;
  private readonly px = new Uint8Array(4);

  constructor(renderer: THREE.WebGLRenderer) {
    const canvas = renderer.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.log('WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => location.reload());
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const clip = (t: string | null): string => (t ?? '').trim().slice(0, 300);
      this.log(`shader error: ${clip(gl.getProgramInfoLog(program))} ${clip(gl.getShaderInfoLog(vs))} ${clip(gl.getShaderInfoLog(fs))}`);
      console.error('[shader]', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs));
    };
    window.addEventListener('error', (e) => this.log(`error: ${e.message}`));
    window.addEventListener('unhandledrejection', (e) => this.log(`rejection: ${String(e.reason).slice(0, 200)}`));
  }

  log(msg: string): void {
    if (this.errors.length < 12) this.errors.push(msg);
  }

  /**
   * Call right after the frame was drawn to the screen.
   * @returns true when the frame has been black long enough to act on.
   */
  check(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
    if (this.done) return false;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    let lit = 0;
    for (let i = 1; i <= 3; i++) {
      for (let j = 1; j <= 3; j++) {
        gl.readPixels(Math.floor((w * i) / 4), Math.floor((h * j) / 4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
        if (this.px[0] + this.px[1] + this.px[2] > 12) lit++;
      }
    }
    if (lit >= 2) {
      this.dark = 0;
      if (++this.good >= 30) this.done = true;
      return false;
    }
    this.good = 0;
    if (++this.dark >= 6) {
      this.dark = 0;
      return true;
    }
    return false;
  }
}

/** Small copy-able diagnostics panel (shown with ?diag, or if the 3D view can't be recovered). */
export function showDiagnostics(renderer: THREE.WebGLRenderer, lines: string[]): void {
  let el = document.getElementById('diag');
  if (!el) {
    el = document.createElement('div');
    el.id = 'diag';
    el.setAttribute('data-ui', '');
    el.style.cssText =
      'position:fixed;left:8px;right:8px;bottom:calc(env(safe-area-inset-bottom,0px) + 8px);z-index:99;max-height:40vh;overflow:auto;' +
      'padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.82);border:1px solid rgba(255,80,110,.6);color:#ffd6de;' +
      'font:11px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;user-select:text;-webkit-user-select:text;pointer-events:auto';
    document.body.appendChild(el);
  }
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  el.textContent = [
    'GRAPHICS DIAGNOSTICS (screenshot this for support)',
    `gpu: ${gpu}`,
    `webgl2: ${renderer.capabilities.isWebGL2} · maxTex ${renderer.capabilities.maxTextureSize} · dpr ${window.devicePixelRatio}`,
    `ua: ${navigator.userAgent}`,
    ...lines,
  ].join('\n');
}
