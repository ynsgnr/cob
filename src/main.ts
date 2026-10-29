import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { providers } from "./providers/index.ts";
import { karakeepClient, startKarakeepSync } from "./integrations/karakeep.ts";
import { makeTranscriber } from "./transcribe/index.ts";
import { createApp } from "./web/server.ts";
import { startWorker } from "./worker/worker.ts";

const config = loadConfig();
mkdirSync(config.mediaDir, { recursive: true });
const deps = { db: openDb(config.databasePath), config, providers, transcribe: makeTranscriber(config) };

const stopWorker = startWorker(deps);
const kk = config.karakeep;
const stopSync = kk ? startKarakeepSync(deps, karakeepClient(kk.url, kk.apiKey), { publicBaseUrl: kk.publicBaseUrl, backfill: kk.backfill, replace: kk.replace }, kk.pollMs) : () => {};
const server = createApp(deps).listen(config.port, () => {
  console.log(`cob on :${config.port} (transcription ${config.wyomingUrl ? "on" : "off"}, karakeep ${kk ? "on" : "off"})`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { stopWorker(); stopSync(); server.close(() => process.exit(0)); });
}
