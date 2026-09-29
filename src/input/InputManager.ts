export type InputAction = 'left' | 'right' | 'jump' | 'slide' | 'pause' | 'confirm';

/**
 * Keyboard + swipe input. Swipes fire as soon as the finger passes the
 * threshold (not on release) so lane changes feel instant on touch devices.
 * Pointer events cover touch, pen and mouse-drag (handy for desktop testing).
 */
export class InputManager {
  private listeners = new Set<(a: InputAction) => void>();
  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private startT = 0;
  private consumed = false;
  private readonly surface: HTMLElement;

  constructor(surface: HTMLElement) {
    this.surface = surface;
    window.addEventListener('keydown', this.onKey);
    surface.addEventListener('pointerdown', this.onDown, { passive: false });
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
    // Stop iOS rubber-banding / double-tap zoom stealing gestures.
    surface.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  onAction(fn: (a: InputAction) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Programmatic input (used by on-screen buttons and automated tests). */
  trigger(a: InputAction): void {
    for (const fn of this.listeners) fn(a);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    let a: InputAction | null = null;
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        a = 'left';
        break;
      case 'ArrowRight':
      case 'KeyD':
        a = 'right';
        break;
      case 'ArrowUp':
      case 'KeyW':
      case 'Space':
        a = 'jump';
        break;
      case 'ArrowDown':
      case 'KeyS':
        a = 'slide';
        break;
      case 'Escape':
      case 'KeyP':
        a = 'pause';
        break;
      case 'Enter':
      case 'KeyE':
      case 'KeyF':
        a = 'confirm';
        break;
    }
    if (a) {
      e.preventDefault();
      this.trigger(a);
    }
  };

  private threshold(): number {
    const m = Math.min(window.innerWidth, window.innerHeight);
    return Math.max(22, m * 0.045);
  }

  private onDown = (e: PointerEvent): void => {
    if ((e.target as HTMLElement).closest('[data-ui]')) return;
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startT = performance.now();
    this.consumed = false;
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId || this.consumed) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    const t = this.threshold();
    if (Math.abs(dx) < t && Math.abs(dy) < t) return;
    this.consumed = true;
    if (Math.abs(dx) > Math.abs(dy)) this.trigger(dx < 0 ? 'left' : 'right');
    else this.trigger(dy < 0 ? 'jump' : 'slide');
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    // Forgiving taps: a short press that never became a swipe.
    const quick = performance.now() - this.startT < 380;
    if (!this.consumed && quick) this.trigger('confirm');
    this.pointerId = null;
  };

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId === this.pointerId) this.pointerId = null;
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.surface.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
  }
}
