import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import analyticsRouter from "./analytics";
import transcriptionsRouter from "./transcriptions";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(analyticsRouter);
router.use(requireAuth, transcriptionsRouter);

export default router;
