'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { parseAuth, readAuth, assertSameIdentity, publicAuth } = require('./auth-utils.cjs');

const AUTH_CLAIM = 'https://api.openai.com/auth';
const SYNTHETIC_SECRET = 'synthetic-secret-do-not-print';

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.synthetic`;
}

function makeAuth({ plan = 'pro', accountId = 'synthetic-account-a',
  exp = Math.floor(Date.now() / 1000) + 3600, authMode = 'chatgpt',
  accessClaim, idClaim, omitAccountId = false } = {}) {
  const accessPayload = { [AUTH_CLAIM]: accessClaim ?? {
    chatgpt_plan_type: plan, chatgpt_account_id: accountId,
  } };
  if (exp !== null) accessPayload.exp = exp;
  const document = {
    tokens: {
      access_token: jwt(accessPayload),
      id_token: jwt({ [AUTH_CLAIM]: idClaim ?? {
        chatgpt_plan_type: plan, chatgpt_account_id: accountId,
      } }),
      refresh_token: SYNTHETIC_SECRET,
    },
  };
  if (authMode !== undefined) document.auth_mode = authMode;
  if (!omitAccountId) document.tokens.account_id = accountId;
  return document;
}

function encode(document) {
  return Buffer.from(JSON.stringify(document), 'utf8');
}

function throwsCode(callback, code, secrets = [SYNTHETIC_SECRET]) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    for (const secret of secrets) {
      assert.ok(!String(error.stack).includes(secret), 'errors must not expose synthetic secrets');
    }
    return true;
  });
}

test('parses pro and plus; copies raw bytes and hashes exact bytes', () => {
  for (const plan of ['plus', 'pro']) {
    const raw = encode(makeAuth({ plan }));
    const result = parseAuth(raw);
    assert.equal(result.plan, plan);
    assert.deepEqual(result.raw, raw);
    assert.notStrictEqual(result.raw, raw);
    assert.equal(result.digest, createHash('sha256').update(raw).digest('hex'));
    assert.equal(result.identity,
      createHash('sha256').update('synthetic-account-a').digest('hex').slice(0, 16));
    assert.equal(result.expired, false);
    assert.equal(result.hasRefreshToken, true);
    assert.match(result.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('allows absent auth_mode when all required tokens exist', () => {
  const document = makeAuth();
  delete document.auth_mode;
  assert.equal(parseAuth(encode(document)).plan, 'pro');
});

test('falls back to id_token auth claims and claim account id', () => {
  const raw = encode(makeAuth({ accessClaim: {}, omitAccountId: true,
    idClaim: { chatgpt_plan_type: 'plus', chatgpt_account_id: 'synthetic-fallback' } }));
  const parsed = parseAuth(raw);
  assert.equal(parsed.plan, 'plus');
  assert.equal(parsed.identity,
    createHash('sha256').update('synthetic-fallback').digest('hex').slice(0, 16));
});

test('access claim takes precedence and explicit account_id supplies identity', () => {
  const parsed = parseAuth(encode(makeAuth({ accountId: 'synthetic-explicit',
    idClaim: { chatgpt_plan_type: 'plus', chatgpt_account_id: 'synthetic-id' } })));
  assert.equal(parsed.plan, 'pro');
  assert.equal(parsed.identity,
    createHash('sha256').update('synthetic-explicit').digest('hex').slice(0, 16));
});

test('accepts expired access token with refresh token, and absent expiry', () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const expired = parseAuth(encode(makeAuth({ exp: past })));
  assert.equal(expired.expired, true);
  assert.equal(expired.expiresAt, new Date(past * 1000).toISOString());
  assert.equal(expired.hasRefreshToken, true);
  const noExpiry = parseAuth(encode(makeAuth({ exp: null })));
  assert.equal(noExpiry.expiresAt, null);
  assert.equal(noExpiry.expired, false);
});

test('rejects missing required tokens without exposing other token values', () => {
  for (const field of ['access_token', 'id_token', 'refresh_token']) {
    const document = makeAuth();
    delete document.tokens[field];
    throwsCode(() => parseAuth(encode(document)), 'AUTH_MISSING_TOKEN');
  }
  const document = makeAuth();
  document.tokens.refresh_token = '   ';
  throwsCode(() => parseAuth(encode(document)), 'AUTH_MISSING_TOKEN');
});

test('rejects unknown plans and auth modes', () => {
  for (const plan of ['free', 'team', 'unknown', '', null]) {
    throwsCode(() => parseAuth(encode(makeAuth({ plan }))), 'AUTH_UNSUPPORTED_PLAN');
  }
  throwsCode(() => parseAuth(encode(makeAuth({ authMode: 'apikey' }))), 'AUTH_UNSUPPORTED_MODE');
});

test('rejects malformed JSON and JWT with safe errors', () => {
  throwsCode(() => parseAuth(Buffer.from(`{"secret":"${SYNTHETIC_SECRET}"`)), 'AUTH_INVALID_JSON');
  const document = makeAuth();
  document.tokens.access_token = SYNTHETIC_SECRET;
  throwsCode(() => parseAuth(encode(document)), 'AUTH_INVALID_JWT');
  document.tokens.access_token = 'header.eyJzZWNyZXQiOiJzeW50aGV0aWMtc2VjcmV0LWRvLW5vdC1wcmludCI.invalid';
  throwsCode(() => parseAuth(encode(document)), 'AUTH_INVALID_JWT');
});

test('rejects invalid structures, account ids, and expiry', () => {
  throwsCode(() => parseAuth('not-a-buffer'), 'AUTH_INVALID_INPUT');
  throwsCode(() => parseAuth(Buffer.from('[]')), 'AUTH_INVALID_DOCUMENT');
  throwsCode(() => parseAuth(Buffer.from('{}')), 'AUTH_MISSING_TOKENS');
  const missingAccount = makeAuth({ accessClaim: {}, idClaim: { chatgpt_plan_type: 'pro' },
    omitAccountId: true });
  throwsCode(() => parseAuth(encode(missingAccount)), 'AUTH_MISSING_ACCOUNT_ID');
  const invalidAccount = makeAuth();
  invalidAccount.tokens.account_id = 12;
  throwsCode(() => parseAuth(encode(invalidAccount)), 'AUTH_INVALID_ACCOUNT_ID');
  throwsCode(() => parseAuth(encode(makeAuth({ exp: 'tomorrow' }))), 'AUTH_INVALID_EXPIRY');
});

test('identity guard accepts the same account and rejects other or absent identity', () => {
  const a = parseAuth(encode(makeAuth()));
  const same = parseAuth(encode(makeAuth({ plan: 'plus' })));
  const other = parseAuth(encode(makeAuth({ accountId: 'synthetic-account-b' })));
  assert.equal(assertSameIdentity(a, same), true);
  throwsCode(() => assertSameIdentity(a, other), 'AUTH_IDENTITY_MISMATCH');
  throwsCode(() => assertSameIdentity({}, {}), 'AUTH_IDENTITY_MISMATCH');
});

test('public metadata is explicitly allowlisted and excludes raw/digest', () => {
  const parsed = parseAuth(encode(makeAuth()));
  const safe = publicAuth(parsed);
  assert.deepEqual(Object.keys(safe), ['plan', 'identity', 'expiresAt', 'expired', 'hasRefreshToken']);
  assert.ok(!JSON.stringify(safe).includes(SYNTHETIC_SECRET));
  assert.ok(!Object.hasOwn(safe, 'raw'));
  assert.ok(!Object.hasOwn(safe, 'digest'));
});

test('read failures expose a stable safe code without the supplied path', () => {
  // A NUL is rejected by fs before any filesystem read; no real auth file is accessed.
  const invalidPath = `synthetic-${SYNTHETIC_SECRET}\0`;
  throwsCode(() => readAuth(invalidPath), 'AUTH_READ_FAILED', [SYNTHETIC_SECRET, invalidPath]);
});
