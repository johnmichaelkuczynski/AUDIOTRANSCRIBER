import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Production browser requests are same-origin through Traefik.
if (process.env.NODE_ENV !== "production") app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api", router);

// Never return the SPA for unknown API routes.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

if (process.env.NODE_ENV === "production") {
  const publicDir = resolve(
    process.env.STATIC_DIR || "artifacts/transcriber/dist/public",
  );
  if (!existsSync(resolve(publicDir, "index.html"))) {
    throw new Error(
      "Production frontend is missing. Run pnpm build from the repository root.",
    );
  }
  app.use(express.static(publicDir));
  app.get("/{*path}", (req, res, next) => {
    if (!req.accepts("html") || /\.[a-z0-9]+$/i.test(req.path)) return next();
    res.sendFile(resolve(publicDir, "index.html"));
  });
}

const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  req.log.error({ err: error }, "Request failed");
  if (res.headersSent) return next(error);
  res
    .status(500)
    .json({ error: "Request failed. See server logs for details." });
};
app.use(errorHandler);

export default app;
