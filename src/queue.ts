/**
 * Antrean pesan: serial per nomor (key) dan konkurensi global terbatas agar
 * CPU STB tidak kewalahan.
 */
export class MessageQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly concurrency = 2) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waiting.length;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      await this.acquire();
      try {
        return await task();
      } finally {
        this.release();
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return result;
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // Slot diserahkan oleh release(); active tidak ditambah lagi di sini.
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active -= 1;
    }
  }
}

export const defaultQueue = new MessageQueue(2);
