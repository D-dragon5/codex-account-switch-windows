'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KNOWN_STATUSES = new Set(['inProgress', 'completed', 'interrupted', 'failed']);
const REQUIRED_COLUMNS = ['thread_id', 'turn_id', 'status', 'started_at', 'completed_at', 'rollout_ordinal'];

class ChatActivityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) { throw new ChatActivityError(code); }

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !value.includes('\0');
}

/**
 * Inspect this installation's persisted local turn projection. No conversation
 * content or credentials are read. Returned IDs belong only in a local job,
 * never in a public status view or diagnostic log.
 *
 * A fresh app-server cannot answer for threads loaded in the desktop process.
 * This reader deliberately uses the desktop's persisted turn projection and
 * refuses to act if its schema or status vocabulary cannot be verified.
 */
function inspectChatActivity(c, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('CHAT_ACTIVITY_UNVERIFIED');
  const {phase, callerThreadId = null, expectedCallerTurnId = null} = options;
  if (!c || typeof c.authPath !== 'string' || !path.isAbsolute(c.authPath)
      || !['schedule', 'close'].includes(phase)) fail('CHAT_ACTIVITY_UNVERIFIED');
  if (callerThreadId !== null && !validId(callerThreadId)) fail('CHAT_ACTIVITY_UNVERIFIED');
  if (expectedCallerTurnId !== null && !validId(expectedCallerTurnId)) fail('CHAT_ACTIVITY_UNVERIFIED');
  if (phase === 'close' && ((callerThreadId !== null && expectedCallerTurnId === null)
      || (callerThreadId === null && expectedCallerTurnId !== null))) fail('CHAT_ACTIVITY_UNVERIFIED');

  const file = path.join(path.dirname(c.authPath), 'thread_history_1.sqlite');
  let db;
  try {
    if (!fs.statSync(file).isFile()) fail('CHAT_ACTIVITY_UNVERIFIED');
    // Load on demand: an unsupported Node runtime must produce a safe failure,
    // not disable unrelated read-only commands when this module is imported.
    // Do not intercept process warnings or hide underlying runtime failures.
    const {DatabaseSync} = require('node:sqlite');
    db = new DatabaseSync(file, {readOnly: true});
    db.exec('PRAGMA query_only=ON');
    db.exec('PRAGMA busy_timeout=1000');
    const columns = new Set(db.prepare('PRAGMA table_info(thread_turns)').all().map(row => row.name));
    if (!REQUIRED_COLUMNS.every(column => columns.has(column))) fail('CHAT_ACTIVITY_UNVERIFIED');

    // Older turns can retain inProgress after an interrupted projection. Only
    // the latest turn of each thread represents its current persisted state.
    const latest = db.prepare(`WITH ranked AS (
      SELECT thread_id, turn_id, status, started_at, completed_at,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY started_at DESC, rollout_ordinal DESC, turn_id DESC
        ) AS position
      FROM thread_turns
    ) SELECT thread_id, turn_id, status, started_at, completed_at
      FROM ranked WHERE position=1`).all();

    for (const row of latest) {
      if (!validId(row.thread_id) || !validId(row.turn_id)
          || !KNOWN_STATUSES.has(row.status)) fail('CHAT_ACTIVITY_UNVERIFIED');
    }
    const caller = callerThreadId === null ? null : latest.find(row => row.thread_id === callerThreadId);
    if (callerThreadId !== null && !caller) fail('CHAT_ACTIVITY_UNVERIFIED');
    if (latest.some(row => row.thread_id !== callerThreadId && row.status === 'inProgress')) {
      fail('CHAT_IN_PROGRESS');
    }

    if (phase === 'close' && caller) {
      if (caller.turn_id !== expectedCallerTurnId) fail('CALLER_TURN_CHANGED');
      if (caller.status === 'inProgress') fail('CALLER_TURN_IN_PROGRESS');
      // An interrupted/failed requesting turn does not grant continuation of
      // its pending restart. Require its normal completion before shutdown.
      if (caller.status !== 'completed') {
        fail('CALLER_TURN_NOT_COMPLETED');
      }
    }

    return {callerThreadId, callerTurnId: caller?.turn_id ?? null,
      checkedAt: new Date().toISOString(), activeOtherCount: 0,
      coverage: 'local-turn-projection'};
  } catch (error) {
    if (error instanceof ChatActivityError) throw error;
    fail('CHAT_ACTIVITY_UNVERIFIED');
  } finally {
    if (db) {
      try { db.close(); } catch { fail('CHAT_ACTIVITY_UNVERIFIED'); }
    }
  }
}

module.exports = {inspectChatActivity};
