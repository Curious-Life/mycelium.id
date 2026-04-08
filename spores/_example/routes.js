/**
 * Example Spore — Routes
 *
 * This file is auto-mounted at /portal/example/* by the spore loader
 * when "routes": "routes.js" is set in manifest.json.
 */

import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    spore: 'example',
    message: 'This is a minimal spore. Replace this with your own routes.',
    timestamp: new Date().toISOString(),
  });
});

export default router;