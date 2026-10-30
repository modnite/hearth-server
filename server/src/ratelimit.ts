/** Tiny in-memory failure limiter for login and registration. */
export class FailureLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private recent(key: string, at: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until another attempt is allowed, or 0 if the key is not blocked. */
  blockedFor(key: string, at = Date.now()): number {
    const list = this.recent(key, at);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - at) / 1000));
  }

  fail(key: string, at = Date.now()): void {
    const list = this.recent(key, at);
    list.push(at);
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(): void {
    const at = Date.now();
    for (const key of [...this.hits.keys()]) this.recent(key, at);
  }
}
