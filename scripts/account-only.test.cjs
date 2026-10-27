'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

// Every account and route below is synthetic. An incomplete injection must fail
// before it can start a desktop, call a real API, or contact the live controller.
const forbidden = [];
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  childProcess[method] = () => { forbidden.push('process:' + method); throw new Error('ACTUAL_PROCESS_FORBIDDEN'); };
}
for (const module of [http, https]) {
  module.request = () => { forbidden.push('network'); throw new Error('ACTUAL_NETWORK_FORBIDDEN'); };
  module.get = () => { forbidden.push('network'); throw new Error('ACTUAL_NETWORK_FORBIDDEN'); };
}

const engine = require('./switch-account.cjs');
const {parseAuth, readAuth} = require('./auth-utils.cjs');
const CLAIM = 'https://api.openai.com/auth';
function jwt(payload) {
  return Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.'
    + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.synthetic';
}
function auth(plan, accountId, revision = 1) {
  const claims = {[CLAIM]: {chatgpt_plan_type: plan, chatgpt_account_id: accountId}, exp: 4102444800};
  return Buffer.from(JSON.stringify({auth_mode: 'chatgpt', tokens: {
    access_token: jwt(claims), id_token: jwt(claims), account_id: accountId,
    refresh_token: 'synthetic-refresh-' + revision
  }, fixture_revision: revision}) + '\n');
}
function coded(code) { const error = new Error(code); error.code = code; return error; }
function errorCode(code) { return error => error.code === code || error.message === code; }
function getJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
const proof = () => [
  {host: 'chatgpt.com', country: 'US'},
  {host: 'api.openai.com', country: 'US'}
];

function fixture(t, settings = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-only-test-'));
  const fixtureRoot = path.resolve(directory);
  t.after(() => {
    if (!fixtureRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)
        || !path.basename(fixtureRoot).startsWith('codex-account-only-test-')) throw new Error('UNSAFE_FIXTURE_CLEANUP');
    fs.rmSync(fixtureRoot, {recursive: true, force: true});
  });
  const c = {authPath: path.join(directory, 'home', 'auth.json'), vaultRoot: path.join(directory, 'vault'),
    stateRoot: path.join(directory, 'state'), clashConfigRoot: path.join(directory, 'not-a-live-controller'),
    launchDelaySeconds: 0, closeGraceSeconds: 5, nodePath: path.join(directory, 'not-an-executable.exe'),
    accounts: {pro: {node: 'legacy-pinned-node-that-is-not-present', country: 'US'},
      plus: {node: 'another-absent-pinned-node', country: 'JP'}},
    traceUrls: ['https://chatgpt.com/cdn-cgi/trace', 'https://api.openai.com/cdn-cgi/trace']};
  for (const folder of [path.dirname(c.authPath), c.vaultRoot, c.stateRoot]) fs.mkdirSync(folder);
  const source = auth('pro', 'fixture-pro');
  const refreshedSource = auth('pro', 'fixture-pro', 2);
  const mark=buffer=>settings.bomTarget?Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),buffer]):buffer;
  const target = mark(auth('plus', 'fixture-plus'));
  const refreshedTarget = mark(auth('plus', 'fixture-plus', 2));
  fs.writeFileSync(c.authPath, source);
  fs.writeFileSync(path.join(c.vaultRoot, 'pro.json'), source);
  if (!settings.missingTarget) fs.writeFileSync(path.join(c.vaultRoot, 'plus.json'), target);
  const configuredSourcePath = path.join(directory, 'secondary-profile', 'auth.json');
  if (settings.configuredSource) {
    fs.mkdirSync(path.dirname(configuredSourcePath), {recursive: true});
    c.accounts.plus.credentialSources = [configuredSourcePath];
    fs.writeFileSync(configuredSourcePath, settings.configuredSourcePlan === 'pro'
      ? auth('pro', 'fixture-wrong-plan-source') : target);
  }
  const actions = [], writes = [], routes = [], countries = [], activities=[];
  const selected = {AI: 'independent-us-node', Manual: 'independent-other-us-node', GLOBAL: 'leave-global-alone'};
  const selectedBefore = {...selected};
  let closed = false, targetInstalled = false, onlineCompleted = false, verifyCount = 0;
  const net = {runtime: {mode: 'rule', 'mixed-port': 17897}, groups: ['AI', 'Manual'],
    proxies: {}, public: {mode: 'rule', mixedPort: 17897, readOnly: true},
    client: {request: async (route, method = 'GET') => {
      routes.push({route, method});
      if (method !== 'GET') throw coded('TEST_VPN_WRITE_FORBIDDEN');
      return {};
    }}};
  const write = (file, bytes) => {
    const destination = path.resolve(file);
    if (!destination.startsWith(fixtureRoot + path.sep)) throw new Error('NON_FIXTURE_WRITE_FORBIDDEN');
    if (settings.rollbackWriteFailure && targetInstalled && destination === path.resolve(c.authPath)
        && parseAuth(Buffer.from(bytes)).plan === 'pro') throw coded('SYNTHETIC_CREDENTIAL_RESTORE_FAILED');
    if (destination === path.resolve(c.authPath) && parseAuth(Buffer.from(bytes)).plan === 'plus') targetInstalled = true;
    writes.push({file: path.relative(fixtureRoot, file), plan: (() => { try { return parseAuth(Buffer.from(bytes)).plan; } catch { return null; } })()});
    fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes);
  };
  const ops = {
    delay: async () => {},
    inspectChatActivity: (config,context) => {
      activities.push(context);
      if(settings.busySchedule && context.phase==='schedule' || settings.busyClose && context.phase==='close')throw coded('CHAT_IN_PROGRESS');
      return {callerThreadId:'fixture-caller',callerTurnId:'fixture-turn',activeOtherCount:0,coverage:'local-turn-projection'};
    },
    verifyAccountEgress: async () => {
      verifyCount++;
      countries.push('US');
      if (settings.beforeCloseNonUS && !closed || settings.afterCloseNonUS && closed
          || settings.afterInstallNonUS && targetInstalled || settings.afterOnlineNonUS && onlineCompleted) {
        throw coded('EGRESS_COUNTRY_MISMATCH');
      }
      return {net, countries: proof(), proxyUrl: 'http://127.0.0.1:17897'};
    },
    powershell: (action, parameters) => {
      actions.push({action, parameters});
      if (action === 'Discover') return {roots: [{pid: 60001, path: path.join(directory, 'fixture-desktop.exe')}],
        standaloneCli: [], cliPaths: [{exists: true, path: path.join(directory, 'fixture-cli.exe')}]};
      if (action === 'StopDesktop') {
        if (settings.stopFailsBeforeClose) {
          const error=coded('DESKTOP_STOP_FAILED');error.shutdownAttempted=false;throw error;
        }
        closed = true;
        if (settings.refreshSourceOnClose !== false) fs.writeFileSync(c.authPath, refreshedSource);
        if (settings.stopFailsAfterClose) {
          const error=coded('DESKTOP_STOP_FAILED');error.shutdownAttempted=true;throw error;
        }
        return {ok: true};
      }
      if (action === 'DesktopState') return {ok: true, desktopRunning: !!settings.desktopStillRunning};
      if (action === 'StartDesktop') return {ok: true};
      if (action === 'LaunchWorker') {
        if (!settings.workerNotReady) fs.writeFileSync(parameters.JobPath+'.ready.json', JSON.stringify({
          pid:process.pid,jobPath:parameters.JobPath,authPath:c.authPath
        }));
        if (!settings.workerNotReady && !settings.workerNoArmAck) fs.writeFileSync(parameters.JobPath+'.armed-ack.json', JSON.stringify({
          pid:process.pid,jobPath:parameters.JobPath,authPath:c.authPath
        }));
        return {pid:process.pid,jobIsolated:!settings.workerNotIsolated};
      }
      throw new Error('UNEXPECTED_APPLICATION_HELPER');
    },
    privateWrite: write,
    saveCurrent: (config, parsed) => engine.saveCurrent(config, parsed, write),
    onlineAccount: async (config, cliPath, proxyUrl) => {
      assert.equal(readAuth(config.authPath).plan, 'plus');
      assert.equal(cliPath, path.join(directory, 'fixture-cli.exe'));
      assert.equal(proxyUrl, 'http://127.0.0.1:17897');
      if (settings.onlineFailure) throw coded('ONLINE_AUTH_REJECTED');
      fs.writeFileSync(config.authPath, refreshedTarget); onlineCompleted = true;
      return {authenticated: true, plan: 'plus'};
    }
  };
  const parsedSource = parseAuth(source), parsedTarget = parseAuth(target);
  const job = {schema: 4, launchMode:'wmi-breakaway-v1', authPath:c.authPath,
    activityContext:{callerThreadId:'fixture-caller',callerTurnId:'fixture-turn'},
    switchMode: 'account-only', requiredCountry: 'US', createdAt: new Date().toISOString(),
    target: 'plus', sourceIdentity: parsedSource.identity, sourceDigest: parsedSource.digest,
    targetDigest: parsedTarget.digest, cliPath: path.join(directory, 'fixture-cli.exe'),
    desktopPath: path.join(directory, 'fixture-desktop.exe'), roots: [{pid: 60001, path: path.join(directory, 'fixture-desktop.exe')}]};
  const jobPath = path.join(c.stateRoot, 'job-12345678-abcd-abcd-abcd-123456789012.json');
  fs.writeFileSync(jobPath, JSON.stringify(job));
  fs.writeFileSync(jobPath+'.armed.json', JSON.stringify({pid:process.pid,jobPath,authPath:c.authPath}));
  return {c, directory, source, refreshedSource, target, refreshedTarget, configuredSourcePath, job, jobPath, ops, actions, writes, activities,
    selected, selectedBefore, routes, countries, get verifyCount() {return verifyCount;}};
}

test('successful account-only worker backs up fresh source, accepts target refresh, and never writes routes', async t => {
  const f = fixture(t);
  await engine.worker(f.c, f.jobPath, f.ops);
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.refreshedTarget);
  assert.deepEqual(fs.readFileSync(path.join(f.c.vaultRoot, 'pro.json')), f.refreshedSource);
  assert.deepEqual(fs.readFileSync(path.join(f.c.vaultRoot, 'plus.json')), f.refreshedTarget);
  assert.deepEqual(fs.readFileSync(path.join(f.c.stateRoot, 'rollback.json')), f.refreshedSource);
  assert.deepEqual(f.actions.map(x => x.action), ['StopDesktop', 'StartDesktop']);
  const launch = f.actions.find(x => x.action === 'StartDesktop').parameters;
  assert.equal(launch.DesktopPath, f.job.desktopPath);
  assert.equal(launch.ProxyUrl, 'http://127.0.0.1:17897');
  assert.equal(f.actions.find(x=>x.action==='StopDesktop').parameters.CloseGraceSeconds,5);
  assert.equal(getJson(path.join(f.c.stateRoot, 'status.json')).state, 'restarted_pending_desktop_confirmation');
  assert.ok(getJson(f.jobPath).completedAt);
  assert.equal(fs.existsSync(path.join(f.c.stateRoot, 'switch.lock')), false);
  assert.equal(f.routes.filter(x => x.method !== 'GET').length, 0);
  assert.deepEqual(f.selected, f.selectedBefore);
  assert.ok(f.verifyCount >= 3, 'US must be rechecked at the sensitive login/restart stages');
});

test('valid BOM credentials survive backend validation and token-change reporting', async t => {
  const f=fixture(t,{bomTarget:true});
  await engine.worker(f.c,f.jobPath,f.ops);
  const state=getJson(path.join(f.c.stateRoot,'status.json'));
  assert.equal(state.state,'restarted_pending_desktop_confirmation');
  assert.equal(state.tokenFieldsChangedDuringValidation,true);
  assert.deepEqual(fs.readFileSync(f.c.authPath),f.refreshedTarget);
});

test('non-US egress fails before closing the desktop or altering credentials', async t => {
  const f = fixture(t, {beforeCloseNonUS: true});
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('EGRESS_COUNTRY_MISMATCH'));
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.source);
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.selected, f.selectedBefore);
});

test('egress loss after closure stops before installing the target and leaves the fresh source intact', async t => {
  const f = fixture(t, {afterCloseNonUS: true});
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('EGRESS_COUNTRY_MISMATCH'));
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.refreshedSource);
  assert.equal(f.writes.some(x => x.file === path.relative(f.directory, f.c.authPath) && x.plan === 'plus'), false);
  assert.deepEqual(f.actions.map(x => x.action), ['StopDesktop', 'DesktopState']);
  assert.equal(f.routes.filter(x => x.method !== 'GET').length, 0);
});

test('egress loss just before login restores source credentials without changing VPN or restarting over non-US', async t => {
  const f = fixture(t, {afterInstallNonUS: true});
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('EGRESS_COUNTRY_MISMATCH'));
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.refreshedSource);
  assert.equal(f.routes.filter(x => x.method !== 'GET').length, 0);
  assert.deepEqual(f.selected, f.selectedBefore);
  assert.deepEqual(f.actions.map(x => x.action), ['StopDesktop', 'DesktopState']);
});

test('online authentication failure rolls back only credentials and may reopen the original over verified US', async t => {
  const f = fixture(t, {onlineFailure: true});
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('ONLINE_AUTH_REJECTED'));
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.refreshedSource);
  const status = getJson(path.join(f.c.stateRoot, 'status.json'));
  assert.equal(status.originalDesktopRestarted, true);
  assert.deepEqual(f.actions.map(x => x.action), ['StopDesktop', 'DesktopState', 'StartDesktop']);
  assert.deepEqual(f.selected, f.selectedBefore);
  assert.equal(f.routes.filter(x => x.method !== 'GET').length, 0);
});

test('failed credential rollback keeps the desktop closed and reports its backup without exposing tokens', async t => {
  const f = fixture(t, {onlineFailure: true, rollbackWriteFailure: true});
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('ONLINE_AUTH_REJECTED'));
  const status = getJson(path.join(f.c.stateRoot, 'status.json'));
  assert.equal(status.credentialRollbackAttempted, true);
  assert.equal(status.credentialRollbackSucceeded, false);
  assert.equal(status.actionRequired, 'RESTORE_CREDENTIALS_FROM_BACKUP');
  assert.equal(status.rollbackPath, path.join(f.c.stateRoot, 'rollback.json'));
  assert.equal(status.originalDesktopRestarted, false);
  assert.deepEqual(f.actions.map(x => x.action), ['StopDesktop']);
  assert.equal(readAuth(f.c.authPath).plan, 'plus', 'a failed restore must not be mislabeled as the original account');
  assert.deepEqual(fs.readFileSync(status.rollbackPath), f.refreshedSource);
  assert.equal(f.routes.filter(x => x.method !== 'GET').length, 0);
  assert.deepEqual(f.selected, f.selectedBefore);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('synthetic-refresh-'));
  assert.ok(!serialized.includes('access_token') && !serialized.includes('id_token'));
});

test('US loss before desktop restart keeps it closed after restoring source credentials', async t => {
  const f = fixture(t, {afterOnlineNonUS: true});
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('EGRESS_COUNTRY_MISMATCH'));
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.refreshedSource);
  assert.deepEqual(f.actions.map(x => x.action), ['StopDesktop', 'DesktopState']);
  assert.equal(getJson(path.join(f.c.stateRoot, 'status.json')).originalDesktopRestarted, false);
});

test('missing target vault credential fails before desktop closure', async t => {
  const f = fixture(t, {missingTarget: true});
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('TARGET_CREDENTIAL_MISSING'));
  assert.deepEqual(f.actions, []); assert.deepEqual(fs.readFileSync(f.c.authPath), f.source);
});

test('a missing Plus vault entry resolves the configured existing private-profile credential', async t => {
  const f = fixture(t, {missingTarget: true, configuredSource: true});
  const resolved = engine.resolveSavedCredential(f.c, 'plus');
  assert.equal(resolved.path, f.configuredSourcePath);
  assert.equal(resolved.origin, 'configured-source');
  assert.equal(resolved.auth.plan, 'plus');
  const p = await engine.plan(f.c, 'plus', f.ops);
  assert.equal(p.targetPath, f.configuredSourcePath);
  assert.equal(p.saved.identity, parseAuth(f.target).identity);
  assert.equal(p.public.targetCredentialPath, f.configuredSourcePath);
  assert.equal(fs.existsSync(path.join(f.c.vaultRoot, 'plus.json')), false);
});

test('worker switches from the configured private source, keeps it untouched, and saves only refreshed vault output', async t => {
  const f = fixture(t, {missingTarget: true, configuredSource: true});
  await engine.worker(f.c, f.jobPath, f.ops);
  assert.deepEqual(fs.readFileSync(f.configuredSourcePath), f.target);
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.refreshedTarget);
  assert.deepEqual(fs.readFileSync(path.join(f.c.vaultRoot, 'plus.json')), f.refreshedTarget);
  assert.ok(!f.writes.some(entry => entry.file === path.relative(f.directory, f.configuredSourcePath)));
  assert.deepEqual(f.actions.map(entry => entry.action), ['StopDesktop', 'StartDesktop']);
  assert.equal(f.routes.filter(entry => entry.method !== 'GET').length, 0);
});

test('status shows Plus identity and its configured source path without exporting a new credential', async t => {
  const f = fixture(t, {missingTarget: true, configuredSource: true});
  const status = await engine.status(f.c);
  assert.equal(status.saved.plus.plan, 'plus');
  assert.equal(status.savedPaths.plus, f.configuredSourcePath);
  assert.equal(fs.existsSync(path.join(f.c.vaultRoot, 'plus.json')), false);
  assert.ok(!JSON.stringify(status).includes('synthetic-refresh-'));
});

test('wrong-plan configured source fails before closing the desktop or modifying its contents', async t => {
  const f = fixture(t, {missingTarget: true, configuredSource: true, configuredSourcePlan: 'pro'});
  const before = fs.readFileSync(f.configuredSourcePath);
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('TARGET_PLAN_MISMATCH'));
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []);
  assert.deepEqual(fs.readFileSync(f.configuredSourcePath), before);
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.source);
});

test('absent vault and absent configured source resolve to no credential and stop switching', async t => {
  const f = fixture(t, {missingTarget: true});
  f.c.accounts.plus.credentialSources = [f.configuredSourcePath];
  assert.equal(engine.resolveSavedCredential(f.c, 'plus'), null);
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('TARGET_CREDENTIAL_MISSING'));
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []);
});

test('saving a different Plus identity cannot bypass the configured-source identity guard', t => {
  const f = fixture(t, {missingTarget: true, configuredSource: true});
  let writes = 0;
  assert.throws(() => engine.saveCurrent(f.c, parseAuth(auth('plus', 'fixture-unrelated-plus')), () => {writes++;}), errorCode('AUTH_IDENTITY_MISMATCH'));
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(f.c.vaultRoot, 'plus.json')), false);
  assert.deepEqual(fs.readFileSync(f.configuredSourcePath), f.target);
});

test('a configured source that changes after scheduling is rejected before desktop closure', async t => {
  const f = fixture(t, {missingTarget: true, configuredSource: true});
  fs.writeFileSync(f.jobPath, JSON.stringify({...f.job, completedAt: new Date().toISOString()}));
  await engine.schedule(f.c, 'plus', f.ops);
  const generated = fs.readdirSync(f.c.stateRoot).find(name => /^job-[a-f0-9-]+\.json$/.test(name) && path.join(f.c.stateRoot, name) !== f.jobPath);
  fs.writeFileSync(f.configuredSourcePath, f.refreshedTarget);
  await assert.rejects(engine.worker(f.c, path.join(f.c.stateRoot, generated), f.ops), errorCode('TARGET_CREDENTIAL_CHANGED'));
  assert.deepEqual(f.actions.map(entry => entry.action), ['Discover', 'LaunchWorker']);
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.source);
  assert.deepEqual(f.writes, []);
});

test('the vault takes precedence over a different configured source', async t => {
  const f = fixture(t, {configuredSource: true, configuredSourcePlan: 'pro'});
  const resolved = engine.resolveSavedCredential(f.c, 'plus');
  assert.equal(resolved.origin, 'vault');
  assert.equal(resolved.path, path.join(f.c.vaultRoot, 'plus.json'));
  const p = await engine.plan(f.c, 'plus', f.ops);
  assert.equal(p.saved.plan, 'plus');
});

test('a corrupt existing vault cannot silently fall back to a valid configured source', async t => {
  const f = fixture(t, {configuredSource: true});
  fs.writeFileSync(path.join(f.c.vaultRoot, 'plus.json'), '{invalid fixture');
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('AUTH_INVALID_JSON'));
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []);
  assert.deepEqual(fs.readFileSync(f.configuredSourcePath), f.target);
});

test('worker rejects legacy schema before probing or changing any state', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.jobPath, JSON.stringify({...f.job, schema: 1}));
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), error => /^JOB_/.test(error.code || error.message));
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []); assert.equal(f.verifyCount, 0);
});

test('changed target credential is not silently accepted during the delay', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.c.vaultRoot, 'plus.json'), f.refreshedTarget);
  await assert.rejects(engine.worker(f.c, f.jobPath, f.ops), errorCode('TARGET_CREDENTIAL_CHANGED'));
  assert.deepEqual(f.actions, []); assert.deepEqual(fs.readFileSync(f.c.authPath), f.source);
});

test('account plan works with unrelated nodes and ignores a legacy Japanese country mapping', async t => {
  const f = fixture(t);
  const p = await engine.plan(f.c, 'plus', f.ops);
  assert.equal(p.target, 'plus'); assert.equal(p.saved.plan, 'plus');
  assert.deepEqual(p.countries, proof());
  assert.equal(f.routes.filter(x => x.method !== 'GET').length, 0);
});

test('same-account request verifies US but does not discover, close or restart desktops', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.jobPath, JSON.stringify({...f.job, completedAt: new Date().toISOString()}));
  const result = await engine.schedule(f.c, 'pro', f.ops);
  assert.equal(result.alreadyActive, true); assert.equal(result.target, 'pro');
  assert.deepEqual(f.actions, []); assert.ok(f.verifyCount >= 1);
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.source);
});

test('recent legacy pending switch blocks scheduling without taking over the old job', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.jobPath, JSON.stringify({...f.job, schema: 1}));
  await assert.rejects(engine.schedule(f.c, 'plus', f.ops), errorCode('ANOTHER_SWITCH_PENDING'));
  assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []);
});

test('scheduling an account-only job records no credentials and does not close the desktop yet', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.jobPath, JSON.stringify({...f.job, completedAt: new Date().toISOString()}));
  const result = await engine.schedule(f.c, 'plus', f.ops);
  assert.equal(result.scheduled, true); assert.equal(result.target, 'plus');
  assert.deepEqual(f.actions.map(x => x.action), ['Discover', 'LaunchWorker']);
  const generated = fs.readdirSync(f.c.stateRoot).filter(name => /^job-[a-f0-9-]+\.json$/.test(name) && path.join(f.c.stateRoot, name) !== f.jobPath);
  assert.equal(generated.length, 1);
  const job = getJson(path.join(f.c.stateRoot, generated[0]));
  assert.equal(job.schema, 4); assert.equal(job.switchMode, 'account-only'); assert.equal(job.requiredCountry, 'US');
  assert.deepEqual(job.activityContext,{callerThreadId:'fixture-caller',callerTurnId:'fixture-turn'});
  assert.equal(result.workerReady,true);assert.equal(result.workerJobIsolated,true);
  assert.ok(fs.existsSync(path.join(f.c.stateRoot,generated[0])+'.armed.json'));
  assert.ok(!JSON.stringify(job).includes('synthetic-refresh-'));
  assert.deepEqual(fs.readFileSync(f.c.authPath), f.source);
  assert.deepEqual(f.writes, []);
});

test('status reads only fixture credential metadata without needing a network or probe', async t => {
  const f = fixture(t);
  const status = await engine.status(f.c);
  assert.equal(status.current.plan, 'pro'); assert.equal(status.saved.plus.plan, 'plus');
  assert.ok(!JSON.stringify(status).includes('synthetic-refresh-'));
  assert.equal(f.verifyCount, 0); assert.deepEqual(f.actions, []); assert.deepEqual(f.writes, []);
});

test('configured forward-slash auth path matches the worker CODEX_HOME representation', t => {
  const f=fixture(t),file=path.join(f.directory,'config.json');
  fs.writeFileSync(file,JSON.stringify({...f.c,authPath:f.c.authPath.replaceAll('\\','/')}));
  const scheduler=engine.config(file,{});
  const worker=engine.config(file,{CODEX_HOME:path.dirname(scheduler.authPath)});
  assert.equal(worker.authPath,scheduler.authPath);
  assert.equal(worker.authPath,f.c.authPath);
});

test('portable defaults use three-second launch and five-second shutdown grace', t => {
  const f=fixture(t);
  const c=engine.config(path.join(f.directory,'missing-config.json'),{CODEX_HOME:path.dirname(f.c.authPath)});
  assert.equal(c.launchDelaySeconds,3);assert.equal(c.closeGraceSeconds,5);
  assert.equal(c.authPath,f.c.authPath);assert.equal(c.nodePath,process.execPath);
  assert.ok(c.stateRoot.startsWith(path.dirname(f.c.authPath)+path.sep));
});

test('another active chat blocks scheduling before any desktop or network operations', async t => {
  const f=fixture(t,{busySchedule:true});
  fs.writeFileSync(f.jobPath,JSON.stringify({...f.job,completedAt:new Date().toISOString()}));
  await assert.rejects(engine.schedule(f.c,'plus',f.ops),errorCode('CHAT_IN_PROGRESS'));
  assert.deepEqual(f.actions,[]);assert.deepEqual(f.writes,[]);assert.equal(f.verifyCount,0);
});

test('activity appearing after scheduling blocks the worker before closure and credential writes', async t => {
  const f=fixture(t,{busyClose:true});
  await assert.rejects(engine.worker(f.c,f.jobPath,f.ops),errorCode('CHAT_IN_PROGRESS'));
  assert.deepEqual(f.actions,[]);assert.deepEqual(f.writes,[]);
  assert.deepEqual(f.activities,[{phase:'close',callerThreadId:'fixture-caller',expectedCallerTurnId:'fixture-turn'}]);
  assert.deepEqual(fs.readFileSync(f.c.authPath),f.source);
});

test('save uses the shared lock and refuses a recent pending switch', t => {
  const f=fixture(t);
  assert.throws(()=>engine.saveAccount(f.c,'pro',f.ops.privateWrite),errorCode('ANOTHER_SWITCH_PENDING'));
  assert.deepEqual(f.writes,[]);
  fs.writeFileSync(f.jobPath,JSON.stringify({...f.job,completedAt:new Date().toISOString()}));
  const release=engine.acquireOperationLock(f.c,'schedule');
  try {assert.throws(()=>engine.saveAccount(f.c,'pro',f.ops.privateWrite),errorCode('ANOTHER_SWITCH_PENDING'));}
  finally {release();}
  const saved=engine.saveAccount(f.c,'pro',f.ops.privateWrite);
  assert.equal(saved.verified,true);assert.equal(fs.existsSync(path.join(f.c.stateRoot,'switch.lock')),false);
});

test('an unisolated worker is cancelled before it can be armed or close the desktop', async t => {
  const f=fixture(t,{workerNotIsolated:true});
  fs.writeFileSync(f.jobPath,JSON.stringify({...f.job,completedAt:new Date().toISOString()}));
  await assert.rejects(engine.schedule(f.c,'plus',f.ops),errorCode('WORKER_NOT_ISOLATED'));
  const name=fs.readdirSync(f.c.stateRoot).find(x=>/^job-[a-f0-9-]+\.json$/.test(x) && path.join(f.c.stateRoot,x)!==f.jobPath);
  const file=path.join(f.c.stateRoot,name);
  assert.equal(getJson(file).cancelled,true);assert.ok(getJson(file).completedAt);
  assert.equal(fs.existsSync(file+'.armed.json'),false);
  assert.ok(!f.actions.some(x=>x.action==='StopDesktop'));assert.deepEqual(f.writes,[]);
});

test('a worker that never acknowledges startup is cancelled and cannot close the desktop', async t => {
  const f=fixture(t,{workerNotReady:true});
  fs.writeFileSync(f.jobPath,JSON.stringify({...f.job,completedAt:new Date().toISOString()}));
  await assert.rejects(engine.schedule(f.c,'plus',f.ops),errorCode('WORKER_START_TIMEOUT'));
  const name=fs.readdirSync(f.c.stateRoot).find(x=>/^job-[a-f0-9-]+\.json$/.test(x) && path.join(f.c.stateRoot,x)!==f.jobPath);
  const file=path.join(f.c.stateRoot,name);
  assert.equal(getJson(file).cancelled,true);assert.equal(fs.existsSync(file+'.armed.json'),false);
  assert.ok(!f.actions.some(x=>x.action==='StopDesktop'));assert.deepEqual(f.writes,[]);
});

test('a worker cannot act without approval from the successfully verified launcher', async t => {
  const f=fixture(t);fs.unlinkSync(f.jobPath+'.armed.json');
  await assert.rejects(engine.worker(f.c,f.jobPath,f.ops),errorCode('WORKER_NOT_ARMED'));
  assert.deepEqual(f.actions,[]);assert.deepEqual(f.writes,[]);assert.equal(f.verifyCount,0);
});

test('an old ready file is insufficient without acknowledgement that the worker received approval', async t => {
  const f=fixture(t,{workerNoArmAck:true});
  fs.writeFileSync(f.jobPath,JSON.stringify({...f.job,completedAt:new Date().toISOString()}));
  await assert.rejects(engine.schedule(f.c,'plus',f.ops),errorCode('WORKER_ARM_TIMEOUT'));
  const name=fs.readdirSync(f.c.stateRoot).find(x=>/^job-[a-f0-9-]+\.json$/.test(x) && path.join(f.c.stateRoot,x)!==f.jobPath);
  assert.equal(getJson(path.join(f.c.stateRoot,name)).cancelled,true);
  assert.ok(!f.actions.some(x=>x.action==='StopDesktop'));assert.deepEqual(f.writes,[]);
});

test('zero-delay worker waits for launcher approval before starting account operations', async t => {
  const f=fixture(t);fs.unlinkSync(f.jobPath+'.armed.json');
  let waits=0;
  f.ops.delay=async milliseconds=>{
    if(milliseconds!==100)return;
    assert.deepEqual(f.actions,[]);assert.deepEqual(f.writes,[]);assert.equal(f.verifyCount,0);
    if(++waits===2)fs.writeFileSync(f.jobPath+'.armed.json',JSON.stringify({pid:process.pid,jobPath:f.jobPath,authPath:f.c.authPath}));
  };
  await engine.worker(f.c,f.jobPath,f.ops);
  assert.equal(waits,2);assert.equal(readAuth(f.c.authPath).plan,'plus');
});

test('scheduler releases its lock before permitting a zero-delay worker to proceed', async t => {
  const f=fixture(t,{workerNoArmAck:true});
  fs.writeFileSync(f.jobPath,JSON.stringify({...f.job,completedAt:new Date().toISOString()}));
  let checked=false;
  f.ops.delay=async()=>{
    const name=fs.readdirSync(f.c.stateRoot).find(x=>/^job-[a-f0-9-]+\.json$/.test(x) && path.join(f.c.stateRoot,x)!==f.jobPath);
    const file=path.join(f.c.stateRoot,name);
    if(!fs.existsSync(file+'.armed.json'))return;
    assert.equal(fs.existsSync(path.join(f.c.stateRoot,'switch.lock')),false);
    fs.writeFileSync(file+'.armed-ack.json',JSON.stringify({pid:process.pid,jobPath:file,authPath:f.c.authPath}));
    checked=true;
  };
  const result=await engine.schedule(f.c,'plus',f.ops);
  assert.equal(checked,true);assert.equal(result.scheduled,true);
});

test('shutdown failure after closure reopens the original account and records the failed phase', async t => {
  const f=fixture(t,{stopFailsAfterClose:true});
  await assert.rejects(engine.worker(f.c,f.jobPath,f.ops),errorCode('DESKTOP_STOP_FAILED'));
  assert.deepEqual(f.actions.map(x=>x.action),['StopDesktop','DesktopState','StartDesktop']);
  const state=getJson(path.join(f.c.stateRoot,'status.json'));
  assert.equal(state.desktopShutdownAttempted,true);assert.equal(state.desktopClosedConfirmed,false);
  assert.equal(state.originalDesktopRestarted,true);assert.equal(state.originalDesktopRunning,true);
  assert.equal(state.error,'DESKTOP_STOP_FAILED');assert.deepEqual(fs.readFileSync(f.c.authPath),f.refreshedSource);
  assert.deepEqual(f.writes,[]);
});

test('partial shutdown with a remaining desktop never starts a duplicate instance', async t => {
  const f=fixture(t,{stopFailsAfterClose:true,desktopStillRunning:true});
  await assert.rejects(engine.worker(f.c,f.jobPath,f.ops),errorCode('DESKTOP_STOP_FAILED'));
  assert.deepEqual(f.actions.map(x=>x.action),['StopDesktop','DesktopState']);
  const state=getJson(path.join(f.c.stateRoot,'status.json'));
  assert.equal(state.originalDesktopRunning,true);assert.equal(state.originalDesktopRestarted,false);
  assert.deepEqual(f.writes,[]);
});

test('a shutdown rejected before touching the desktop does not attempt recovery launch', async t => {
  const f=fixture(t,{stopFailsBeforeClose:true});
  await assert.rejects(engine.worker(f.c,f.jobPath,f.ops),errorCode('DESKTOP_STOP_FAILED'));
  assert.deepEqual(f.actions.map(x=>x.action),['StopDesktop']);
  assert.equal(getJson(path.join(f.c.stateRoot,'status.json')).desktopShutdownAttempted,false);
  assert.deepEqual(fs.readFileSync(f.c.authPath),f.source);assert.deepEqual(f.writes,[]);
});

test('account inspection only reads configs and exposes a client that refuses every write method', async () => {
  const requests = [];
  const raw = {transport: 'synthetic', request: async (route, method = 'GET') => {
    requests.push({route, method});
    assert.equal(route, '/configs'); assert.equal(method, 'GET');
    return {mode: 'rule', 'mixed-port': 17897};
  }};
  const net = await engine.inspectAccountNetwork({}, async () => raw);
  assert.deepEqual(requests, [{route: '/configs', method: 'GET'}]);
  for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
    await assert.rejects(async () => net.client.request('/proxies/AI', method, {name: 'synthetic-change'}), error => /READ_ONLY|WRITE_DISABLED|READONLY/.test(error.code || error.message));
  }
  assert.equal(requests.length, 1, 'writes must not reach the underlying controller client');
});

test('verification requires positive US proof for both configured OpenAI hosts', async () => {
  const cfg = {accounts: {plus: {country: 'JP'}}};
  const net = {runtime: {'mixed-port': 17897}, public: {readOnly: true}};
  const result = await engine.verifyAccountEgress(cfg, {
    inspectAccountNetwork: async () => net,
    traceCountry: async (actualCfg, actualNet, expected) => {
      assert.equal(actualCfg, cfg); assert.equal(actualNet, net); assert.equal(expected, 'US'); return proof();
    }
  });
  assert.deepEqual(result.countries, proof());
  for (const countries of [[], [proof()[0]], [{host: 'chatgpt.com', country: 'US'}, {host: 'api.openai.com', country: 'JP'}],
    [{host: 'chatgpt.com', country: 'US'}, {host: 'api.openai.com', country: null}]]) {
    await assert.rejects(engine.verifyAccountEgress(cfg, {
      inspectAccountNetwork: async () => net, traceCountry: async () => countries
    }), error => /EGRESS_|COUNTRY_/.test(error.code || error.message));
  }
});

test('no test started a real process or network request', () => assert.deepEqual(forbidden, []));
