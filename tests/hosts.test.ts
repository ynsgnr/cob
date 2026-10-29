import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { accessFor, loadConfig } from "../src/config.ts";
import { insertOrGet } from "../src/db/reels.ts";
import { createApp } from "../src/web/server.ts";
import { processReel } from "../src/worker/pipeline.ts";
import { makeDeps } from "./helpers.ts";

const PUB = "pub.example.test";
const INT = "int.example.test";

function serve(hosts: { publicHost: string | null; internalHost: string | null }) {
  const deps = makeDeps();
  deps.config = { ...deps.config, ...hosts };
  const server = createApp(deps);
  return { deps, server, port: () => (server.address() as AddressInfo).port };
}
// fetch() will not let tests choose the Host header, node:http does.
const call = (port: number, host: string, method: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", method, path, headers: { host, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, location: res.headers.location }));
    });
    req.on("error", reject).end(method === "POST" ? "url=x" : undefined);
  });

const both = serve({ publicHost: PUB, internalHost: INT });
let id = "";
before(async () => {
  await new Promise<void>((r) => both.server.listen(0, "127.0.0.1", r));
  id = insertOrGet(both.deps.db, { platform: "fake", externalId: "h1", originalUrl: "https://example.test/v/h1", canonicalUrl: "https://example.test/v/h1" }).reel.id;
  await processReel(both.deps, id);
});
after(() => { both.server.close(); });

test("public host: only GET video pages, media, old links and the health check", async () => {
  const p = both.port();
  const page = await call(p, PUB, "GET", `/k/${id}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, /Retry|All saved/); // no buttons that lead to a 404
  assert.match(page.body, /hello world/);
  assert.equal((await call(p, PUB, "GET", `/media/${id}`)).status, 200);
  assert.equal((await call(p, PUB, "GET", `/r/${id}`)).status, 308);
  assert.equal((await call(p, `${PUB}:8443`, "GET", "/healthz")).status, 200); // a port in Host is ignored
  for (const [method, path] of [["GET", "/"], ["GET", "/?q=hello"], ["GET", `/api/reels/${id}`], ["POST", "/submit"], ["POST", "/api/reels"], ["POST", `/k/${id}/retry`], ["GET", `/k/${id}/retry`], ["GET", "/robots.txt"], ["GET", `/k/${id}/`]] as const)
    assert.equal((await call(p, PUB, method, path, { "content-type": "application/json" })).status, 404, `${method} ${path}`);
});

test("internal host: everything works, and unknown hosts are treated as public when INTERNAL_HOST is set", async () => {
  const p = both.port();
  const page = await call(p, INT, "GET", `/k/${id}`);
  assert.match(page.body, /Retry/);
  assert.match(page.body, /All saved/);
  assert.equal((await call(p, INT, "GET", "/")).status, 200);
  assert.equal((await call(p, INT, "GET", `/api/reels/${id}`)).status, 200);
  assert.equal((await call(p, INT, "POST", `/k/${id}/retry`)).status, 303);
  assert.equal((await call(p, INT.toUpperCase(), "GET", "/")).status, 200); // host names are case-insensitive
  assert.equal((await call(p, "10.1.2.3:3000", "GET", "/")).status, 404); // pod IP, wrong or missing Host: fail closed
  assert.equal((await call(p, "10.1.2.3:3000", "GET", `/k/${id}`)).status, 200);
  assert.equal((await call(p, `evil.${INT}`, "GET", "/")).status, 404);
});

test("accessFor: both set, only public set, only internal set, neither", () => {
  const rule = (publicHost: string | null, internalHost: string | null, host?: string) => accessFor({ publicHost, internalHost }, host);
  assert.equal(rule(PUB, INT, PUB), "public");
  assert.equal(rule(PUB, INT, INT), "full");
  assert.equal(rule(PUB, null, PUB), "public");
  assert.equal(rule(PUB, null, "anything.else"), "full");
  assert.equal(rule(null, INT, "anything.else"), "public");
  assert.equal(rule(null, INT, undefined), "public");
  assert.equal(rule(null, null, PUB), "full");
});

test("config: hosts are bare lowercase hostnames; a pasted URL is reduced; junk is rejected", () => {
  const c = loadConfig({ PUBLIC_HOST: "https://Pub.Example.Test/", INTERNAL_HOST: "int.example.test:8443" });
  assert.equal(c.publicHost, PUB);
  assert.equal(c.internalHost, INT);
  assert.equal(loadConfig({}).publicHost, null);
  assert.throws(() => loadConfig({ PUBLIC_HOST: "bad host!" }), /PUBLIC_HOST/);
});
