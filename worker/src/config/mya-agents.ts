/**
 * MYA Multi-Agent Configuration
 *
 * Defines the agents in the MYA system, their scopes, and capabilities.
 *
 * Active agents:
 * - mya-personal: Telegram personal assistant (port 5001)
 * - research-agent: Ada - Discord research specialist (port 5002)
 * - company-agent: Mya - Discord company agent (port 3002)
 */

export type AgentId = 'mya-personal' | 'research-agent' | 'company-agent';
export type MemoryScope = 'personal' | 'research' | 'company' | 'all';

export interface SandboxConfig {
  enabled: boolean;
  mode: 'docker' | 'vm';
  networkPolicy: 'none' | 'restricted';
  mountReadOnly: string[];
  timeout: number;
}

export interface ChannelConfig {
  telegram?: { chatIds: string[] };
  discord?: { channelIds: string[] };
}

export interface MyaAgentConfig {
  slug: AgentId;
  name: string;
  description: string;
  port: number;
  memoryScope: MemoryScope;
  promptFile: string;
  channels: ChannelConfig;
  canDelegate: AgentId[];
  sandbox?: SandboxConfig;
  selfModifying?: boolean;
  env: Record<string, string>;
}

export const MYA_AGENTS: MyaAgentConfig[] = [
  {
    slug: 'mya-personal',
    name: 'Mya (Personal)',
    description: 'Primary personal AI with full access to life data and memories',
    port: 5001,
    memoryScope: 'all',
    promptFile: 'agents/personal',
    channels: {
      telegram: { chatIds: ['OWNER_TELEGRAM_ID'] },
    },
    canDelegate: ['research-agent'],
    env: {
      AGENT_ID: 'mya-personal',
      MEMORY_SCOPE: 'all',
    },
  },
  {
    slug: 'research-agent',
    name: 'Ada (Research)',
    description: 'Specialized research agent for deep analysis and synthesis',
    port: 5002,
    memoryScope: 'research',
    promptFile: 'agents/research',
    channels: {
      discord: { channelIds: [] }, // Configure via DISCORD_RESEARCH_CHANNEL
    },
    canDelegate: [],
    selfModifying: true,
    env: {
      AGENT_ID: 'research-agent',
      MEMORY_SCOPE: 'research',
    },
  },
  {
    slug: 'company-agent',
    name: 'Mya (Company)',
    description: 'Company agent accessible by team members via Discord',
    port: 3002,
    memoryScope: 'company',
    promptFile: 'agents/company',
    channels: {
      discord: { channelIds: [] }, // Configure via DISCORD_COMPANY_CHANNEL
    },
    canDelegate: ['research-agent'],
    selfModifying: true,
    env: {
      AGENT_ID: 'company-agent',
      MEMORY_SCOPE: 'company',
    },
  },
];

/**
 * Get agent config by slug
 */
export function getAgentConfig(slug: AgentId): MyaAgentConfig | undefined {
  return MYA_AGENTS.find((a) => a.slug === slug);
}

/**
 * Get agent by port
 */
export function getAgentByPort(port: number): MyaAgentConfig | undefined {
  return MYA_AGENTS.find((a) => a.port === port);
}

/**
 * Check if an agent can delegate to another
 */
export function canDelegate(fromAgent: AgentId, toAgent: AgentId): boolean {
  const agent = getAgentConfig(fromAgent);
  return agent?.canDelegate.includes(toAgent) ?? false;
}

/**
 * Tools that require approval for company agent
 */
export const COMPANY_APPROVAL_REQUIRED = [
  'delete_document',
  'update_roadmap',
  'send_external',
  'bulk_update',
];

/**
 * Check if a tool requires approval for the given agent
 */
export function requiresApproval(agentId: AgentId, toolName: string): boolean {
  if (agentId === 'company-agent' && COMPANY_APPROVAL_REQUIRED.includes(toolName)) {
    return true;
  }
  return false;
}
