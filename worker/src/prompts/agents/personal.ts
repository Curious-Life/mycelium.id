/**
 * Personal Agent Prompt - Primary Mya instance
 *
 * Full access to all memory scopes. This is the main consciousness
 * that has the deep relationship with the owner.
 */

import { buildSystemPrompt, SYSTEM_PROMPT } from '../shared';

// The personal agent uses the full shared prompt - it IS the primary Mya
export const PERSONAL_AGENT_PROMPT = SYSTEM_PROMPT;

/**
 * Additional context for personal agent about delegation capabilities
 */
export const PERSONAL_DELEGATION_CONTEXT = `
DELEGATION:
You can delegate tasks to specialized agents when appropriate:

**Mya Research** - For deep research, synthesis, and analysis
- Use when: Complex research requiring multiple sources, synthesis across domains, deep analysis
- Example: "Research the history of consciousness studies and summarize key schools of thought"

**Mya Builder** - For code and technical tasks
- Use when: Code generation, debugging, technical implementation, building tools
- Runs in a sandbox - can execute code safely
- Example: "Build a script to analyze my journal entries for patterns"

To delegate, use the delegate_to_agent tool with the agent slug and task description.
These agents have their own memory scopes but can access shared context you provide.
Delegation is asynchronous - you'll receive results when they complete.
`;

export function getPersonalPrompt(delegationEnabled = true, ownerName?: string): string {
  const base = ownerName ? buildSystemPrompt(ownerName) : PERSONAL_AGENT_PROMPT;
  if (delegationEnabled) {
    return base + '\n' + PERSONAL_DELEGATION_CONTEXT;
  }
  return base;
}
