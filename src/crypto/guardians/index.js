/**
 * @mycelium/core/guardians — named enforcement points at trust boundaries.
 *
 * See docs/history/GUARDIANS-DESIGN.md for the full design.
 *
 * Quick start:
 *   import { guardians, GuardianKind } from '@mycelium/core/guardians';
 *
 *   const portalAuth = guardians.register({
 *     id: 'vps.portal-auth',
 *     kind: GuardianKind.PERIMETER,
 *     boundary: 'portal→server',
 *     description: 'Session cookie → authenticated user',
 *     process: 'vps',
 *     check: async (ctx) => {
 *       const user = await authenticatePortalRequest(ctx.request);
 *       return user
 *         ? { allow: true, principal: { id: user.id, kind: 'user' } }
 *         : { allow: false, reason: 'no_session' };
 *     },
 *     contract: () => [...],
 *   });
 *
 *   // As Express middleware:
 *   app.use('/portal', toMiddleware(portalAuth));
 *
 *   // Or direct check:
 *   const r = await portalAuth.check({ request: req, ip, method, path });
 */

export { Guardian, GuardianKind } from './guardian.js';
export { GuardianRegistry, guardians } from './registry.js';
export { toMiddleware, buildRequestContext } from './middleware.js';
export {
  scrubByKind, ipPrefix, headerNames, principalKind,
  defaultScrub, perimeterScrub, tenantScrub, scopeScrub,
  protocolScrub, sanitizationScrub,
} from './scrubbers.js';
