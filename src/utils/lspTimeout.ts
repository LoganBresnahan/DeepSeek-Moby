/**
 * Timeout wrapper for LSP `vscode.commands.executeCommand` calls.
 *
 * VS Code's command proxy doesn't expose a timeout; a misbehaving language
 * server (cold rust-analyzer, deadlocked Pylance, hung gopls indexer) can
 * leave a tool call awaiting forever. Wrapping every LSP call in
 * `withLspTimeout` guarantees the tool returns within a bounded time —
 * either with the LSP's result or with a `LspTimeoutError` the caller can
 * convert into a user-visible "timed out" message.
 *
 * Distinct from the older `raceTimeout` helper that resolved `undefined`
 * on both timeout and error — that loses information the tool surface
 * needs ("server hung" reads differently to the model than "no results").
 * `withLspTimeout` throws `LspTimeoutError` on timeout and re-throws the
 * original error on rejection, so callers can branch cleanly.
 */

export class LspTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`LSP request timed out after ${timeoutMs}ms`);
    this.name = 'LspTimeoutError';
  }
}

/**
 * Race `promise` against `timeoutMs`. Resolves with the promise's value
 * if it settles in time; throws `LspTimeoutError` if the timer wins;
 * re-throws the underlying error if the promise rejects.
 */
export function withLspTimeout<T>(promise: Thenable<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new LspTimeoutError(timeoutMs));
      }
    }, timeoutMs);
    Promise.resolve(promise).then(
      (val) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(val);
        }
      },
      (err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    );
  });
}
