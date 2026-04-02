/**
 * Agent Prompts Index
 *
 * Exports all agent-specific prompts for the multi-agent system.
 *
 * Active agents:
 * - mya-personal: Personal Telegram assistant
 * - research-agent: Ada - Research specialist
 * - company-agent: Mya - Company Discord agent
 */

export { PERSONAL_AGENT_PROMPT, PERSONAL_DELEGATION_CONTEXT, getPersonalPrompt } from './personal';
export { RESEARCH_AGENT_PROMPT, getResearchPrompt } from './research';
export { COMPANY_AGENT_PROMPT, getCompanyPrompt } from './company';

import type { AgentId } from '../../config/mya-agents';
import { getPersonalPrompt } from './personal';
import { getResearchPrompt } from './research';
import { getCompanyPrompt } from './company';

/**
 * Get the appropriate prompt for an agent by ID
 */
export function getAgentPrompt(agentId: AgentId): string {
  switch (agentId) {
    case 'mya-personal':
      return getPersonalPrompt(true);
    case 'research-agent':
      return getResearchPrompt();
    case 'company-agent':
      return getCompanyPrompt();
    default:
      // Fallback to personal prompt for unknown agents
      return getPersonalPrompt(false);
  }
}
