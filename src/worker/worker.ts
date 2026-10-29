import { claimNext, requeueRunning } from "../db/reels.ts";
import { processReel, type Deps } from "./pipeline.ts";

// One job at a time with a pause between jobs, to stay under platform rate limits.
const POLL_MS = 2000;

export function startWorker(deps: Deps): () => void {
  requeueRunning(deps.db); // a crash mid-job leaves 'running' rows behind
  let busy = false;
  let notBefore = 0;
  const tick = async () => {
    if (busy || Date.now() < notBefore) return;
    busy = true;
    try {
      const id = claimNext(deps.db);
      if (id) await processReel(deps, id);
    } finally {
      notBefore = Date.now() + deps.config.jobGapMs;
      busy = false;
    }
  };
  const timer = setInterval(() => void tick().catch((e) => console.error("worker tick failed", e)), POLL_MS);
  return () => clearInterval(timer);
}
