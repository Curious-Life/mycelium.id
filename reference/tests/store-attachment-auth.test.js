/**
 * store-attachment-auth — unit tests for /api/store-attachment authorization.
 *
 * These tests pin the auth matrix that gates R2 attachment writes. The bug
 * they regress against (2026-05-08): the original handler required
 * `identity.user_id === body.userId` for ANY non-legacy auth, which silently
 * locked out owner-agent tokens (D1 row carries user_id="system" while the
 * bot sends body.userId=<operator UUID>).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedForAttachment } from '../packages/worker/src/store-attachment-auth.js';

const OPERATOR = 'f7de8ffd-4369-40a2-8bf6-ac0396f7d65f';
const TENANT_USER = '00000000-1111-2222-3333-444444444444';

const ownerAgent = {
  agent: 'personal-agent',
  name: 'personal-agent',
  user_id: 'system',
  scopes: ['personal', 'org', 'wealth'],
  auth_type: 'agent',
  // tenant_id intentionally absent — owner agent
};

const tenantAgent = {
  agent: 'personal-agent',
  name: 'personal-agent',
  user_id: TENANT_USER,
  scopes: ['personal'],
  auth_type: 'agent',
  tenant_id: TENANT_USER,
};

const ownerSession = {
  agent: 'portal',
  name: 'Portal',
  user_id: OPERATOR,
  scopes: ['personal', 'org', 'wealth', 'moms'],
  auth_type: 'session',
  // tenant_id absent — owner portal session
};

const tenantSession = {
  agent: 'portal',
  name: 'Portal',
  user_id: TENANT_USER,
  scopes: ['personal', 'org', 'wealth', 'moms'],
  auth_type: 'session',
  tenant_id: TENANT_USER,
};

describe('isAuthorizedForAttachment', () => {
  it('legacy worker-secret match → authorized regardless of identity', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: null,
        bodyUserId: 'discord-anonymous',
        legacyWorkerSecretMatch: true,
        adminSecretMatch: false,
      }),
      true,
    );
  });

  it('admin-secret match → authorized regardless of identity', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: null,
        bodyUserId: OPERATOR,
        legacyWorkerSecretMatch: false,
        adminSecretMatch: true,
      }),
      true,
    );
  });

  it('owner agent (user_id="system", no tenant_id) → authorized for any body.userId', () => {
    // This is the regression case. body.userId is the operator's actual UUID,
    // identity.user_id is the "system" sentinel. Pre-fix this returned 401.
    assert.equal(
      isAuthorizedForAttachment({
        identity: ownerAgent,
        bodyUserId: OPERATOR,
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      true,
    );
  });

  it('owner agent → authorized even for unrelated body.userId (full owner trust)', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: ownerAgent,
        bodyUserId: 'discord-anonymous',
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      true,
    );
  });

  it('owner session (no tenant_id, auth_type=session) → authorized for any body.userId', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: ownerSession,
        bodyUserId: OPERATOR,
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      true,
    );
  });

  it('tenant agent + matching body.userId → authorized', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: tenantAgent,
        bodyUserId: TENANT_USER,
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      true,
    );
  });

  it('tenant agent + mismatched body.userId → DENIED (cross-tenant isolation)', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: tenantAgent,
        bodyUserId: OPERATOR,
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      false,
    );
  });

  it('tenant session + mismatched body.userId → DENIED', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: tenantSession,
        bodyUserId: OPERATOR,
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      false,
    );
  });

  it('no identity, no secret → DENIED', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: null,
        bodyUserId: OPERATOR,
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      false,
    );
  });

  it('tenant agent with empty body.userId → DENIED', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: tenantAgent,
        bodyUserId: '',
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      false,
    );
  });

  it('tenant agent with undefined body.userId → DENIED', () => {
    assert.equal(
      isAuthorizedForAttachment({
        identity: tenantAgent,
        bodyUserId: undefined,
        legacyWorkerSecretMatch: false,
        adminSecretMatch: false,
      }),
      false,
    );
  });
});
