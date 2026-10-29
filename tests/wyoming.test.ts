import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { parseWyomingUrl, transcribePcm } from "../src/transcribe/wyoming.ts";

// Fake server speaking the same framing: header line, data_length JSON, payload_length raw bytes.
function fakeServer(reply: (events: string[], bytes: number) => Buffer): Promise<{ port: number; close: () => void }> {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const events: string[] = [];
    let audioBytes = 0;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const h = JSON.parse(buf.subarray(0, nl).toString()) as { type: string; data_length?: number; payload_length?: number };
        const need = nl + 1 + (h.data_length ?? 0) + (h.payload_length ?? 0);
        if (buf.length < need) return;
        events.push(h.type);
        audioBytes += h.payload_length ?? 0;
        buf = buf.subarray(need);
        if (h.type === "audio-stop") sock.write(reply(events, audioBytes));
      }
    });
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() })));
}

const transcriptEvent = (text: string) => {
  const body = Buffer.from(JSON.stringify({ text }));
  return Buffer.concat([Buffer.from(JSON.stringify({ type: "transcript", data_length: body.length }) + "\n"), body]);
};

test("sends transcribe, audio-start, chunks, audio-stop and returns the transcript", async () => {
  let seen: string[] = [];
  let bytes = 0;
  const srv = await fakeServer((events, n) => { seen = events; bytes = n; return transcriptEvent(" hello there "); });
  try {
    const text = await transcribePcm(`tcp://127.0.0.1:${srv.port}`, Buffer.alloc(70000), { language: "en" });
    assert.equal(text, "hello there");
    assert.equal(seen[0], "transcribe");
    assert.equal(seen[1], "audio-start");
    assert.equal(seen.filter((e) => e === "audio-chunk").length, 3);
    assert.equal(seen.at(-1), "audio-stop");
    assert.equal(bytes, 70000);
  } finally { srv.close(); }
});

test("accepts a header with inline data and skips other events", async () => {
  const srv = await fakeServer(() => Buffer.from(JSON.stringify({ type: "info" }) + "\n" + JSON.stringify({ type: "transcript", data: { text: "inline" } }) + "\n"));
  try {
    assert.equal(await transcribePcm(`tcp://127.0.0.1:${srv.port}`, Buffer.alloc(10)), "inline");
  } finally { srv.close(); }
});

test("rejects when the server closes early and on a bad url", async () => {
  const srv = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(transcribePcm(`tcp://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, Buffer.alloc(10)));
  } finally { srv.close(); }
  assert.throws(() => parseWyomingUrl("http://x:1"));
  assert.throws(() => parseWyomingUrl("tcp://nohost"));
});
