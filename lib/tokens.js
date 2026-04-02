/**
 * Response Token Handling
 *
 * Standardized handling of special response tokens like NO_REPLY.
 */

// Silent token - agent chose not to respond
export const SILENT_TOKEN = 'NO_REPLY';

// Common variations agents might invent (caught defensively)
const SILENT_VARIANTS = ['NO_REPLY', 'SILENT_REPLY', 'SILENT', 'NO REPLY', 'NOREPLY'];

// Task commitment token - agent is committing to a task
export const TASK_TOKEN = 'TASK:';

// Escalation token - agent needs human help
export const ESCALATE_TOKEN = 'ESCALATE:';

// Delegation token - agent wants to hand off to another agent
export const DELEGATE_TOKEN = 'DELEGATE:';

/**
 * Check if response indicates agent chose silence
 *
 * Detects NO_REPLY in multiple scenarios:
 * 1. Response is exactly "NO_REPLY"
 * 2. Response starts with "NO_REPLY"
 * 3. Response contains "NO_REPLY" on its own line (agent reasoned then decided)
 * 4. Response is meta-reasoning about whether to respond (common LLM pattern)
 *
 * @param {string} text - Response text
 * @returns {boolean}
 */
export function isSilentReply(text) {
  if (!text) return false;
  const trimmed = text.trim();

  // Check all known silence variants (exact match, starts-with, own-line)
  for (const token of SILENT_VARIANTS) {
    if (trimmed === token) return true;
    if (trimmed.startsWith(token + '\n') || trimmed.startsWith(token + ' ')) return true;
  }

  // Any variant on its own line (agent reasoned then decided to be silent)
  const lines = trimmed.split('\n').map(l => l.trim());
  if (lines.some(line => SILENT_VARIANTS.includes(line))) return true;

  // Check for meta-reasoning patterns that indicate agent is confused about whether to respond
  const metaPatterns = [
    /^(Looking at|Based on|I see|Given|The (right|best|appropriate)|I('m| am) (seeing|looking|reading)|This (is|was|appears|seems)|I (need|should|don't need) to)/i,
    /respond with (only|just)?\s*`?(NO_REPLY|SILENT_REPLY)`?/i,
    /the (appropriate|right|best) (response|action|thing) is/i,
    /I('ll| will) (wait|stay silent|not respond)/i,
  ];

  // If response contains any silence variant AND matches meta-reasoning patterns, it's silent
  const hasVariant = SILENT_VARIANTS.some(v => trimmed.includes(v));
  if (hasVariant) {
    for (const pattern of metaPatterns) {
      if (pattern.test(trimmed)) return true;
    }
  }

  return false;
}

/**
 * Check if response contains a task commitment
 * @param {string} text - Response text
 * @returns {{ hasTask: boolean, taskDescription: string | null, cleanResponse: string }}
 */
export function parseTaskCommitment(text) {
  if (!text) return { hasTask: false, taskDescription: null, cleanResponse: text };

  const taskMatch = text.match(/^TASK:\s*(.+?)(?:\n|$)/m);

  if (taskMatch) {
    return {
      hasTask: true,
      taskDescription: taskMatch[1].trim(),
      cleanResponse: text.replace(/^TASK:\s*.+?\n?/m, '').trim(),
    };
  }

  return { hasTask: false, taskDescription: null, cleanResponse: text };
}

/**
 * Check if response contains an escalation request
 * @param {string} text - Response text
 * @returns {{ hasEscalation: boolean, reason: string | null, cleanResponse: string }}
 */
export function parseEscalation(text) {
  if (!text) return { hasEscalation: false, reason: null, cleanResponse: text };

  const escalateMatch = text.match(/^ESCALATE:\s*(.+?)(?:\n|$)/m);

  if (escalateMatch) {
    return {
      hasEscalation: true,
      reason: escalateMatch[1].trim(),
      cleanResponse: text.replace(/^ESCALATE:\s*.+?\n?/m, '').trim(),
    };
  }

  return { hasEscalation: false, reason: null, cleanResponse: text };
}

/**
 * Check if response contains a delegation request
 * @param {string} text - Response text
 * @returns {{ hasDelegation: boolean, targetAgent: string | null, taskDescription: string | null, cleanResponse: string }}
 */
export function parseDelegation(text) {
  if (!text) return { hasDelegation: false, targetAgent: null, taskDescription: null, cleanResponse: text };

  // Format: DELEGATE: agent-name: task description
  const delegateMatch = text.match(/^DELEGATE:\s*(\S+?):\s*(.+?)(?:\n|$)/m);

  if (delegateMatch) {
    return {
      hasDelegation: true,
      targetAgent: delegateMatch[1].trim(),
      taskDescription: delegateMatch[2].trim(),
      cleanResponse: text.replace(/^DELEGATE:\s*\S+?:\s*.+?\n?/m, '').trim(),
    };
  }

  return { hasDelegation: false, targetAgent: null, taskDescription: null, cleanResponse: text };
}

/**
 * Parse all special tokens from a response
 * @param {string} text - Response text
 * @returns {Object} Parsed response with all token information
 */
export function parseResponse(text) {
  if (!text) {
    return {
      isSilent: false,
      task: null,
      escalation: null,
      delegation: null,
      cleanResponse: '',
    };
  }

  const silent = isSilentReply(text);
  const taskInfo = parseTaskCommitment(text);
  const escalationInfo = parseEscalation(taskInfo.cleanResponse);
  const delegationInfo = parseDelegation(escalationInfo.cleanResponse);

  return {
    isSilent: silent,
    task: taskInfo.hasTask ? { description: taskInfo.taskDescription } : null,
    escalation: escalationInfo.hasEscalation ? { reason: escalationInfo.reason } : null,
    delegation: delegationInfo.hasDelegation ? {
      targetAgent: delegationInfo.targetAgent,
      taskDescription: delegationInfo.taskDescription,
    } : null,
    cleanResponse: delegationInfo.cleanResponse,
  };
}

export default {
  SILENT_TOKEN,
  TASK_TOKEN,
  ESCALATE_TOKEN,
  DELEGATE_TOKEN,
  isSilentReply,
  parseTaskCommitment,
  parseEscalation,
  parseDelegation,
  parseResponse,
};
