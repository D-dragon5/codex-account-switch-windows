'use strict';

// Windows integration test: actual scheduler, WMI worker, activity database and
// private-file ACLs; synthetic credentials and simulated desktop/network only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const PS = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const HELPER = path.resolve(__dirname, '../scripts/windows-session.ps1');
const nativeSpawnSync = childProcess.spawnSync;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let caseRoot = null;
let networkCalls = 0;

function within(file, directory = caseRoot) {
  assert.equal(typeof directory, 'string', 'FIXTURE_ROOT_REQUIRED');
  const full = path.resolve(file);
  const relative = path.relative(path.resolve(directory), full);
  assert.ok(relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'FIXTURE_BOUNDARY_VIOLATION');
  return full;
}

function validateCaseRoot(directory) {
  const full = path.resolve(directory);
  const testRoot = path.dirname(full);
  assert.ok(['success', 'blocked'].includes(path.basename(full)), 'UNKNOWN_FIXTURE_CASE');
  assert.equal(path.dirname(testRoot).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), 'FIXTURE_NOT_TEMPORARY');
  assert.match(path.basename(testRoot), /^codex-switch-pipeline-[a-zA-Z0-9]+$/, 'INVALID_FIXTURE_ROOT');
  return full;
}

function readJson(file) { return JSON.parse(fs.readFileSync(within(file), 'utf8')); }
function putJson(file, value) { fs.writeFileSync(within(file), JSON.stringify(value)); }
function event(name) { fs.appendFileSync(within(path.join(caseRoot, 'events.jsonl')), JSON.stringify({name}) + '\n'); }
function events() {
  const file = within(path.join(caseRoot, 'events.jsonl'));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).name) : [];
}

// Prohibit all Node network requests, even if an injected operation is omitted.
function forbidNetwork() { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); }
for (const moduleName of ['node:http', 'node:https']) {
  const module = require(moduleName);
  module.request = forbidNetwork; module.get = forbidNetwork;
}
for (const moduleName of ['node:net', 'node:tls']) {
  const module = require(moduleName);
  module.connect = forbidNetwork;
  if (module.createConnection) module.createConnection = forbidNetwork;
}
globalThis.fetch = forbidNetwork;

// Only the helper's private ACL operation is available to the actual engine.
// Desktop process operations are simulated below; launching uses a separately
// validated command that points at this test file, never the real CLI entry.
childProcess.spawn = () => { throw new Error('REAL_PROCESS_SPAWN_FORBIDDEN'); };
childProcess.spawnSync = (executable, argv, options) => {
  assert.equal(path.resolve(executable).toLowerCase(), path.resolve(PS).toLowerCase(), 'UNEXPECTED_EXECUTABLE');
  assert.equal(path.resolve(argv[argv.indexOf('-File') + 1]), HELPER, 'UNEXPECTED_HELPER');
  assert.equal(argv[argv.indexOf('-Action') + 1], 'SetPrivateAcl', 'REAL_DESKTOP_ACTION_FORBIDDEN');
  within(argv[argv.indexOf('-FilePath') + 1]);
  return nativeSpawnSync(executable, argv, options);
};

const engine = require('../scripts/switch-account.cjs');
const {readAuth, parseAuth} = require('../scripts/auth-utils.cjs');
const {inspectChatActivity} = require('../scripts/activity-guard.cjs');

function syntheticAuth(plan, revision = 1) {
  const claims = {
    'https://api.openai.com/auth': {chatgpt_plan_type: plan, chatgpt_account_id: 'synthetic-' + plan},
    exp: 4102444800,
    fixture_revision: revision
  };
  const jwt = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.synthetic';
  return Buffer.from(JSON.stringify({auth_mode: 'chatgpt', tokens: {
    access_token: jwt, id_token: jwt, refresh_token: 'synthetic-refresh-' + revision, account_id: 'synthetic-' + plan
  }}));
}

function database() {
  const {DatabaseSync} = require('node:sqlite');
  return new DatabaseSync(within(path.join(caseRoot, 'home', 'thread_history_1.sqlite')));
}

function setupActivity() {
  const db = database();
  try {
    db.exec(`CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, completed_at INTEGER, rollout_ordinal INTEGER NOT NULL
    )`);
    db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)')
      .run('synthetic-caller', 'synthetic-requesting-turn', 'inProgress', 1, null, 1);
  } finally { db.close(); }
}

function finishCallerAndOptionallyStartChat(blocked) {
  const db = database();
  try {
    db.prepare('UPDATE thread_turns SET status=?, completed_at=? WHERE thread_id=?')
      .run('completed', 2, 'synthetic-caller');
    if (blocked) db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)')
      .run('synthetic-other-chat', 'synthetic-new-turn', 'inProgress', 3, null, 1);
  } finally { db.close(); }
  event(blocked ? 'new-chat-started-after-scheduling' : 'requesting-turn-completed');
}

function loadConfig(directory) {
  caseRoot = validateCaseRoot(directory);
  const file = within(path.join(caseRoot, 'config.json'));
  const c = engine.config(file, {CODEX_HOME: path.join(caseRoot, 'home'), APPDATA: path.join(caseRoot, 'appdata')});
  for (const key of ['authPath', 'vaultRoot', 'stateRoot', 'clashConfigRoot']) within(c[key]);
  assert.equal(c.authPath, path.join(caseRoot, 'home', 'auth.json'));
  assert.equal(c.stateRoot, path.join(caseRoot, 'state'));
  assert.equal(c.vaultRoot, path.join(caseRoot, 'vault'));
  assert.equal(c.nodePath.toLowerCase(), process.execPath.toLowerCase());
  assert.equal(c.launchDelaySeconds, 3);
  assert.equal(c.closeGraceSeconds, 5);
  assert.deepEqual(c.accounts, {pro: {credentialSources: []}, plus: {credentialSources: []}});
  return c;
}

function operations(c, isWorker) {
  function privateWrite(file, bytes) {
    within(file);
    assert.ok([c.authPath, path.join(c.vaultRoot, 'pro.json'), path.join(c.vaultRoot, 'plus.json'),
      path.join(c.stateRoot, 'rollback.json')].includes(path.resolve(file)), 'UNEXPECTED_CREDENTIAL_DESTINATION');
    parseAuth(Buffer.from(bytes)); // Require every credential write to stay synthetic and well formed.
    assert.ok(Buffer.from(bytes).includes(Buffer.from('synthetic-')), 'NON_SYNTHETIC_CREDENTIAL_WRITE');
    event('private-credential-write');
    engine.privateWrite(file, bytes);
  }
  return {
    delay: pause,
    privateWrite,
    inspectChatActivity(config, options) {
      assert.equal(config, c);
      assert.equal(options.callerThreadId, 'synthetic-caller');
      if (options.phase === 'close') assert.equal(options.expectedCallerTurnId, 'synthetic-requesting-turn');
      event('real-activity-check-' + options.phase);
      return inspectChatActivity(config, options);
    },
    verifyAccountEgress: async () => ({net: {public: {readOnly: true}, runtime: {'mixed-port': 17897}},
      countries: [{host: 'chatgpt.com', country: 'US'}, {host: 'api.openai.com', country: 'US'}],
      proxyUrl: 'http://127.0.0.1:17897'}),
    onlineAccount: async config => {
      assert.equal(isWorker, true); assert.equal(config, c);
      assert.equal(readAuth(within(c.authPath)).plan, 'plus');
      event('simulated-online-authentication');
      privateWrite(c.authPath, syntheticAuth('plus', 2));
      return {authenticated: true, plan: 'plus'};
    },
    powershell(action, args = {}) {
      if (action === 'Discover') {
        assert.equal(isWorker, false);
        event('simulated-desktop-discovery');
        return {roots: [{pid: 90001, path: __filename, createdAt: new Date().toISOString()}],
          processes: [], standaloneCli: [], cliPaths: [{exists: true, path: process.execPath}]};
      }
      if (action === 'LaunchWorker') {
        assert.equal(isWorker, false);
        within(args.JobPath, c.stateRoot);
        assert.equal(path.resolve(args.CodexHome), path.dirname(c.authPath));
        event('real-wmi-launch-requested');
        const result = nativeSpawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', HELPER, '-Action', 'LaunchWorker', '-NodePath', process.execPath,
          '-WorkerPath', __filename, '-JobPath', args.JobPath, '-CodexHome', args.CodexHome],
        {encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024});
        let output;
        try { output = JSON.parse((result.stdout || '').replace(/^\uFEFF/, '').trim()); }
        catch { throw new Error('WMI_LAUNCH_RESULT_INVALID'); }
        assert.equal(result.status, 0, 'WMI_LAUNCH_FAILED');
        assert.equal(output.ok, true, 'WMI_LAUNCH_FAILED');
        assert.equal(output.jobIsolated, true, 'WMI_WORKER_NOT_ISOLATED');
        event('real-wmi-launch-confirmed');
        return output;
      }
      assert.equal(isWorker, true, 'UNEXPECTED_PARENT_HELPER_ACTION');
      if (action === 'StopDesktop') {
        within(args.ManifestPath, c.stateRoot);
        assert.equal(args.CloseGraceSeconds, 5, 'CLOSE_GRACE_NOT_FIVE_SECONDS');
        assert.equal(args.PreserveProcessIds, process.pid);
        event('simulated-desktop-close');
        privateWrite(c.authPath, syntheticAuth('pro', 2));
        return {ok: true, desktopClosed: true};
      }
      if (action === 'StartDesktop') {
        assert.equal(args.DesktopPath, __filename, 'UNEXPECTED_DESKTOP_PATH');
        assert.equal(args.ProxyUrl, 'http://127.0.0.1:17897');
        event('simulated-desktop-restart');
        return {ok: true, started: true};
      }
      if (action === 'DesktopState') return {ok: true, desktopRunning: false};
      throw new Error('UNEXPECTED_HELPER_ACTION');
    }
  };
}

async function worker(jobPath) {
  const c = loadConfig(path.dirname(path.dirname(path.resolve(jobPath))));
  within(jobPath, c.stateRoot);
  assert.equal(path.resolve(process.env.CODEX_HOME), path.dirname(c.authPath), 'WORKER_HOME_NOT_PRESERVED');
  event('worker-started-with-fixture-home');
  let timer = setTimeout(() => process.exit(3), 35000);
  try {
    try {
      await engine.worker(c, jobPath, operations(c, true));
      putJson(path.join(caseRoot, 'worker-done.json'), {returned: true, networkUsed: networkCalls !== 0});
    } catch (error) {
      putJson(path.join(caseRoot, 'worker-done.json'), {returned: false, error: engine.safeError(error), networkUsed: networkCalls !== 0});
    }
  } finally { clearTimeout(timer); timer = null; }
}

async function runCase(directory, blocked) {
  caseRoot = validateCaseRoot(directory);
  fs.mkdirSync(caseRoot);
  for (const folder of ['home', 'vault', 'state']) fs.mkdirSync(path.join(caseRoot, folder));
  const rawConfig = {authPath: path.join(caseRoot, 'home', 'auth.json'), vaultRoot: path.join(caseRoot, 'vault'),
    stateRoot: path.join(caseRoot, 'state'), clashConfigRoot: path.join(caseRoot, 'unused-clash'),
    nodePath: process.execPath, launchDelaySeconds: 3, closeGraceSeconds: 5,
    accounts: {pro: {credentialSources: []}, plus: {credentialSources: []}}};
  putJson(path.join(caseRoot, 'config.json'), rawConfig);
  const c = loadConfig(caseRoot);
  const source = syntheticAuth('pro');
  fs.writeFileSync(within(c.authPath), source);
  fs.writeFileSync(within(path.join(c.vaultRoot, 'pro.json')), source);
  fs.writeFileSync(within(path.join(c.vaultRoot, 'plus.json')), syntheticAuth('plus'));
  setupActivity();
  event('schedule-started');
  const startedAt = Date.now();
  const scheduled = await engine.schedule(c, 'plus', operations(c, false));
  assert.equal(scheduled.scheduled, true);
  assert.equal(scheduled.workerReady, true);
  assert.equal(scheduled.workerJobIsolated, true);
  assert.equal(scheduled.delaySeconds, 3);
  assert.equal(scheduled.chatActivityChecked, true);
  event('schedule-returned');
  finishCallerAndOptionallyStartChat(blocked);

  let completed;
  for (let attempt = 0; attempt < 350; attempt++) {
    const file = path.join(caseRoot, 'worker-done.json');
    if (fs.existsSync(file)) {
      try { completed = readJson(file); break; } catch { }
    }
    await pause(100);
  }
  assert.ok(completed, 'WORKER_COMPLETION_TIMEOUT');
  assert.equal(completed.networkUsed, false);
  assert.equal(networkCalls, 0);
  const jobs = fs.readdirSync(c.stateRoot).filter(name => /^job-[a-f0-9-]+\.json$/.test(name));
  assert.equal(jobs.length, 1);
  const jobPath = path.join(c.stateRoot, jobs[0]);
  const job = readJson(jobPath);
  for (const suffix of ['.ready.json', '.armed.json', '.armed-ack.json']) {
    const signal = readJson(jobPath + suffix);
    assert.equal(signal.pid, scheduled.workerPid);
    assert.equal(signal.jobPath, jobPath);
    assert.equal(signal.authPath, c.authPath);
  }
  assert.ok(job.completedAt);
  assert.equal(job.activityContext.callerThreadId, 'synthetic-caller');
  assert.equal(job.activityContext.callerTurnId, 'synthetic-requesting-turn');
  assert.equal(fs.existsSync(path.join(c.stateRoot, 'switch.lock')), false);
  const status = readJson(path.join(c.stateRoot, 'status.json'));
  const history = events();
  assert.ok(history.includes('real-activity-check-schedule') && history.includes('real-activity-check-close'));
  assert.ok(Date.now() - startedAt >= 3000, 'THREE_SECOND_GRACE_SKIPPED');

  if (blocked) {
    assert.equal(completed.returned, false);
    assert.equal(completed.error, 'CHAT_IN_PROGRESS');
    assert.equal(status.state, 'failed');
    assert.equal(status.error, 'CHAT_IN_PROGRESS');
    assert.equal(status.desktopShutdownAttempted, false);
    assert.equal(history.includes('simulated-desktop-close'), false);
    assert.equal(history.includes('private-credential-write'), false);
    assert.equal(fs.existsSync(path.join(c.stateRoot, 'rollback.json')), false);
    assert.deepEqual(fs.readFileSync(c.authPath), source);
    assert.deepEqual(fs.readFileSync(path.join(c.vaultRoot, 'pro.json')), source);
    assert.deepEqual(fs.readFileSync(path.join(c.vaultRoot, 'plus.json')), syntheticAuth('plus'));
  } else {
    assert.equal(completed.returned, true);
    assert.equal(status.state, 'restarted_pending_desktop_confirmation');
    assert.equal(status.onlineAuthVerified, true);
    assert.equal(status.desktopIdentityVerified, false);
    assert.equal(status.sourceCredentialSaved, true);
    assert.equal(status.targetCredentialSaved, true);
    assert.equal(status.tokenFieldsChangedDuringValidation, true);
    assert.equal(status.chatActivityCheckedBeforeClose, true);
    assert.equal(status.networkChanged, false);
    assert.deepEqual(fs.readFileSync(c.authPath), syntheticAuth('plus', 2));
    assert.deepEqual(fs.readFileSync(path.join(c.vaultRoot, 'plus.json')), syntheticAuth('plus', 2));
    assert.deepEqual(fs.readFileSync(path.join(c.vaultRoot, 'pro.json')), syntheticAuth('pro', 2));
    assert.deepEqual(fs.readFileSync(path.join(c.stateRoot, 'rollback.json')), syntheticAuth('pro', 2));
    const expected = ['schedule-returned', 'requesting-turn-completed', 'real-activity-check-close',
      'simulated-desktop-close', 'simulated-online-authentication', 'simulated-desktop-restart'];
    let last = -1;
    for (const name of expected) {
      const position = history.indexOf(name, last + 1);
      assert.ok(position > last, 'PIPELINE_EVENT_ORDER_INVALID'); last = position;
    }
  }
}

async function controller() {
  assert.equal(process.platform, 'win32', 'WINDOWS_REQUIRED');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-pipeline-'));
  const originalCaller = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = 'synthetic-caller';
  let finished = false;
  try {
    await runCase(path.join(root, 'success'), false);
    await runCase(path.join(root, 'blocked'), true);
    finished = true;
    console.log(JSON.stringify({ok: true, tests: ['real-wmi-complete-synthetic-pipeline', 'new-chat-after-scheduling-blocks-shutdown'],
      count: 2, realDesktopTouched: false, liveCredentialsRead: false, networkUsed: false}));
  } finally {
    if (originalCaller === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = originalCaller;
    // A failed run may still have its self-limited worker in progress. Preserve
    // that temporary fixture instead of deleting files beneath a running job.
    if (finished) {
      validateCaseRoot(path.join(root, 'success'));
      fs.rmSync(root, {recursive: true, force: true});
    }
  }
}

(process.argv[2] === 'worker' ? worker(process.argv[3]) : controller()).catch(error => {
  console.error(JSON.stringify({ok: false, error: engine.safeError(error)}));
  process.exitCode = 1;
});
