/**
 * Serializes tasks that consume a one-shot server key pool.
 *
 * Each `teeIndiv4App` fetch invalidates the previous pool, so two overlapping
 * signed requests make the earlier envelope undecryptable (12110009). Keeping
 * fetch -> sign -> send inside one queue per SessionStore makes it atomic.
 */
export class SerialCallQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }
}
