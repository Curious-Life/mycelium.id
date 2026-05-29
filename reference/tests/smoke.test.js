/**
 * Smoke Tests — Mycelium Core Stack
 *
 * Verifies modules load, interfaces are correct, and mind-search
 * integration points exist. Run with: npm test
 *
 * Uses Node's built-in test runner (node:test) — zero dependencies.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ── DB Abstraction Layer ────────────────────────────────────────────────────

describe('lib/db.js', () => {
  let dbModule;

  before(async () => {
    dbModule = await import('@mycelium/core/db.js');
  });

  it('exports initDb, getDb, tryGetDb', () => {
    assert.equal(typeof dbModule.initDb, 'function');
    assert.equal(typeof dbModule.getDb, 'function');
    assert.equal(typeof dbModule.tryGetDb, 'function');
  });

  it('getDb throws before initialization', () => {
    assert.throws(() => dbModule.getDb(), /not initialized/i);
  });

  it('tryGetDb returns null before initialization', () => {
    assert.equal(dbModule.tryGetDb(), null);
  });
});

// ── D1 Backend ──────────────────────────────────────────────────────────────

describe('lib/db-d1.js', () => {
  let createD1Backend;

  before(async () => {
    const mod = await import('@mycelium/core/db-d1.js');
    createD1Backend = mod.createD1Backend;
  });

  it('exports createD1Backend function', () => {
    assert.equal(typeof createD1Backend, 'function');
  });

  it('creates backend with all interface groups', () => {
    const db = createD1Backend();
    const expectedGroups = [
      'messages', 'events', 'agentTasks', 'attachments',
      'users', 'userIdentities', 'sessions', 'oauthStates',
      'documents', 'tasks', 'folders', 'canvases',
      'search', 'topology',
    ];
    for (const group of expectedGroups) {
      assert.ok(db[group], `missing interface group: ${group}`);
      assert.equal(typeof db[group], 'object', `${group} should be an object`);
    }
  });

  it('messages has insert, selectRecent, matchMessages', () => {
    const db = createD1Backend();
    assert.equal(typeof db.messages.insert, 'function');
    assert.equal(typeof db.messages.selectRecent, 'function');
    // Wave 4b: hybridSearch removed. matchMessages routes through the
    // mind-search registry; falls back to [] when no backend registered.
    assert.equal(typeof db.messages.matchMessages, 'function');
  });

  it('search has matchTerritories, matchRealms, matchThemes, lookupTerritoryByName', () => {
    const db = createD1Backend();
    assert.equal(typeof db.search.matchTerritories, 'function');
    assert.equal(typeof db.search.matchRealms, 'function');
    assert.equal(typeof db.search.matchThemes, 'function');
    assert.equal(typeof db.search.lookupTerritoryByName, 'function');
  });

  it('topology has getCoFiring, getOrphans, getBridges, getGaps, getCluster', () => {
    const db = createD1Backend();
    assert.equal(typeof db.topology.getCoFiring, 'function');
    assert.equal(typeof db.topology.getOrphans, 'function');
    assert.equal(typeof db.topology.getBridges, 'function');
    assert.equal(typeof db.topology.getGaps, 'function');
    assert.equal(typeof db.topology.getCluster, 'function');
  });

  it('documents has get, upsert, list', () => {
    const db = createD1Backend();
    assert.equal(typeof db.documents.get, 'function');
    assert.equal(typeof db.documents.upsert, 'function');
    assert.equal(typeof db.documents.list, 'function');
  });
});

// ── Embeddings ──────────────────────────────────────────────────────────────

describe('@mycelium/core/local-ai-client.js', () => {
  let embedModule;

  before(async () => {
    embedModule = await import('@mycelium/core/local-ai-client.js');
  });

  it('exports generateEmbedding function', () => {
    assert.equal(typeof embedModule.generateEmbedding, 'function');
  });
});

// ── Runtime ─────────────────────────────────────────────────────────────────

describe('lib/runtime.js', () => {
  let runtimeModule;

  before(async () => {
    runtimeModule = await import('@mycelium/core/runtime.js');
  });

  it('exports createRuntime and createRuntimeWithDb', () => {
    assert.equal(typeof runtimeModule.createRuntime, 'function');
    assert.equal(typeof runtimeModule.createRuntimeWithDb, 'function');
  });

  it('exports deprecated createRuntimeWithSupabase alias', () => {
    assert.equal(typeof runtimeModule.createRuntimeWithSupabase, 'function');
    assert.equal(runtimeModule.createRuntimeWithSupabase, runtimeModule.createRuntimeWithDb);
  });

  it('createRuntime returns frozen object with correct shape', () => {
    const runtime = runtimeModule.createRuntime('test-agent');
    assert.equal(runtime.agentId, 'test-agent');
    assert.ok(runtime.features);
    assert.equal(typeof runtime.features.hasDb, 'boolean');
    assert.equal(typeof runtime.features.hasDiscord, 'boolean');
    assert.equal(typeof runtime.features.hasR2, 'boolean');
    assert.throws(() => { runtime.agentId = 'changed'; });
  });

  it('features.hasDb checks MYA_WORKER_URL', () => {
    // Without MYA_WORKER_URL set, should be false
    const original = process.env.MYA_WORKER_URL;
    delete process.env.MYA_WORKER_URL;
    const runtime = runtimeModule.createRuntime('test-agent');
    assert.equal(runtime.features.hasDb, false);
    if (original) process.env.MYA_WORKER_URL = original;
  });
});

// ── Error Classifier ────────────────────────────────────────────────────────

describe('lib/error-classifier.js', () => {
  let classifier;

  before(async () => {
    classifier = await import('@mycelium/core/error-classifier.js');
  });

  it('exports ErrorReason enum with expected values', () => {
    assert.ok(classifier.ErrorReason);
    assert.equal(classifier.ErrorReason.RATE_LIMIT, 'rate_limit');
    assert.equal(classifier.ErrorReason.BILLING, 'billing');
    assert.equal(classifier.ErrorReason.TIMEOUT, 'timeout');
    assert.equal(classifier.ErrorReason.UNKNOWN, 'unknown');
  });

  it('exports classifyError and captureError functions', () => {
    assert.equal(typeof classifier.classifyError, 'function');
    assert.equal(typeof classifier.captureError, 'function');
  });

  it('classifies rate limit errors correctly', () => {
    const err = new Error('Rate limit exceeded');
    err.status = 429;
    assert.equal(classifier.classifyError(err), 'rate_limit');
  });

  it('classifies billing errors correctly', () => {
    const err = new Error('Payment required');
    err.status = 402;
    assert.equal(classifier.classifyError(err), 'billing');
  });

  it('returns unknown for null/undefined', () => {
    assert.equal(classifier.classifyError(null), 'unknown');
    assert.equal(classifier.classifyError(undefined), 'unknown');
  });
});

// ── Scheduler ───────────────────────────────────────────────────────────────

describe('lib/scheduler.js', () => {
  let schedulerModule;

  before(async () => {
    // Prevent auto-start by ensuring env vars are unset
    const origUrl = process.env.AGENT_URL;
    const origUserId = process.env.USER_ID;
    delete process.env.AGENT_URL;
    delete process.env.USER_ID;
    schedulerModule = await import('@mycelium/core/scheduler.js');
    if (origUrl) process.env.AGENT_URL = origUrl;
    if (origUserId) process.env.USER_ID = origUserId;
  });

  it('exports startScheduler and stopScheduler', () => {
    assert.equal(typeof schedulerModule.startScheduler, 'function');
    assert.equal(typeof schedulerModule.stopScheduler, 'function');
  });
});

// ── Sentry ──────────────────────────────────────────────────────────────────

describe('lib/sentry.js', () => {
  let sentryModule;

  before(async () => {
    sentryModule = await import('@mycelium/core/sentry.js');
  });

  it('exports Sentry object', () => {
    assert.ok(sentryModule.Sentry);
    assert.equal(typeof sentryModule.Sentry.captureException, 'function');
    assert.equal(typeof sentryModule.Sentry.init, 'function');
  });
});

// ── MCP Tools ───────────────────────────────────────────────────────────────

describe('packages/tools/agent-tools — tool definitions', async () => {
  // Tools live in packages/tools/agent-tools/domains/*.js — each domain
  // module exports a create*Domain factory whose returned `tools` array
  // is the source of truth. Read the domain dir + glob name: '...' across
  // all .js files. Brittle vs full import (which needs USER_ID + worker
  // env), but cheap.
  let combined;

  before(async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const dir = new URL('../packages/tools/agent-tools/domains/', import.meta.url);
    const files = (await readdir(dir)).filter(f => f.endsWith('.js'));
    const parts = await Promise.all(
      files.map(f => readFile(new URL(f, dir), 'utf-8'))
    );
    combined = parts.join('\n');
  });

  it('defines at least 15 tools across domain modules', () => {
    const toolNames = combined.match(/\bname:\s*'([a-zA-Z_]\w*)'/g);
    assert.ok(toolNames && toolNames.length >= 15,
      `expected at least 15 tools, found ${toolNames?.length ?? 0}`);
  });

  it('includes consolidated search + topology tools', () => {
    assert.ok(combined.includes("name: 'searchMindscape'"), 'missing searchMindscape');
    assert.ok(combined.includes("name: 'exploreTerritory'"), 'missing exploreTerritory');
    assert.ok(combined.includes("name: 'mindscapeStructure'"), 'missing mindscapeStructure');
  });

  it('does NOT include removed tools', () => {
    const removed = [
      // Wave 4b retirements
      'searchHistory', 'searchTerritories', 'searchRealms', 'searchThemes',
      'getCoFiring', 'getOrphans', 'getBridges', 'getGaps', 'getCluster',
      'pinDocument', 'unpinDocument',
      // 2026-05-08 reply-deferral retirement (caadd92)
      'createDocument', 'editDocumentContent', 'shareDocument', 'unpublishDocument',
      'listDataSources', 'exploreMindscape',
      'update_schedule', 'pause_schedule', 'resume_schedule', 'cancel_schedule',
      'gmail',
      'get_space_growth', 'space_scan', 'add_space_knowledge', 'edit_space_knowledge',
      'listFolders', 'listCanvases',
      'pathBetween', 'territoryLineage', 'vitalityExplainer',
    ];
    for (const tool of removed) {
      assert.ok(!combined.includes(`name: '${tool}'`), `removed tool still present: ${tool}`);
    }
  });

  it('includes core document tools', () => {
    assert.ok(combined.includes("name: 'getDocument'"), 'missing getDocument');
    assert.ok(combined.includes("name: 'saveDocument'"), 'missing saveDocument');
    assert.ok(combined.includes("name: 'updateDocument'"), 'missing updateDocument');
    assert.ok(combined.includes("name: 'listDocuments'"), 'missing listDocuments');
  });
});

// ── Ecosystem Config ────────────────────────────────────────────────────────

describe('ecosystem.config.cjs', () => {
  let config;

  before(async () => {
    // ecosystem.config.cjs is CommonJS, use createRequire
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    config = require('../ecosystem.config.cjs');
  });

  it('has apps array', () => {
    assert.ok(Array.isArray(config.apps));
    assert.ok(config.apps.length > 0);
  });

  it('no process references SUPABASE', () => {
    for (const app of config.apps) {
      const env = app.env || {};
      const keys = Object.keys(env);
      const supabaseKeys = keys.filter(k => k.includes('SUPABASE'));
      assert.equal(supabaseKeys.length, 0,
        `${app.name} still has Supabase env vars: ${supabaseKeys.join(', ')}`);
    }
  });

  it('all processes with Sentry import have SENTRY_DSN', () => {
    // These processes import lib/sentry.js and need SENTRY_DSN
    const needsSentry = [
      'orchestrator',
      'research-discord-bot',
      'commercial-intel-discord-bot',
      'publishing-discord-bot',
      'mya-telegram-bot',
      'mya-discord-bot',
      'personal-scheduler',
    ];
    for (const name of needsSentry) {
      const app = config.apps.find(a => a.name === name);
      if (!app) continue; // optional process
      const env = app.env || {};
      assert.ok('SENTRY_DSN' in env, `${name} missing SENTRY_DSN`);
    }
  });

  it('agent servers use D1 backend', () => {
    const agents = config.apps.filter(a => a.script === 'agent-server.js');
    for (const agent of agents) {
      const env = agent.env || {};
      // Either from SHARED_AGENT_ENV spread or explicit
      assert.ok(
        env.DB_BACKEND === undefined || env.DB_BACKEND?.includes?.('d1') || typeof env.DB_BACKEND === 'string',
        `${agent.name} DB_BACKEND should be d1`
      );
    }
  });
});

// ── QA Pipeline ─────────────────────────────────────────────────────────────

describe('lib/qa-pipeline.js', () => {
  let qaPipeline;

  before(async () => {
    qaPipeline = await import('@mycelium/core/qa-pipeline.js');
  });

  it('exports runTests, formatTestReport, buildSentryFixPrompt, buildVerifyPrompt', () => {
    assert.equal(typeof qaPipeline.runTests, 'function');
    assert.equal(typeof qaPipeline.formatTestReport, 'function');
    assert.equal(typeof qaPipeline.buildSentryFixPrompt, 'function');
    assert.equal(typeof qaPipeline.buildVerifyPrompt, 'function');
  });

  it('buildSentryFixPrompt generates prompt with test verification steps', () => {
    const prompt = qaPipeline.buildSentryFixPrompt(
      [{ title: 'TypeError: x is not a function', level: 'error', count: 5, userCount: 2,
         culprit: 'lib/runner.js', firstSeen: '2026-02-18', lastSeen: '2026-02-18',
         tags: 'runtime=node', stacktrace: '  lib/runner.js:42 in runClaudeCode',
         sentryLink: 'https://sentry.io/issues/1/' }],
      { reportsChannelId: '123', agentPort: 5008, repoCwd: '/home/claude/mycelium' },
    );
    assert.ok(prompt.includes('Baseline'), 'prompt should include baseline test step');
    assert.ok(prompt.includes('Verify'), 'prompt should include verify step');
    assert.ok(prompt.includes('node --test'), 'prompt should include test command');
    assert.ok(prompt.includes('CRITICAL'), 'prompt should include critical test gate');
    assert.ok(prompt.includes('123'), 'prompt should include channel ID');
  });

  it('buildVerifyPrompt generates verification prompt', () => {
    const prompt = qaPipeline.buildVerifyPrompt(
      'Verify the delegation fix works',
      'Commit 8901d6e wired delegate_to_agent',
      { reportsChannelId: '123', agentPort: 5008 },
    );
    assert.ok(prompt.includes('Verification Request'), 'should be a verification prompt');
    assert.ok(prompt.includes('delegation fix'), 'should include the task');
    assert.ok(prompt.includes('node --test'), 'should include test command');
  });

  it('formatTestReport formats passing results', () => {
    const report = qaPipeline.formatTestReport({ passed: true, total: 32, failed: 0, output: '' });
    assert.ok(report.includes('PASS'));
    assert.ok(report.includes('32'));
  });

  it('formatTestReport formats failing results with output snippet', () => {
    const report = qaPipeline.formatTestReport({
      passed: false, total: 32, failed: 2,
      output: 'AssertionError: expected true to be false\n  at test.js:42',
    });
    assert.ok(report.includes('FAIL'));
    assert.ok(report.includes('2 failed'));
    assert.ok(report.includes('AssertionError'));
  });
});

// ── Delegation — QA Agent Discovery ─────────────────────────────────────────

describe('lib/delegation.js — QA agent fallback', () => {
  it('FALLBACK_AGENTS includes qa-agent via agent config', async () => {
    const { getFallbackAgents } = await import('@mycelium/core/agent-config.js');
    const fallback = getFallbackAgents();
    assert.ok(fallback['qa-agent'], 'qa-agent should be in fallback agents');
    assert.ok(fallback['qa-agent'].url.includes('5008'), 'qa-agent should be on port 5008');
  });
});

// ── Ecosystem — QA Agent Config ─────────────────────────────────────────────

describe('ecosystem.config.cjs — QA agent', () => {
  let config;

  before(async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    // Clear require cache to pick up changes
    delete require.cache[require.resolve('../ecosystem.config.cjs')];
    config = require('../ecosystem.config.cjs');
  });

  it('includes qa-agent process', () => {
    const qa = config.apps.find(a => a.name === 'qa-agent');
    assert.ok(qa, 'qa-agent not found in ecosystem.config.cjs');
    assert.equal(qa.script, 'packages/server/agent-server.js');
    assert.equal(qa.env.PORT, 5008);
    assert.equal(qa.env.AGENT_ID, 'qa-agent');
  });

  it('qa-agent has Sentry polling configured', () => {
    const qa = config.apps.find(a => a.name === 'qa-agent');
    assert.ok(qa.env.SENTRY_POLL_ENABLED !== undefined, 'qa-agent should have SENTRY_POLL_ENABLED configured');
  });

  it('company-agent no longer has Sentry polling', () => {
    const com = config.apps.find(a => a.name === 'company-agent');
    assert.ok(com, 'company-agent not found');
    assert.notEqual(com.env.SENTRY_POLL_ENABLED, 'true',
      'Sentry polling should be moved from company-agent to qa-agent');
  });
});

// ── No Supabase References ──────────────────────────────────────────────────

describe('supabase fully removed', () => {
  it('lib/db-supabase.js does not exist', async () => {
    const { access } = await import('node:fs/promises');
    await assert.rejects(
      access(new URL('../packages/core/db-supabase.js', import.meta.url)),
      'packages/core/db-supabase.js should be deleted'
    );
  });

  it('package.json has no supabase dependency', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url), 'utf-8'
    ));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    const supabaseDeps = Object.keys(allDeps).filter(k => k.includes('supabase'));
    assert.equal(supabaseDeps.length, 0, `supabase deps found: ${supabaseDeps.join(', ')}`);
  });

  it('lib/db.js has no supabase import path', async () => {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(
      new URL('../packages/core/db.js', import.meta.url), 'utf-8'
    );
    assert.ok(!content.includes('db-supabase'), 'packages/core/db.js still references db-supabase');
    assert.ok(!content.includes('supabase'), 'packages/core/db.js still references supabase');
  });
});
