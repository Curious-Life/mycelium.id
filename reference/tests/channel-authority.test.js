/**
 * End-to-end integration test for the Channel Authority Registry.
 *
 * Wires up: createChannelRegistry → portal-channels router → bots router
 * (with the registry-aware enforceChannelAuthority gate).
 *
 * The test focuses on REJECTION paths — the security-critical surface
 * where the registry must say "no" cleanly. Happy-path delivery uses
 * upstream telegram-api / discord-api modules that need real network
 * stubs; those scenarios are covered separately by:
 *   - packages/server/test/lib/channels.test.js (canSendTo unit)
 *   - packages/server/test/routes/portal-channels.test.js (HTTP surface)
 *   - packages/server/test/routes/bots.test.js (route construction)
 *
 * Cases:
 *   I1: portal kill-switch flip → autonomous send rejected (canonical
 *       wake-cycle silencing)
 *   I2: send-by-name with unknown name → 404 unknown-target-name
 *   I3: fabricated chatId not in registry → 403 unknown-channel
 *       (the inbound-source-fabrication attack class, blocked structurally)
 *   I4: autonomous send to allowAutonomous=false channel → 403
 *   I5: targetName resolves to wrong kind for the route → 400
 *   I6: portal DELETE removes a channel; subsequent send → 404
 *   I7: send with neither chatId nor targetName → 400
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createChannelRegistry } from '../packages/server/lib/channels.js';
import { createPortalChannelsRouter } from '../packages/server/routes/portal-channels.js';
import { createBotsRouter } from '../packages/server/routes/bots.js';

let tmpRoot;
let registry;
let app;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chauth-int-'));

  registry = createChannelRegistry({
    agentId: 'test-agent',
    paths: { memory: { channels: path.join(tmpRoot, 'memory', 'channels.json') } },
    log: { error: () => {}, warn: () => {} },
  });

  // Seed: operator DM + Atmosphere group (no autonomous) + #mya discord (autonomous on).
  registry.bindOperatorDM({ kind: 'telegram', id: '777', label: 'operator-dm' });
  registry.record({
    kind: 'telegram-group', id: '-1001234',
    label: 'Atmosphere Sense & Tune',
    learnedFrom: 'd1:telegram_groups',
    allowAutonomous: false,
  });
  registry.record({
    kind: 'discord', id: 'd-9999',
    label: '#mya',
    learnedFrom: 'config',
    allowAutonomous: true,
  });
  await registry.flushToDisk();

  app = express();
  app.use(express.json());

  // Portal-channels router (operator UI surface).
  app.use('/', createPortalChannelsRouter({
    authenticatePortalRequest: async () => ({ id: 'user-1' }),
    requireWorkerSecret: () => false,
    tryGetDb: () => ({
      telegramGroups: { authorize: async () => {}, revoke: async () => {} },
    }),
    getRegistry: () => registry,
    getCanonicalUserId: async () => 'user-1',
    config: { LOG_PREFIX: 'TestInt' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }));

  // Bots router with registry — exercises enforceChannelAuthority.
  app.use('/', createBotsRouter({
    runtimeState: { hookBus: { emit: () => {} } },
    tryGetDb: () => null,
    paths: { root: tmpRoot, repo: tmpRoot },
    config: { AGENT_ID: 'test-agent', LOG_PREFIX: 'TestInt', PORT: 0 },
    requireWorkerSecret: () => true,
    addActivity: () => {},
    safeError: (err) => err.message,
    trackExplicitSend: () => {},
    loadState: async () => ({}),
    saveState: async () => {},
    resetCountersIfNeeded: (s) => s,
    storeAttachmentRecord: async () => {},
    uploadFileToR2: async () => null,
    getAgentDisplayName: () => 'TestAgent',
    canSendProactiveMessage: () => ({ allowed: true }),
    storeAssistantMessage: async () => {},
    getChannelRegistry: () => registry,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }));
});

afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

const longText = 'A long enough message to defeat the trivial-content guard.';

describe('channel-authority (integration)', () => {
  it('I1: portal kill-switch → next autonomous send 403 autonomous-globally-disabled', async () => {
    // Operator flips global kill-switch via the portal endpoint.
    const flip = await request(app)
      .patch('/portal/channels/global')
      .send({ autonomousGlobalEnabled: false });
    assert.equal(flip.status, 200);
    assert.equal(flip.body.autonomousGlobalEnabled, false);

    // Autonomous send to #mya (which has allowAutonomous=true) should now
    // be rejected by the global flag.
    const res = await request(app)
      .post('/discord/send')
      .send({ targetName: '#mya', content: longText, trusted: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'autonomous-globally-disabled');
  });

  it('I2: send-by-name with unknown name → 404 unknown-target-name', async () => {
    const res = await request(app)
      .post('/telegram/send')
      .send({
        targetName: 'Some Group That Does Not Exist',
        text: longText,
        sourceKind: 'telegram', sourceId: '777',
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'unknown-target-name');
  });

  it('I3: fabricated chatId not in registry → 403 unknown-channel (inbound-source-fabrication class)', async () => {
    // The inbound-source-fabrication attack: agent fabricates a plausible chatId. With the
    // registry in place, any id not in the registry returns 403 — the
    // iteration-class attack becomes structurally pointless.
    const res = await request(app)
      .post('/telegram/send')
      .send({
        chatId: '-9999999999',
        text: longText,
        sourceKind: 'telegram', sourceId: '777',
      });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'unknown-channel');
  });

  it('I4: autonomous send to allowAutonomous=false channel → 403', async () => {
    // Atmosphere group has allowAutonomous: false; trusted=true marks autonomous.
    const res = await request(app)
      .post('/telegram/send')
      .send({
        targetName: 'Atmosphere Sense & Tune',
        text: longText,
        trusted: true,
      });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'autonomous-not-allowed');
  });

  it('I5: targetName resolves to wrong kind for the route → 400', async () => {
    // The agent calls /telegram/send but supplies a Discord targetName.
    const res = await request(app)
      .post('/telegram/send')
      .send({
        targetName: '#mya',  // discord, not telegram
        text: longText,
        sourceKind: 'telegram', sourceId: '777',
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'wrong-kind-for-route');
  });

  it('I6: portal DELETE removes a channel; subsequent send-by-name → 404', async () => {
    // Operator revokes via portal.
    const del = await request(app).delete('/portal/channels/discord/d-9999');
    assert.equal(del.status, 200);

    // Send by name now misses the (now inactive) registry entry.
    const after = await request(app)
      .post('/discord/send')
      .send({
        targetName: '#mya',
        content: longText,
        sourceKind: 'telegram', sourceId: '777',
      });
    assert.equal(after.status, 404);
  });

  it('I7: send with neither chatId nor targetName → 400', async () => {
    const res = await request(app)
      .post('/telegram/send')
      .send({ text: longText, sourceKind: 'telegram', sourceId: '777' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /required/);
  });

  it('I8: portal lists registered channels with global flag', async () => {
    const res = await request(app).get('/portal/channels');
    assert.equal(res.status, 200);
    assert.equal(res.body.autonomousGlobalEnabled, true);
    const labels = res.body.channels.map((c) => c.label).sort();
    assert.deepEqual(labels, ['#mya', 'Atmosphere Sense & Tune', 'operator-dm']);
  });
});
