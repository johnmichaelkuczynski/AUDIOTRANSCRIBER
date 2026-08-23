import { Router, type IRouter } from "express";
import healthRouter from "./health";
import diagnosticsRouter from "./diagnostics";
import transcriptionsRouter from "./transcriptions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(diagnosticsRouter);
router.use(transcriptionsRouter);

export default router;
