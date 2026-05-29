/**
 * Agent Config Tests
 *
 * Verifies the config-driven agent system loads correctly and
 * replaces the old hardcoded AGENT_NAMES, AGENT_REGISTRY, AGENT_BOT_IDS.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('lib/agent-config.js', () => {
  let mod;

  before(async () => {
    mod = await import('@mycelium/core/agent-config.js');
    mod.clearCache();
  });

  it('getAllAgents returns an array of configs', () => {
    const agents = mod.getAllAgents();
    assert.ok(Array.isArray(agents));
    assert.ok(agents.length >= 8, `Expected at least 8 agents, got ${agents.length}`);
  });

  it('every config has required fields', () => {
    const required = ['id', 'name', 'role', 'color', 'port', 'tier', 'memoryScope'];
    for (const agent of mod.getAllAgents()) {
      for (const field of required) {
        assert.ok(agent[field] !== undefined, `Agent ${agent.id} missing field: ${field}`);
      }
    }
  });

  it('no duplicate agent IDs', () => {
    const ids = mod.getAllAgents().map(a => a.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `Duplicate IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });

  it('no duplicate ports', () => {
    const ports = mod.getAllAgents().map(a => a.port);
    const unique = new Set(ports);
    assert.equal(ports.length, unique.size, `Duplicate ports found: ${ports.filter((p, i) => ports.indexOf(p) !== i)}`);
  });

  it('getAgentConfig returns correct agent', () => {
    const pa = mod.getAgentConfig('personal-agent');
    assert.ok(pa);
    assert.equal(pa.name, 'Personal');
    assert.equal(pa.port, 3004);
  });

  it('getAgentConfig returns null for unknown agent', () => {
    assert.equal(mod.getAgentConfig('nonexistent-agent'), null);
  });

  it('getAgentNames returns { id: name } map', () => {
    const names = mod.getAgentNames();
    assert.equal(typeof names, 'object');
    assert.equal(names['personal-agent'], 'Personal');
    assert.equal(names['company-agent'], 'Operations');
    assert.equal(names['research-agent'], 'Research');
    assert.equal(names['wealth-agent'], 'Finance');
    assert.equal(names['intel-agent'], 'Intelligence');
  });

  it('getAgentRegistry returns { id: { name, port, color, role } }', () => {
    const reg = mod.getAgentRegistry();
    assert.equal(typeof reg, 'object');
    const pa = reg['personal-agent'];
    assert.ok(pa);
    assert.equal(pa.name, 'Personal');
    assert.equal(pa.port, 3004);
    assert.equal(pa.color, 'azure');
    assert.equal(pa.role, 'Your thinking partner');
  });

  it('getAgentBotIds returns map with env var lookups', () => {
    const bots = mod.getAgentBotIds();
    assert.equal(typeof bots, 'object');
    // Bot IDs come from env vars which won't be set in test, so values will be undefined
    // But the keys should exist for agents that have discordBotIdEnv
    assert.ok('personal-agent' in bots);
  });

  it('getFallbackAgents includes all agents with urls and capabilities', () => {
    const fallback = mod.getFallbackAgents();
    assert.equal(typeof fallback, 'object');
    const keys = Object.keys(fallback);
    assert.ok(keys.length >= 8, `Expected at least 8 agents in fallback, got ${keys.length}`);
    // Each entry has url and capabilities
    for (const [id, entry] of Object.entries(fallback)) {
      assert.ok(entry.url, `${id} missing url`);
      assert.ok(entry.url.startsWith('http://localhost:'), `${id} url should be localhost`);
      assert.ok(Array.isArray(entry.capabilities), `${id} missing capabilities array`);
    }
  });

  it('getAgentDisplayName returns name for known agents', () => {
    assert.equal(mod.getAgentDisplayName('personal-agent'), 'Personal');
    assert.equal(mod.getAgentDisplayName('research-agent'), 'Research');
  });

  it('getAgentDisplayName falls back to id for unknown agents', () => {
    assert.equal(mod.getAgentDisplayName('unknown-agent'), 'unknown-agent');
  });

  it('_template.json is excluded from loading', () => {
    const ids = mod.getAllAgents().map(a => a.id);
    assert.ok(!ids.includes('my-agent'), '_template.json should not be loaded (starts with _)');
  });

  // Config-specific checks for Phase 1
  it('intel-agent has intel module', () => {
    const conf = mod.getAgentConfig('intel-agent');
    assert.ok(conf.modules.includes('intel'));
  });

  it('wealth-agent has wealth-tools MCP server', () => {
    const conf = mod.getAgentConfig('wealth-agent');
    assert.ok(conf.extraMcpServers.includes('wealth-tools'));
  });

  it('personal-agent has prefersTelegram: true', () => {
    const conf = mod.getAgentConfig('personal-agent');
    assert.equal(conf.prefersTelegram, true);
  });

  it('personal-agent has servesPortal: true', () => {
    const conf = mod.getAgentConfig('personal-agent');
    assert.equal(conf.servesPortal, true);
  });

  it('getCollabBotIds returns shortname → botId map', () => {
    const bots = mod.getCollabBotIds();
    assert.equal(typeof bots, 'object');
    assert.ok('personal' in bots);
    assert.ok('operations' in bots);
    assert.ok('research' in bots);
  });

  it('getAgentToBotName returns agentId → shortname map', () => {
    const map = mod.getAgentToBotName();
    assert.equal(map['personal-agent'], 'personal');
    assert.equal(map['company-agent'], 'operations');
    assert.equal(map['research-agent'], 'research');
  });
});
