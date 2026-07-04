import { Router, type IRouter } from "express";
import healthRouter from "./health";
import transcriptionsRouter from "./transcriptions";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth, transcriptionsRouter);

export default router;
