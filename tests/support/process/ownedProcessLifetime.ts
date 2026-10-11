/** Controller-owned activity must settle before any dependency is released. */
export class OwnedProcessLifetime {
  readonly #active = new Set<Promise<unknown>>();
  readonly #failures: unknown[] = [];
  readonly #abort = new AbortController();
  #closing = false;
  #settling: Promise<void> | undefined;

  get failures(): readonly unknown[] {
    return [...this.#failures];
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  retainFailure(cause: unknown): void {
    this.#failures.push(cause);
  }

  beginShutdown(): void {
    this.#closing = true;
    if (!this.#abort.signal.aborted)
      this.#abort.abort(new Error("Owned producer lifetime shutdown"));
  }

  assertOpen(): void {
    if (this.#closing) throw new Error("Owned producer lifetime is closing");
  }

  run<T>(start: () => Promise<T>): Promise<T> {
    if (this.#closing)
      return Promise.reject(new Error("Owned producer lifetime is closing"));
    // Register before calling start, which may reach its first await immediately.
    const task = Promise.resolve().then(start);
    this.#active.add(task);
    void task.then(
      () => this.#active.delete(task),
      (cause: unknown) => {
        this.retainFailure(cause);
        this.#active.delete(task);
      },
    );
    return task;
  }

  settle(): Promise<void> {
    this.beginShutdown();
    this.#settling ??= (async () => {
      while (this.#active.size) await Promise.allSettled(this.#active);
    })();
    return this.#settling;
  }
}
