export class MessageQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private activeCount = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly concurrency: number;

  constructor(concurrency = 2) {
    this.concurrency = Math.max(1, concurrency);
  }

  private async acquire(): Promise<void> {
    if (this.activeCount < this.concurrency) {
      this.activeCount++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let result!: T;
    let caughtError: unknown;
    let hasError = false;

    const tail = prev
      .catch(() => {
        // Jangan biarkan error sebelumnya memblokir rantai nomor yang sama
      })
      .then(async () => {
        await this.acquire();
        try {
          result = await task();
        } catch (err) {
          hasError = true;
          caughtError = err;
        } finally {
          this.release();
        }
      });

    this.chains.set(key, tail);

    try {
      await tail;
    } finally {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    }

    if (hasError) {
      throw caughtError;
    }
    return result;
  }
}

export const defaultQueue = new MessageQueue(2);
