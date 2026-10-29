import net from "node:net";

// Minimal Wyoming client: transcribe, audio-start, audio-chunk*, audio-stop -> transcript.
// Event framing: one JSON header line, then data_length bytes of JSON, then payload_length raw bytes.

export function parseWyomingUrl(raw: string): { host: string; port: number } {
  const u = new URL(raw);
  if (u.protocol !== "tcp:" || !u.hostname || !u.port) throw new Error("WYOMING_URL must look like tcp://host:10300");
  return { host: u.hostname, port: Number(u.port) };
}

class Reader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private closed: Error | null = null;
  constructor(sock: net.Socket) {
    sock.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.wake(); });
    sock.on("error", (e) => { this.closed = e; this.wake(); });
    sock.on("close", () => { this.closed ??= new Error("wyoming connection closed"); this.wake(); });
  }
  private wake() { this.waiters.splice(0).forEach((w) => w()); }
  private async until(ok: () => boolean) {
    while (!ok()) {
      if (this.closed) throw this.closed;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  async exact(n: number): Promise<Buffer> {
    await this.until(() => this.buf.length >= n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async line(): Promise<string> {
    await this.until(() => this.buf.includes(10));
    const i = this.buf.indexOf(10);
    const out = this.buf.subarray(0, i).toString();
    this.buf = this.buf.subarray(i + 1);
    return out;
  }
}

function encode(type: string, data: object, payload?: Buffer): Buffer {
  const body = Buffer.from(JSON.stringify(data));
  const header: Record<string, unknown> = { type, data_length: body.length };
  if (payload) header.payload_length = payload.length;
  return Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), body, payload ?? Buffer.alloc(0)]);
}

async function readEvent(r: Reader): Promise<{ type: string; data: Record<string, unknown> }> {
  const h = JSON.parse(await r.line()) as { type: string; data?: object; data_length?: number; payload_length?: number };
  const extra = h.data_length ? (JSON.parse((await r.exact(h.data_length)).toString()) as object) : {};
  if (h.payload_length) await r.exact(h.payload_length);
  return { type: h.type, data: { ...h.data, ...extra } };
}

// pcm: 16 kHz, mono, signed 16-bit little-endian.
export async function transcribePcm(url: string, pcm: Buffer, opts: { language?: string | null } = {}): Promise<string> {
  const { host, port } = parseWyomingUrl(url);
  const sock = net.connect({ host, port });
  const timer = setTimeout(() => sock.destroy(new Error("wyoming timeout")), 300_000);
  const reader = new Reader(sock);
  try {
    await new Promise<void>((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    const fmt = { rate: 16000, width: 2, channels: 1 };
    sock.write(encode("transcribe", opts.language ? { language: opts.language } : {}));
    sock.write(encode("audio-start", fmt));
    for (let i = 0; i < pcm.length; i += 32000) sock.write(encode("audio-chunk", fmt, pcm.subarray(i, i + 32000)));
    sock.write(encode("audio-stop", {}));
    for (;;) {
      const ev = await readEvent(reader);
      if (ev.type === "transcript") return String(ev.data.text ?? "").trim();
    }
  } finally {
    clearTimeout(timer);
    sock.destroy();
  }
}
