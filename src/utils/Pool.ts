/** Generic object pool. `active` is iterated by owners; release swaps-and-pops. */
export class Pool<T> {
  readonly active: T[] = [];
  private readonly free: T[] = [];
  private readonly factory: () => T;
  private readonly onAcquire?: (item: T) => void;
  private readonly onRelease?: (item: T) => void;

  constructor(factory: () => T, onAcquire?: (item: T) => void, onRelease?: (item: T) => void, prewarm = 0) {
    this.factory = factory;
    this.onAcquire = onAcquire;
    this.onRelease = onRelease;
    for (let i = 0; i < prewarm; i++) {
      const item = factory();
      onRelease?.(item);
      this.free.push(item);
    }
  }

  acquire(): T {
    const item = this.free.pop() ?? this.factory();
    this.onAcquire?.(item);
    this.active.push(item);
    return item;
  }

  releaseAt(index: number): void {
    const item = this.active[index];
    const last = this.active.pop()!;
    if (index < this.active.length) this.active[index] = last;
    this.onRelease?.(item);
    this.free.push(item);
  }

  release(item: T): void {
    const i = this.active.indexOf(item);
    if (i >= 0) this.releaseAt(i);
  }

  releaseAll(): void {
    while (this.active.length) this.releaseAt(this.active.length - 1);
  }

  get size(): number {
    return this.active.length + this.free.length;
  }
}
