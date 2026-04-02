/**
 * MYA Router - Routes messages to MYA agents based on channel
 *
 * This module handles:
 * 1. Channel-based routing (Telegram chat ID → agent)
 * 2. Delegation request processing
 * 3. Inter-agent communication
 */

// MYA agent configuration
// Agent IDs should match what's used in ecosystem.config.cjs and registry.json
const MYA_AGENTS = {
  'personal-agent': {
    port: 3004,
    memoryScope: 'all',
    channels: {
      telegram: [process.env.OWNER_TELEGRAM_ID || '']
    }
  },
  // Ada - Research Agent
  'research-agent': {
    port: 5002,
    memoryScope: 'research',
    selfModifying: true,
    channels: {
      discord: [] // Configure via DISCORD_RESEARCH_CHANNEL env
    }
  },
  // Company Agent (Discord bot: Com)
  'company-agent': {
    port: 3002,
    memoryScope: 'company',
    selfModifying: true,
    channels: {
      discord: [] // Configure via DISCORD_COMPANY_CHANNEL env
    }
  },
  // Noa - Publishing Agent (Discord bot: Noa)
  'publishing-agent': {
    port: 5006,
    memoryScope: 'publishing',
    selfModifying: true,
    channels: {
      discord: [] // Configure via DISCORD_PUBLISHING_CHANNEL env
    }
  }
};

// Delegation allowed matrix
// Format: 'from-agent': ['to-agent1', 'to-agent2']
const DELEGATION_ALLOWED = {
  'personal-agent': ['research-agent'],
  'company-agent': ['research-agent'],
  'research-agent': ['publishing-agent'], // Can delegate content tasks to Noa
  'publishing-agent': ['research-agent'] // Can request research from Ada
};

/**
 * Determine which MYA agent should handle a message based on channel
 */
export function routeMessage({ telegramChatId, discordChannelId }) {
  // Check Telegram routing first
  if (telegramChatId) {
    for (const [agentId, config] of Object.entries(MYA_AGENTS)) {
      if (config.channels.telegram?.includes(telegramChatId)) {
        return { agentId, port: config.port };
      }
    }
    // Default Telegram to personal agent
    return { agentId: 'personal-agent', port: MYA_AGENTS['personal-agent'].port };
  }

  // Check Discord routing
  if (discordChannelId) {
    for (const [agentId, config] of Object.entries(MYA_AGENTS)) {
      if (config.channels.discord?.includes(discordChannelId)) {
        return { agentId, port: config.port };
      }
    }
  }

  // Default fallback to personal
  return { agentId: 'personal-agent', port: MYA_AGENTS['personal-agent'].port };
}

/**
 * Check if delegation is allowed from one agent to another
 */
export function canDelegate(fromAgent, toAgent) {
  return DELEGATION_ALLOWED[fromAgent]?.includes(toAgent) || false;
}

/**
 * Get agent config
 */
export function getAgentConfig(agentId) {
  return MYA_AGENTS[agentId] || null;
}

/**
 * Forward a message to a specific MYA agent
 */
export async function forwardToAgent(agentId, message, context = {}) {
  const config = MYA_AGENTS[agentId];
  if (!config) {
    throw new Error(`Unknown agent: ${agentId}`);
  }

  const response = await fetch(`http://localhost:${config.port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      context,
      agentId
    })
  });

  if (!response.ok) {
    throw new Error(`Agent ${agentId} returned ${response.status}`);
  }

  return response.json();
}

/**
 * Process a delegation request
 * Called by the orchestrator's delegation worker
 */
export async function processDelegation(delegation) {
  const { id, from_agent, to_agent, task, context, priority } = delegation;

  console.log(`[MYA Router] Processing delegation ${id}: ${from_agent} → ${to_agent}`);

  // Validate delegation is allowed
  if (!canDelegate(from_agent, to_agent)) {
    return {
      id,
      status: 'failed',
      error: `Delegation not allowed: ${from_agent} cannot delegate to ${to_agent}`
    };
  }

  try {
    // Forward to target agent
    const result = await forwardToAgent(to_agent, task, {
      delegatedFrom: from_agent,
      delegationId: id,
      priority,
      additionalContext: context
    });

    return {
      id,
      status: 'completed',
      result
    };
  } catch (error) {
    console.error(`[MYA Router] Delegation ${id} failed:`, error.message);
    return {
      id,
      status: 'failed',
      error: error.message
    };
  }
}

/**
 * Start delegation worker that polls for pending delegations
 * In production, this would use Cloudflare Queues or similar
 */
export function startDelegationWorker(pollIntervalMs = 5000) {
  console.log(`[MYA Router] Starting delegation worker (poll interval: ${pollIntervalMs}ms)`);

  const worker = setInterval(async () => {
    // In development, we'd poll a local store or database
    // In production, this would be replaced by Cloudflare Queue consumers
    // For now, this is a placeholder that logs when running
  }, pollIntervalMs);

  return {
    stop: () => clearInterval(worker)
  };
}

export default {
  routeMessage,
  canDelegate,
  getAgentConfig,
  forwardToAgent,
  processDelegation,
  startDelegationWorker,
  MYA_AGENTS
};
