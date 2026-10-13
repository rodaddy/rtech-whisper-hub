// Voice relay limits: per-device rate limits, per-device in-flight caps, and
// the global semaphore guarding the shared GPU. Everything lives in memory;
// v1 runs a single replica, so there is nothing to share across processes.

export type Route = "transcription" | "synthesis";

/** Time source. `setTimer` returns a cancel function. */
export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface RouteLimits {
  perMinute: number;
  burst: number;
  inFlight: number;
}

export const ROUTE_LIMITS: Readonly<Record<Route, RouteLimits>> = {
  transcription: { perMinute: 120, burst: 20, inFlight: 2 },
  synthesis: { perMinute: 30, burst: 5, inFlight: 2 },
};

export const GLOBAL_CONCURRENCY = 4;
export const GLOBAL_QUEUE_WAIT_MS = 10_000;

export type Release = () => void;

const keyOf = (deviceId: string, route: string) => `${deviceId}\u0000${route}`;

/** Wraps a release so the second and later calls do nothing. */
function once(fn: () => void): Release {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

export type TakeResult =
  { ok: true } | { ok: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  at: number;
}

/** Token bucket per (deviceId, route): `capacity` tokens, refilled continuously at `perMinute`. */
export class TokenBucket {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #perMs: number;
  readonly #clock: Clock;

  constructor(opts: { capacity: number; perMinute: number; clock?: Clock }) {
    this.#capacity = opts.capacity;
    this.#perMs = opts.perMinute / 60_000;
    this.#clock = opts.clock ?? systemClock;
  }

  take(deviceId: string, route: string): TakeResult {
    const now = this.#clock.now();
    const key = keyOf(deviceId, route);
    const b = this.#buckets.get(key) ?? { tokens: this.#capacity, at: now };
    b.tokens = Math.min(this.#capacity, b.tokens + (now - b.at) * this.#perMs);
    b.at = now;
    this.#buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const waitMs = (1 - b.tokens) / this.#perMs;
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
    };
  }
}

/** Caps concurrent requests per (deviceId, route). */
export class InFlight {
  readonly #counts = new Map<string, number>();
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  /** A release function, or null when the key is already at the max. */
  acquire(deviceId: string, route: string): Release | null {
    const key = keyOf(deviceId, route);
    const n = this.#counts.get(key) ?? 0;
    if (n >= this.#max) return null;
    this.#counts.set(key, n + 1);
    return once(() => {
      const left = (this.#counts.get(key) ?? 1) - 1;
      if (left <= 0) this.#counts.delete(key);
      else this.#counts.set(key, left);
    });
  }

  count(deviceId: string, route: string): number {
    return this.#counts.get(keyOf(deviceId, route)) ?? 0;
  }
}

export type SemaphoreResult =
  { ok: true; release: Release } | { ok: false; reason: "busy" };

interface Waiter {
  resolve: (r: SemaphoreResult) => void;
  cancel: () => void;
}

/** Global concurrency limit with a FIFO queue; a waiter gives up after `maxWaitMs`. */
export class Semaphore {
  readonly #max: number;
  readonly #maxWaitMs: number;
  readonly #clock: Clock;
  readonly #queue: Waiter[] = [];
  #active = 0;

  constructor(opts: { max: number; maxWaitMs: number; clock?: Clock }) {
    this.#max = opts.max;
    this.#maxWaitMs = opts.maxWaitMs;
    this.#clock = opts.clock ?? systemClock;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  acquire(): Promise<SemaphoreResult> {
    if (this.#active < this.#max && this.#queue.length === 0) {
      this.#active += 1;
      return Promise.resolve({ ok: true, release: this.#release() });
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        cancel: this.#clock.setTimer(() => {
          const i = this.#queue.indexOf(waiter);
          if (i !== -1) this.#queue.splice(i, 1);
          resolve({ ok: false, reason: "busy" });
        }, this.#maxWaitMs),
      };
      this.#queue.push(waiter);
    });
  }

  #release(): Release {
    return once(() => {
      const next = this.#queue.shift();
      if (next) {
        // Hand the slot straight to the next waiter; #active stays the same.
        next.cancel();
        next.resolve({ ok: true, release: this.#release() });
      } else {
        this.#active -= 1;
      }
    });
  }
}
