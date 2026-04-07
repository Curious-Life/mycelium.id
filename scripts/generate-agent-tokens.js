#!/usr/bin/env node
/**
 * Generate agent tokens for a new managed hosting customer.
 *
 * Outputs:
 *   1. AGENT_REGISTRY fragment (JSON to merge into Worker secret)
 *   2. .env lines for the customer's VPS
 *
 * Usage: node scripts/generate-agent-tokens.js <customer-id> [owner-name]
 *
 * The default agent set matches ecosystem.config.cjs:
 *   - personal-agent (personal, org)
 *   - company-agent (org)
 *   - research-agent (org)
 *   - commercial-intelligence-agent (org)
 *   - publishing-agent (org)
 *   - wealth-agent (wealth, org)
 *   - intel-agent (org)
 *   - ops-agent (org)
 *   - qa-agent (org)
 *   - enrichment-daemon (personal, org, wealth)
 *   - orchestrator (personal, org, wealth)
 */

import { webcrypto } from 'crypto';

const customerId = process.argv[2];
const ownerName = process.argv[3] || 'User';

if (!customerId) {
  console.error('Usage: node scripts/generate-agent-tokens.js <customer-id> [owner-name]');
  process.exit(1);
}

function generateToken() {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

const agents = [
  { name: 'personal-agent',                 envKey: 'AGENT_TOKEN_MYA',         scopes: ['personal', 'org'] },
  { name: 'company-agent',                  envKey: 'AGENT_TOKEN_COM',         scopes: ['org'] },
  { name: 'research-agent',                 envKey: 'AGENT_TOKEN_ADA',         scopes: ['org'] },
  { name: 'commercial-intelligence-agent',  envKey: 'AGENT_TOKEN_REX',         scopes: ['org'] },
  { name: 'publishing-agent',               envKey: 'AGENT_TOKEN_NOA',         scopes: ['org'] },
  { name: 'wealth-agent',                   envKey: 'AGENT_TOKEN_ROB',         scopes: ['wealth', 'org'] },
  { name: 'intel-agent',                    envKey: 'AGENT_TOKEN_APOLLO',      scopes: ['org'] },
  { name: 'ops-agent',                      envKey: 'AGENT_TOKEN_OPS',         scopes: ['org'] },
  { name: 'qa-agent',                       envKey: 'AGENT_TOKEN_QA',          scopes: ['org'] },
  { name: 'enrichment-daemon',              envKey: 'AGENT_TOKEN_ENRICHMENT',  scopes: ['personal', 'org', 'wealth'] },
  { name: 'orchestrator',                   envKey: 'AGENT_TOKEN_ORCHESTRATOR', scopes: ['personal', 'org', 'wealth'] },
];

// Agent ID → short code for compact registry format
const AGENT_SHORT = {
  'personal-agent': 'p', 'company-agent': 'c', 'research-agent': 'r',
  'commercial-intelligence-agent': 'x', 'publishing-agent': 'n',
  'wealth-agent': 'w', 'intel-agent': 'i', 'ops-agent': 'o',
  'qa-agent': 'q', 'enrichment-daemon': 'e', 'orchestrator': 'O',
};

// Generate tokens
const registry = {};
const envLines = [];

for (const agent of agents) {
  const token = generateToken();
  // Compact format: "agentShort:userId"
  const short = AGENT_SHORT[agent.name] || agent.name;
  registry[token] = `${short}:${customerId}`;
  envLines.push(`${agent.envKey}=${token}`);
}

// Output
const output = {
  customerId,
  ownerName,
  registry,
  envLines,
  agentCount: agents.length,
};

// JSON to stdout (for piping to provisioning scripts)
console.log(JSON.stringify(output, null, 2));
