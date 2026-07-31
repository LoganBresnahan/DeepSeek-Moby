/**
 * Minimal typed emitter matching vscode.EventEmitter's contract
 * (.event(listener) => Disposable, .fire(data), .dispose()) so modules can
 * publish events without importing vscode — keeping them out of the test
 * mock's blast radius. Swap in for vscode.EventEmitter only where the
 * emitter never crosses into API surfaces that require the real type.
 */

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class TypedEmitter<T> {
  private listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(data: T): void {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
