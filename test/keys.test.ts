import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db/client.ts";
import { authenticate, mintDevice, revokeDevice } from "../src/keys.ts";
import { testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
before(async () => ({ db, client } = await testDb()));
after(async () => client.close());

test("minted key has the rtw_ format and 47 characters", async () => {
  const d = await mintDevice(db, "phone", "rico");
  assert.match(d.key, /^rtw_/);
  assert.equal(d.key.length, 47);
  assert.equal(d.prefix, d.key.slice(0, 12));
});

test("stored row holds neither the key nor any part beyond the prefix", async () => {
  const d = await mintDevice(db, "laptop", "rico");
  const { rows } = await client.query("select * from devices where id = $1", [
    d.id,
  ]);
  const stored = JSON.stringify(rows[0]);
  assert.ok(!stored.includes(d.key));
  const secret = d.key.slice(12);
  for (let i = 0; i + 8 <= secret.length; i++) {
    assert.ok(
      !stored.includes(secret.slice(i, i + 8)),
      "stored row leaks key material",
    );
  }
});

test("authenticate resolves a live key and rejects revoked, unknown, and malformed keys", async () => {
  const d = await mintDevice(db, "desk", "rico");
  assert.deepEqual(await authenticate(db, d.key), {
    id: d.id,
    name: "desk",
    ownerId: "rico",
  });
  assert.equal(await revokeDevice(db, d.prefix), true);
  assert.equal(await authenticate(db, d.key), null);
  assert.equal(await revokeDevice(db, d.id), false, "already revoked");
  assert.equal(await authenticate(db, `rtw_${"A".repeat(43)}`), null);
  assert.equal(await authenticate(db, "not-a-key"), null);
});

test("revoke by id works and an unmatched target changes nothing", async () => {
  const d = await mintDevice(db, "tablet", "rico");
  assert.equal(await revokeDevice(db, "rtw_nomatch00"), false);
  assert.equal(await revokeDevice(db, d.id), true);
  assert.equal(await authenticate(db, d.key), null);
});

test("keys minted for different owners authenticate to their own owner", async () => {
  const r = await mintDevice(db, "rico-phone", "rico");
  const a = await mintDevice(db, "ana-phone", "ana");
  assert.equal(r.ownerId, "rico");
  assert.equal(a.ownerId, "ana");
  assert.equal((await authenticate(db, r.key))?.ownerId, "rico");
  assert.equal((await authenticate(db, a.key))?.ownerId, "ana");
});
