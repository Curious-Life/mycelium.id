/**
 * Auto runtime — routes each turn local (Ollama) vs cloud (Claude SDK) per-turn,
 * behind the same AgentRuntime interface. Local-first + privacy-preserving:
 * sensitive turns NEVER egress to cloud; complex turns escalate; cloud failure
 * falls back to local (sovereign floor). The actual turn still runs through one
 * of the two real backends, so the reply tool + chokepoint are unchanged.
 *
 * Egress accounting: a cloud-routed turn sends the inbound message + vault
 * context to a cloud provider — recorded HASH-ONLY via auditEgress (reuses the
 * vault's inference-egress sink shape). A sensitive turn kept local records a
 * 'denied' trail; a plain local turn egresses nothing (no audit).
 */
import crypto from 'node:crypto';
import { classifyTurn } from '../classify.js';

/**
 * @param {object} deps
 * @param {{runTurn:Function,label?:string}} deps.local
 * @param {{runTurn:Function,label?:string}} deps.cloud
 * @param {RegExp[]} [deps.sensitivePatterns]
 * @param {(e:{decision:string,reason:string,contentHash:string,contentLength:number,jurisdiction:string})=>any} [deps.auditEgress]
 * @param {string} [deps.logPrefix]
 */
export function createAutoRuntime({ local, cloud, sensitivePatterns, auditEgress, logPrefix = 'channel-daemon' }) {
  if (!local?.runTurn && !cloud?.runTurn) throw new TypeError('createAutoRuntime: at least one backend required');
  const audit = typeof auditEgress === 'function' ? auditEgress : () => {};

  return {
    label: `auto(local=${local?.label || 'none'} cloud=${cloud?.label || 'none'})`,

    async runTurn(args) {
      const { locus, sensitive, reason } = classifyTurn({ userMessage: args.userMessage, turnCtx: args.turnCtx, sensitivePatterns });
      const contentHash = crypto.createHash('sha256').update(String(args.userMessage || ''), 'utf8').digest('hex');
      const contentLength = String(args.userMessage || '').length;

      // Cloud path — only when classified complex AND a cloud backend exists.
      if (locus === 'cloud' && cloud?.runTurn) {
        console.log(`[${logPrefix}] auto → cloud (${reason})`);
        audit({ decision: 'allowed', reason: `auto:${reason}`, contentHash, contentLength, jurisdiction: 'cloud' });
        try {
          return await cloud.runTurn(args);
        } catch (e) {
          console.warn(`[${logPrefix}] auto cloud turn failed (${e.message}) — falling back to local`);
          if (local?.runTurn) { audit({ decision: 'allowed', reason: 'auto:cloud-failed-local-fallback', contentHash, contentLength, jurisdiction: 'local' }); return await local.runTurn(args); }
          throw e;
        }
      }

      // Local path — sensitive (kept local by policy) or simple, or no cloud.
      if (local?.runTurn) {
        console.log(`[${logPrefix}] auto → local (${reason})`);
        if (sensitive) audit({ decision: 'denied', reason: 'auto:sensitive-kept-local', contentHash, contentLength, jurisdiction: 'local' });
        return await local.runTurn(args);
      }

      // No local backend but locus said local (e.g. sensitive + cloud-only config):
      // we refuse to send a sensitive turn to cloud — return no-reply rather than leak.
      if (sensitive) {
        console.warn(`[${logPrefix}] auto: sensitive turn but no local backend — refusing cloud egress`);
        audit({ decision: 'denied', reason: 'auto:sensitive-no-local-refused', contentHash, contentLength, jurisdiction: 'local' });
        return { delivered: false, usedReplyTool: false, reason: 'sensitive-no-local' };
      }
      // simple + cloud-only → just use cloud.
      audit({ decision: 'allowed', reason: `auto:${reason}`, contentHash, contentLength, jurisdiction: 'cloud' });
      return await cloud.runTurn(args);
    },
  };
}
