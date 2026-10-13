import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Clock,
  GLOBAL_CONCURRENCY,
  GLOBAL_QUEUE_WAIT_MS,
  InFlight,
  ROUTE_LIMITS,
  Semaphore,
  type SemaphoreResult,
  TokenBucket,
} from "../src/voice/limits.ts";

class FakeClock implements Clock {
  t = 0;
  #timers: { at: number; fn: () => void; live: boolean }[] = [];
  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.#timers
      .filter((x) => x.live && x.at <= this.t)
      .sort((a, b) => a.at - b.at);
    for (const x of due) {
      x.live = false;
      x.fn();
    }
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

test("v1 constants", () => {
  assert.deepEqual(ROUTE_LIMITS.transcription, {
    perMinute: 120,
    burst: 20,
    inFlight: 2,
  });
  assert.deepEqual(ROUTE_LIMITS.synthesis, {
    perMinute: 30,
    burst: 5,
    inFlight: 2,
  });
  assert.equal(GLOBAL_CONCURRENCY, 4);
  assert.equal(GLOBAL_QUEUE_WAIT_MS, 10_000);
});

test("token bucket: burst exhausts, Retry-After is correct, refills over time", () => {
  const clock = new FakeClock();
  const { burst, perMinute } = ROUTE_LIMITS.synthesis; // 5 burst, 30/min = one token per 2 s
  const b = new TokenBucket({ capacity: burst, perMinute, clock });
  for (let i = 0; i < burst; i++)
    assert.deepEqual(b.take("d1", "synthesis"), { ok: true });
  assert.deepEqual(b.take("d1", "synthesis"), {
    ok: false,
    retryAfterSeconds: 2,
  });

  clock.advance(1_000); // half a token back
  assert.deepEqual(b.take("d1", "synthesis"), {
    ok: false,
    retryAfterSeconds: 1,
  });

  clock.advance(1_000); // one whole token
  assert.deepEqual(b.take("d1", "synthesis"), { ok: true });
  assert.equal(b.take("d1", "synthesis").ok, false);

  clock.advance(60_000); // a long idle refills to capacity, not beyond
  for (let i = 0; i < burst; i++)
    assert.equal(b.take("d1", "synthesis").ok, true);
  assert.equal(b.take("d1", "synthesis").ok, false);
});

test("token bucket: transcription rate gives a 1 s Retry-After", () => {
  const clock = new FakeClock();
  const { burst, perMinute } = ROUTE_LIMITS.transcription;
  const b = new TokenBucket({ capacity: burst, perMinute, clock });
  for (let i = 0; i < burst; i++)
    assert.equal(b.take("d", "transcription").ok, true);
  assert.deepEqual(b.take("d", "transcription"), {
    ok: false,
    retryAfterSeconds: 1,
  });
  clock.advance(500); // 120/min = one token per 500 ms
  assert.equal(b.take("d", "transcription").ok, true);
});

test("token bucket: separate keys do not interfere", () => {
  const clock = new FakeClock();
  const b = new TokenBucket({ capacity: 2, perMinute: 30, clock });
  assert.equal(b.take("d1", "synthesis").ok, true);
  assert.equal(b.take("d1", "synthesis").ok, true);
  assert.equal(b.take("d1", "synthesis").ok, false);
  assert.equal(b.take("d2", "synthesis").ok, true);
  assert.equal(b.take("d1", "transcription").ok, true);
});

test("in-flight: capped per key, release frees a slot, double release is a no-op", () => {
  const f = new InFlight(2);
  const r1 = f.acquire("d1", "synthesis");
  const r2 = f.acquire("d1", "synthesis");
  assert.ok(r1 && r2);
  assert.equal(f.acquire("d1", "synthesis"), null);
  assert.ok(f.acquire("d2", "synthesis"), "another device is independent");
  assert.ok(f.acquire("d1", "transcription"), "another route is independent");

  r1();
  r1();
  assert.equal(f.count("d1", "synthesis"), 1);
  const r3 = f.acquire("d1", "synthesis");
  assert.ok(r3);
  assert.equal(f.acquire("d1", "synthesis"), null);
});

async function grab(s: Semaphore): Promise<() => void> {
  const r = await s.acquire();
  assert.ok(r.ok);
  return r.release;
}

test("semaphore: queues the 5th caller and serves it on release", async () => {
  const clock = new FakeClock();
  const s = new Semaphore({
    max: GLOBAL_CONCURRENCY,
    maxWaitMs: GLOBAL_QUEUE_WAIT_MS,
    clock,
  });
  const held = await Promise.all([grab(s), grab(s), grab(s), grab(s)]);
  const box: { fifth?: SemaphoreResult } = {};
  void s.acquire().then((r) => {
    box.fifth = r;
  });
  const fifth = (): SemaphoreResult | undefined => box.fifth;
  await flush();
  assert.equal(fifth(), undefined);
  assert.equal(s.waiting, 1);

  held[0]!();
  await flush();
  assert.ok(fifth()?.ok);
  assert.equal(s.active, 4);

  clock.advance(GLOBAL_QUEUE_WAIT_MS); // its cancelled timer must not fire a busy
  await flush();
  assert.ok(fifth()?.ok);
});

test("semaphore: a waiter gets busy after the wait expires", async () => {
  const clock = new FakeClock();
  const s = new Semaphore({ max: 1, maxWaitMs: 10_000, clock });
  const release = await grab(s);
  const p = s.acquire();
  clock.advance(9_999);
  assert.equal(s.waiting, 1);
  clock.advance(1);
  assert.deepEqual(await p, { ok: false, reason: "busy" });
  assert.equal(s.waiting, 0);

  release(); // slot returns to the pool, not to the timed-out waiter
  assert.equal(s.active, 0);
});

test("semaphore: waiters are served first-in, first-out", async () => {
  const clock = new FakeClock();
  const s = new Semaphore({ max: 1, maxWaitMs: 10_000, clock });
  let release = await grab(s);
  const order: number[] = [];
  const pending = [1, 2, 3].map((n) =>
    s.acquire().then((r) => {
      assert.ok(r.ok);
      order.push(n);
      return r.release;
    }),
  );
  for (const p of pending) {
    release();
    release = await p;
  }
  assert.deepEqual(order, [1, 2, 3]);
});

test("semaphore: a double release is a no-op", async () => {
  const clock = new FakeClock();
  const s = new Semaphore({ max: 1, maxWaitMs: 10_000, clock });
  const r1 = await grab(s);
  const a = s.acquire();
  const b = s.acquire();
  r1();
  r1(); // must not also hand a slot to the second waiter
  const ra = await a;
  assert.ok(ra.ok);
  await flush();
  assert.equal(s.waiting, 1);
  assert.equal(s.active, 1);

  ra.release();
  assert.ok((await b).ok);
});
