'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {inspectChatActivity} = require('./activity-guard.cjs');

function fixture(t, rows = [], schema) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-activity-test-'));
  const root = path.resolve(directory);
  t.after(() => {
    if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep)
        || !path.basename(root).startsWith('account-activity-test-')) throw new Error('UNSAFE_TEST_CLEANUP');
    fs.rmSync(root, {recursive: true, force: true});
  });
  const file = path.join(root, 'thread_history_1.sqlite');
  const db = new DatabaseSync(file);
  db.exec(schema ?? `CREATE TABLE thread_turns (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT,
    started_at INTEGER, completed_at INTEGER, rollout_ordinal INTEGER,
    PRIMARY KEY(thread_id, turn_id)
  )`);
  if (!schema) {
    const insert = db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(...row);
  }
  db.close();
  return {c: {authPath: path.join(root, 'auth.json')}, file, root};
}

const active = (thread, turn, started = 10, ordinal = 1) => [thread, turn, 'inProgress', started, null, ordinal];
const ended = (thread, turn, status = 'completed', started = 10, ordinal = 1) => [thread, turn, status, started, started + 1, ordinal];
const code = expected => error => error.code === expected && error.message === expected;

test('scheduling permits only the requesting thread and returns a private proof', t => {
  const f = fixture(t, [active('requester', 'request-turn'), ended('idle-thread', 'idle-turn')]);
  const result = inspectChatActivity(f.c, {phase: 'schedule', callerThreadId: 'requester'});
  assert.equal(result.callerThreadId, 'requester');
  assert.equal(result.callerTurnId, 'request-turn');
  assert.equal(result.activeOtherCount, 0);
  assert.equal(result.coverage, 'local-turn-projection');
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
});

test('another active chat or subagent blocks scheduling', t => {
  const f = fixture(t, [active('requester', 'request-turn'), active('another-thread', 'other-turn')]);
  assert.throws(() => inspectChatActivity(f.c, {phase: 'schedule', callerThreadId: 'requester'}), code('CHAT_IN_PROGRESS'));
});

test('without a requesting chat all threads must be idle', t => {
  const busy = fixture(t, [active('any-thread', 'any-turn')]);
  assert.throws(() => inspectChatActivity(busy.c, {phase: 'schedule'}), code('CHAT_IN_PROGRESS'));
  const idle = fixture(t, [ended('idle-thread', 'idle-turn')]);
  assert.equal(inspectChatActivity(idle.c, {phase: 'schedule'}).callerTurnId, null);
  assert.equal(inspectChatActivity(idle.c, {phase: 'close'}).activeOtherCount, 0);
});

test('older inProgress records do not override a newer completed turn', t => {
  const f = fixture(t, [active('old-thread', 'stale-turn', 10, 100), ended('old-thread', 'new-turn', 'completed', 20, 1)]);
  assert.equal(inspectChatActivity(f.c, {phase: 'schedule'}).activeOtherCount, 0);
});

test('rollout order resolves turns started in the same second', t => {
  const f = fixture(t, [ended('same-thread', 'early-turn', 'completed', 10, 1), active('same-thread', 'late-turn', 10, 2)]);
  assert.throws(() => inspectChatActivity(f.c, {phase: 'schedule'}), code('CHAT_IN_PROGRESS'));
});

test('close permits the normally completed requesting turn', t => {
  const f = fixture(t, [ended('requester', 'request-turn')]);
  const result = inspectChatActivity(f.c, {phase: 'close', callerThreadId: 'requester', expectedCallerTurnId: 'request-turn'});
  assert.equal(result.callerTurnId, 'request-turn');
});

test('close blocks while the requesting turn is still running', t => {
  const f = fixture(t, [active('requester', 'request-turn')]);
  assert.throws(() => inspectChatActivity(f.c, {phase: 'close', callerThreadId: 'requester', expectedCallerTurnId: 'request-turn'}), code('CALLER_TURN_IN_PROGRESS'));
});

test('a new requesting turn blocks a previously approved shutdown', t => {
  const f = fixture(t, [ended('requester', 'request-turn', 'completed', 10), ended('requester', 'new-turn', 'completed', 20)]);
  assert.throws(() => inspectChatActivity(f.c, {phase: 'close', callerThreadId: 'requester', expectedCallerTurnId: 'request-turn'}), code('CALLER_TURN_CHANGED'));
});

test('other activity that begins after scheduling is detected before closure', t => {
  const f = fixture(t, [ended('requester', 'request-turn')]);
  inspectChatActivity(f.c, {phase: 'schedule', callerThreadId: 'requester'});
  const db = new DatabaseSync(f.file);
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)').run(...active('new-thread', 'new-turn', 20));
  db.close();
  assert.throws(() => inspectChatActivity(f.c, {phase: 'close', callerThreadId: 'requester', expectedCallerTurnId: 'request-turn'}), code('CHAT_IN_PROGRESS'));
});

for (const status of ['interrupted', 'failed']) {
  test(`a requesting turn ending as ${status} cancels its pending restart`, t => {
    const f = fixture(t, [ended('requester', 'request-turn', status)]);
    assert.throws(() => inspectChatActivity(f.c, {phase: 'close', callerThreadId: 'requester', expectedCallerTurnId: 'request-turn'}), code('CALLER_TURN_NOT_COMPLETED'));
  });
}

test('terminated non-requesting threads do not block a switch', t => {
  const f = fixture(t, [ended('cancelled-thread', 'cancelled-turn', 'interrupted'), ended('failed-thread', 'failed-turn', 'failed')]);
  assert.equal(inspectChatActivity(f.c, {phase: 'schedule'}).activeOtherCount, 0);
});

test('unknown or missing statuses fail closed without reflecting database values', t => {
  for (const status of ['unrecognized-private-value', null]) {
    const f = fixture(t, [ended('private-thread-value', 'private-turn-value', status)]);
    assert.throws(() => inspectChatActivity(f.c, {phase: 'schedule'}), code('CHAT_ACTIVITY_UNVERIFIED'));
  }
});

test('missing or unsupported database schema fails closed', t => {
  const missing = fixture(t);
  fs.unlinkSync(missing.file);
  assert.throws(() => inspectChatActivity(missing.c, {phase: 'schedule'}), code('CHAT_ACTIVITY_UNVERIFIED'));
  assert.equal(fs.existsSync(missing.file), false);
  const wrong = fixture(t, [], 'CREATE TABLE thread_turns (thread_id TEXT, status TEXT)');
  assert.throws(() => inspectChatActivity(wrong.c, {phase: 'schedule'}), code('CHAT_ACTIVITY_UNVERIFIED'));
});

test('a malformed database exposes only a safe failure code', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'synthetic-private-invalid-database');
  assert.throws(() => inspectChatActivity(f.c, {phase: 'schedule'}), code('CHAT_ACTIVITY_UNVERIFIED'));
});

test('a missing caller or incomplete close proof fails closed', t => {
  const f = fixture(t, [ended('requester', 'request-turn')]);
  for (const options of [
    null,
    [],
    {phase: 'schedule', callerThreadId: 'missing-thread'},
    {phase: 'close', callerThreadId: 'requester'},
    {phase: 'close', expectedCallerTurnId: 'request-turn'},
    {phase: 'close', callerThreadId: ''},
    {phase: 'unrecognized'},
  ]) assert.throws(() => inspectChatActivity(f.c, options), code('CHAT_ACTIVITY_UNVERIFIED'));
});

test('the read-only guard preserves the database and reads no auth file', t => {
  const f = fixture(t, [ended('idle-thread', 'idle-turn')]);
  const before = fs.readFileSync(f.file);
  assert.equal(fs.existsSync(f.c.authPath), false);
  inspectChatActivity(f.c, {phase: 'schedule'});
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(f.c.authPath), false);
});
