/**
 * Ecosystem Builder Tests
 *
 * Verifies that the config-driven ecosystem builder produces
 * correct PM2 entries matching the expected agent configuration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('lib/ecosystem-builder.cjs', () => {
  const builder = require('../lib/ecosystem-builder.cjs');

  it('loadAgentConfigs returns all agents', () => {
    const configs = builder.loadAgentConfigs();
    assert.ok(configs.length >= 8, `Expected at least 8 agents, got ${configs.length}`);
  });

  it('buildAll produces agent + bot + scheduler entries', () => {
    const sharedEnv = { NODE_ENV: 'production', MYA_WORKER_URL: 'http://test' };
    const apps = builder.buildAll(sharedEnv);

    // At least one agent entry per config
    const agents = apps.filter(a => a.script === 'agent-server.js');
    assert.ok(agents.length >= 8, `Expected at least 8 agent entries, got ${agents.length}`);
  });

  it('agent entries have correct shape', () => {
    const sharedEnv = { NODE_ENV: 'production' };
    const apps = builder.buildAll(sharedEnv);
    const research = apps.find(a => a.name === 'research-agent');

    assert.ok(research, 'research-agent should exist');
    assert.equal(research.script, 'agent-server.js');
    assert.equal(research.env.PORT, 5002);
    assert.equal(research.env.AGENT_ID, 'research-agent');
    assert.equal(research.env.MEMORY_SCOPE, 'research');
  });

  it('personal-agent on correct port', () => {
    const apps = builder.buildAll({});
    const mya = apps.find(a => a.name === 'personal-agent');
    assert.ok(mya);
    assert.equal(mya.env.PORT, 3004);
  });

  it('company-agent on correct port', () => {
    const apps = builder.buildAll({});
    const com = apps.find(a => a.name === 'company-agent');
    assert.ok(com);
    assert.equal(com.env.PORT, 3002);
  });

  it('wealth-agent on correct port', () => {
    const apps = builder.buildAll({});
    const rob = apps.find(a => a.name === 'wealth-agent');
    assert.ok(rob);
    assert.equal(rob.env.PORT, 5010);
  });

  it('no duplicate process names', () => {
    const apps = builder.buildAll({});
    const names = apps.map(a => a.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, `Duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('scheduler entries have AGENT_ID set', () => {
    const apps = builder.buildAll({ MYA_WORKER_URL: 'http://test' });
    const schedulers = apps.filter(a => a.name.includes('scheduler'));

    for (const s of schedulers) {
      assert.ok(s.env.AGENT_ID, `Scheduler ${s.name} missing AGENT_ID`);
      assert.ok(s.env.AGENT_URL, `Scheduler ${s.name} missing AGENT_URL`);
    }
  });
});
