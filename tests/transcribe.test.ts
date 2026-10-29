import assert from "node:assert/strict";
import { test } from "node:test";
import { splitPcm, transcribePieces, withRetries } from "../src/transcribe/index.ts";

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

test("transcribePieces survives flaky pieces, leaves a gap for a dead one, and gives up when too many fail", async () => {
  const pieces = Array.from({ length: 10 }, (_, i) => Buffer.from([i]));
  const calls = new Map<number, number>();
  const flaky = async (p: Buffer) => {
    const i = p[0]!;
    const n = (calls.get(i) ?? 0) + 1;
    calls.set(i, n);
    if (i === 3 && n < 4) throw new Error("closed"); // recovers on the 4th try
    if (i === 7) throw new Error("always fails");
    return `w${i}`;
  };
  const text = await transcribePieces(pieces, flaky, 1, 1);
  assert.equal(text, "w0 w1 w2 w3 w4 w5 w6 […] w8 w9");
  await assert.rejects(transcribePieces(pieces, async (p) => { if (p[0]! < 4) throw new Error("x"); return "ok"; }, 1, 1), /4 of 10 pieces failed/);
  assert.equal(await transcribePieces([], async () => "never", 1, 1), "");
  // a burst longer than one piece's 6 tries is outlasted by the later pass
  let burst = 0;
  assert.equal(await transcribePieces([Buffer.from("a"), Buffer.from("b")], async (p) => { if (p.toString() === "a" && ++burst <= 8) throw new Error("burst"); return p.toString(); }, 1, 1), "a b");
});
