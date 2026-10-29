import assert from "node:assert/strict";
import { test } from "node:test";
import { splitPcm, withRetries } from "../src/transcribe/index.ts";

test("withRetries retries then succeeds, and gives up after the last try", async () => {
  let n = 0;
  assert.equal(await withRetries(async () => { if (++n < 3) throw new Error("closed"); return "ok"; }, 3, 1), "ok");
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(withRetries(async () => { m++; throw new Error("down"); }, 3, 1), /down/);
  assert.equal(m, 3);
});

test("splitPcm cuts into pieces of at most the given size without losing bytes", () => {
  const parts = splitPcm(Buffer.alloc(100), 40);
  assert.deepEqual(parts.map((p) => p.length), [40, 40, 20]);
  assert.deepEqual(splitPcm(Buffer.alloc(0), 40), []);
});
