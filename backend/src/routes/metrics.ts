import { Router, Request, Response } from 'express';
import { register } from '../config/metrics';

const router = Router();

// ---------------------------------------------------------------------------
// GET /metrics — Prometheus Exposition Endpoint
// ---------------------------------------------------------------------------
router.get('/', async (_req: Request, res: Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

export default router;
