'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

const AUTH_CLAIM = 'https://api.openai.com/auth';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Payload inspection only: this does not verify a JWT signature or live access.
function jwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] ||
      parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) {
    fail('AUTH_INVALID_JWT');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    fail('AUTH_INVALID_JWT');
  }
  if (!isObject(payload)) fail('AUTH_INVALID_JWT');
  return payload;
}

function claimObject(payload) {
  return isObject(payload[AUTH_CLAIM]) ? payload[AUTH_CLAIM] : {};
}

/**
 * Parse an auth.json Buffer without network calls or signature verification.
 * The returned raw Buffer is a copy; no errors include input or token values.
 */
function parseAuth(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('AUTH_INVALID_INPUT');
  const raw = Buffer.from(buffer);
  let auth;
  try {
    auth = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    fail('AUTH_INVALID_JSON');
  }
  if (!isObject(auth)) fail('AUTH_INVALID_DOCUMENT');
  if (auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') {
    fail('AUTH_UNSUPPORTED_MODE');
  }
  if (!isObject(auth.tokens)) fail('AUTH_MISSING_TOKENS');
  const tokens = auth.tokens;
  for (const field of ['access_token', 'id_token', 'refresh_token']) {
    if (!nonemptyString(tokens[field])) fail('AUTH_MISSING_TOKEN');
  }

  const accessPayload = jwtPayload(tokens.access_token);
  const idPayload = jwtPayload(tokens.id_token);
  const accessClaim = claimObject(accessPayload);
  const idClaim = claimObject(idPayload);
  const plan = accessClaim.chatgpt_plan_type ?? idClaim.chatgpt_plan_type;
  if (plan !== 'plus' && plan !== 'pro') fail('AUTH_UNSUPPORTED_PLAN');

  if (tokens.account_id !== undefined && !nonemptyString(tokens.account_id)) {
    fail('AUTH_INVALID_ACCOUNT_ID');
  }
  const accountId = tokens.account_id ?? accessClaim.chatgpt_account_id ??
    idClaim.chatgpt_account_id;
  if (!nonemptyString(accountId)) fail('AUTH_MISSING_ACCOUNT_ID');

  let expiresAt = null;
  let expired = false;
  if (accessPayload.exp !== undefined) {
    const expiry = accessPayload.exp;
    if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
      fail('AUTH_INVALID_EXPIRY');
    }
    const expiryDate = new Date(expiry * 1000);
    if (!Number.isFinite(expiryDate.getTime())) fail('AUTH_INVALID_EXPIRY');
    expiresAt = expiryDate.toISOString();
    expired = expiryDate.getTime() <= Date.now();
  }

  return {
    raw,
    plan,
    identity: sha256(accountId).slice(0, 16),
    expiresAt,
    expired,
    hasRefreshToken: true,
    digest: sha256(raw),
  };
}

/** Synchronously read and parse; filesystem failures expose only a safe code. */
function readAuth(path) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch {
    fail('AUTH_READ_FAILED');
  }
  return parseAuth(raw);
}

/** Return true for equal nonempty identities; otherwise throw a safe error. */
function assertSameIdentity(a, b) {
  if (!a || !b || !nonemptyString(a.identity) ||
      !nonemptyString(b.identity) || a.identity !== b.identity) {
    fail('AUTH_IDENTITY_MISMATCH');
  }
  return true;
}

/** Return an allowlisted metadata view containing no raw bytes or digest. */
function publicAuth(parsed) {
  return {
    plan: parsed.plan,
    identity: parsed.identity,
    expiresAt: parsed.expiresAt,
    expired: parsed.expired,
    hasRefreshToken: parsed.hasRefreshToken,
  };
}

module.exports = { parseAuth, readAuth, assertSameIdentity, publicAuth };
