import app from "./app";
import { logger } from "./lib/logger";
import { resumeIncompleteCoherenceJobs } from "./lib/coherenceEngine";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
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
