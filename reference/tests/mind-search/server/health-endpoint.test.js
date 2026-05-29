/**
 * server.js — /health/mind-search router tests.
 *
 * Two layers tested:
 *   • getMindSearchHealth(backend) — pure function. Disabled, ok, degraded,
 *     down, throw-during-health.
 *   • createMindSearchRouter — produces a route definition that wraps the
 *     pure handler and writes JSON with status 200.
 *
 * Tests the router via direct invocation of the route handler with mock
 * req/res (no Express required at runtime). Express IS a peer dep but
 * this lets the tests run without depending on it.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getMindSearchHealth,
  createMindSearchRouter,
} from '@mycelium/core/mind-search/server.js';

// ── Test fakes ──────────────────────────────────────────────────────────

function fakeBackend(healthFn) {
  return { health: healthFn };
}

function mockResponse() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

// ── getMindSearchHealth — pure function ─────────────────────────────────

describe('getMindSearchHealth()', () => {
  it('returns { status: "disabled" } when backend is null', async () => {
    assert.deepEqual(await getMindSearchHealth(null), { status: 'disabled' });
  });

  it('returns { status: "disabled" } when backend is undefined', async () => {
    assert.deepEqual(await getMindSearchHealth(undefined), { status: 'disabled' });
  });

  it('returns { status: "disabled" } when backend lacks health()', async () => {
    assert.deepEqual(await getMindSearchHealth({}), { status: 'disabled' });
  });

  it('returns the backend\'s health() body verbatim when ok', async () => {
    const expected = {
      status: 'ok',
      embedServiceUp: true,
      indexLoaded: true,
      indexSize: 42,
      lastQueryAt: 1700000000,
    };
    const result = await getMindSearchHealth(fakeBackend(async () => expected));
    assert.deepEqual(result, expected);
  });

  it('passes through a degraded report', async () => {
    const expected = {
      status: 'degraded',
      embedServiceUp: false,
      indexLoaded: true,
      indexSize: 100,
      lastQueryAt: null,
    };
    const result = await getMindSearchHealth(fakeBackend(async () => expected));
    assert.deepEqual(result, expected);
  });

  it('returns { status: "down", error: "<class>" } when health() throws', async () => {
    const result = await getMindSearchHealth(fakeBackend(async () => {
      const err = new Error('something broke');
      err.class = 'unexpected_failure';
      throw err;
    }));
    assert.equal(result.status, 'down');
    assert.equal(result.error, 'unexpected_failure');
  });

  it('returns { status: "down", error: "unknown" } for errors without a class', async () => {
    const result = await getMindSearchHealth(fakeBackend(async () => {
      throw new Error('plain error');
    }));
    assert.equal(result.status, 'down');
    assert.equal(result.error, 'unknown');
  });
});

// ── createMindSearchRouter — input validation ──────────────────────────

describe('createMindSearchRouter — input validation', () => {
  it('throws TypeError when no deps given', () => {
    assert.throws(() => createMindSearchRouter(), TypeError);
  });

  it('throws TypeError when mindSearch key is absent', () => {
    assert.throws(() => createMindSearchRouter({}), /mindSearch/);
  });

  it('accepts mindSearch as null (disabled)', () => {
    const router = createMindSearchRouter({ mindSearch: null });
    assert.equal(typeof router.routes, 'function');
    assert.equal(typeof router.mount, 'function');
  });

  it('accepts mindSearch as a getter function', () => {
    const router = createMindSearchRouter({ mindSearch: () => null });
    assert.equal(typeof router.routes, 'function');
  });
});

// ── createMindSearchRouter — routes() ──────────────────────────────────

describe('createMindSearchRouter.routes()', () => {
  it('exposes GET /health/mind-search', () => {
    const router = createMindSearchRouter({ mindSearch: null });
    const routes = router.routes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].method, 'GET');
    assert.equal(routes[0].path, '/health/mind-search');
    assert.equal(typeof routes[0].handler, 'function');
  });

  it('handler returns disabled status when backend is null', async () => {
    const router = createMindSearchRouter({ mindSearch: null });
    const handler = router.routes()[0].handler;
    const res = mockResponse();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { status: 'disabled' });
  });

  it('handler resolves the getter on every call (sees swapped backend)', async () => {
    let backend = null;
    const router = createMindSearchRouter({ mindSearch: () => backend });
    const handler = router.routes()[0].handler;

    const res1 = mockResponse();
    await handler({}, res1);
    assert.equal(res1.body.status, 'disabled');

    backend = fakeBackend(async () => ({ status: 'ok', indexSize: 1 }));
    const res2 = mockResponse();
    await handler({}, res2);
    assert.equal(res2.body.status, 'ok');
    assert.equal(res2.body.indexSize, 1);
  });

  it('handler handles backend.health() throw → status: "down"', async () => {
    const router = createMindSearchRouter({
      mindSearch: fakeBackend(async () => {
        const err = new Error('inner failure');
        err.class = 'unexpected_failure';
        throw err;
      }),
    });
    const handler = router.routes()[0].handler;
    const res = mockResponse();
    await handler({}, res);
    assert.equal(res.statusCode, 200); // still 200; body carries status
    assert.equal(res.body.status, 'down');
    assert.equal(res.body.error, 'unexpected_failure');
  });
});

// ── createMindSearchRouter — mount() ───────────────────────────────────

describe('createMindSearchRouter.mount()', () => {
  it('mounts onto an Express-shaped object', () => {
    const registered = [];
    const fakeApp = {
      get(path, handler) {
        registered.push({ method: 'GET', path, handler });
      },
    };
    const router = createMindSearchRouter({ mindSearch: null });
    router.mount(fakeApp);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].method, 'GET');
    assert.equal(registered[0].path, '/health/mind-search');
  });

  it('throws TypeError when app lacks .get()', () => {
    const router = createMindSearchRouter({ mindSearch: null });
    assert.throws(() => router.mount({}), TypeError);
    assert.throws(() => router.mount(null), TypeError);
  });

  it('mounted handler is callable end-to-end', async () => {
    const registered = [];
    const fakeApp = {
      get(path, handler) {
        registered.push({ path, handler });
      },
    };
    const backend = fakeBackend(async () => ({ status: 'ok', indexSize: 99 }));
    const router = createMindSearchRouter({ mindSearch: backend });
    router.mount(fakeApp);
    const { handler } = registered[0];
    const res = mockResponse();
    await handler({}, res);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.indexSize, 99);
  });
});
