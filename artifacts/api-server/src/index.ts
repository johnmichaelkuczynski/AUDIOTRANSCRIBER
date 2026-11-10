import app from "./app";
import { logger } from "./lib/logger";
import { resumeIncompleteCoherenceJobs } from "./lib/coherenceEngine";

const rawPort = process.env.PORT || "5000";

const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  if (process.env.RESUME_JOBS_ON_START === "false") return;

  void resumeIncompleteCoherenceJobs().catch((err) => {
    logger.error({ err }, "Failed to resume incomplete coherence jobs");
  });
  const resumeTimer = setInterval(() => {
    void resumeIncompleteCoherenceJobs().catch((err) => {
      logger.error({ err }, "Failed to sweep resumable coherence jobs");
    });
  }, 60_000);
  resumeTimer.unref();
});
