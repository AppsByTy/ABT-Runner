import type * as THREE from 'three';

/**
 * Guards against a black 3D view on devices whose GPU/driver rejects part of
 * the render pipeline (typically iOS: half-float / multisampled targets, or a
 * shader producing NaNs). For the first seconds it samples a few pixels of
 * the finished frame; if the frame keeps coming out pure black it asks the
 * game to step down (see GameManager.recoverBlackScreen).
 *
 * It also reports GPU context loss / restoration to the game (which pauses
 * and rebuilds its GPU resources in place - the page is never reloaded) and
 * keeps a tiny flight recorder so a session the OS kills can be explained on
 * the next launch.
 */
export class RenderWatchdog {
  readonly errors: string[] = [];
  /** What ended the previous session abnormally, if anything (shown once at launch). */
  previous: string | null = null;
  done = false;
  /** GPU context dropped by the browser/OS; the game must stop drawing until restored. */
  onContextLost: () => void = () => {};
  /** GPU context is back; the game must rebuild GPU-only content (baked maps). */
  onContextRestored: () => void = () => {};
  private dark = 0;
  private good = 0;
  private readonly px = new Uint8Array(4);
  private readonly flight: FlightRecorder;

  constructor(renderer: THREE.WebGLRenderer) {
    const canvas = renderer.domElement;
    this.flight = new FlightRecorder();
    canvas.addEventListener('webglcontextlost', (e) => {
      // preventDefault tells the browser we will handle restoration.
      e.preventDefault();
      this.log('WebGL context lost');
      this.flight.note('gpu-lost');
      this.onContextLost();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.log('WebGL context restored');
      this.flight.note('gpu-restored');
      this.onContextRestored();
    });
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const clip = (t: string | null): string => (t ?? '').trim().slice(0, 300);
      this.log(`shader error: ${clip(gl.getProgramInfoLog(program))} ${clip(gl.getShaderInfoLog(vs))} ${clip(gl.getShaderInfoLog(fs))}`);
      console.error('[shader]', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs));
    };
    window.addEventListener('error', (e) => {
      this.log(`error: ${e.message}`);
      rememberError(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      this.log(`rejection: ${String(e.reason).slice(0, 200)}`);
      rememberError(`rejection: ${String(e.reason).slice(0, 200)}`);
    });
    // An error report / abnormal end from the previous session?
    const reports: string[] = [];
    try {
      const last = localStorage.getItem(CRASH_KEY);
      if (last) {
        localStorage.removeItem(CRASH_KEY);
        reports.push(last);
      }
    } catch {
      /* storage unavailable */
    }
    const ended = this.flight.previousEnding();
    if (ended) reports.push(ended);
    if (reports.length) this.previous = reports.join('\n');
  }

  log(msg: string): void {
    if (this.errors.length < 12) this.errors.push(msg);
  }

  /** Heartbeat for the flight recorder (call about once per second). */
  heartbeat(state: string, distance: number, fps: number): void {
    this.flight.beat(state, distance, fps);
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

const CRASH_KEY = 'coderunner.lastError.v1';
const FLIGHT_KEY = 'coderunner.flight.v1';

interface Flight {
  at: string;
  state: string;
  d: number;
  fps: number;
  /** Last GPU event: '' | 'gpu-lost' | 'gpu-restored'. */
  gpu: string;
  closed: boolean;
}

/**
 * Minimal flight recorder: a heartbeat in localStorage while the game runs,
 * marked closed when the page is left normally. If the next launch finds an
 * unclosed record, the previous page was killed (by iOS, usually for memory)
 * or lost its GPU context - which is otherwise indistinguishable from the
 * outside because both look like "the game reloaded".
 */
class FlightRecorder {
  private rec: Flight = { at: '', state: 'boot', d: 0, fps: 0, gpu: '', closed: false };
  private prev: Flight | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(FLIGHT_KEY);
      this.prev = raw ? (JSON.parse(raw) as Flight) : null;
    } catch {
      this.prev = null;
    }
    this.write();
    const close = (): void => {
      this.rec.closed = true;
      this.write();
    };
    const open = (): void => {
      this.rec.closed = false;
      this.write();
    };
    // Leaving the page or backgrounding the app is a normal end (iOS may
    // discard a background tab later - that is not a crash).
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', open);
    document.addEventListener('visibilitychange', () => (document.hidden ? close() : open()));
  }

  previousEnding(): string | null {
    const p = this.prev;
    if (!p || p.closed) return null;
    const where = `${p.state === 'playing' ? 'mid-run' : `in ${p.state}`} at ${Math.round(p.d)} m, ${p.fps} fps (${p.at})`;
    if (p.gpu === 'gpu-lost') return `GPU context lost and not restored ${where}`;
    if (p.state === 'boot') return null;
    return `page was killed by the system ${where}${p.gpu === 'gpu-restored' ? ' after a GPU reset' : ''}`;
  }

  beat(state: string, d: number, fps: number): void {
    this.rec.state = state;
    this.rec.d = d;
    this.rec.fps = Math.round(fps);
    this.write();
  }

  note(gpu: string): void {
    this.rec.gpu = gpu;
    this.write();
  }

  private write(): void {
    this.rec.at = new Date().toISOString();
    try {
      localStorage.setItem(FLIGHT_KEY, JSON.stringify(this.rec));
    } catch {
      /* storage unavailable */
    }
  }
}

/** Persist the latest error so it survives a page crash/reload (read back via ?diag). */
export function rememberError(msg: string): void {
  try {
    localStorage.setItem(CRASH_KEY, `${new Date().toISOString()} ${msg}`.slice(0, 800));
  } catch {
    /* ignore */
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
    el.addEventListener('click', () => el!.remove());
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
