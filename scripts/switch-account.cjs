'use strict';
// No third-party packages. Secrets stay in memory and never enter jobs or logs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const readline = require('node:readline');
const {readAuth, publicAuth, assertSameIdentity} = require('./auth-utils.cjs');
const {inspectChatActivity} = require('./activity-guard.cjs');
const BASE = path.dirname(__dirname);
const PS = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const PS_HELPER = path.join(__dirname, 'windows-session.ps1');
class SwitchError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new SwitchError(code); };
const delay = ms => new Promise(r => setTimeout(r, ms));
const ACCOUNT_SWITCH_MODE = 'account-only';
const ACCOUNT_COUNTRY = 'US';
const WORKER_LAUNCH_MODE = 'wmi-breakaway-v1';
function canonicalPath(file) {
  let existing=path.resolve(file);
  const missing=[];
  while(!fs.existsSync(existing)) {
    const parent=path.dirname(existing);
    if(parent===existing)fail('CONFIG_PATH_UNVERIFIED');
    missing.unshift(path.basename(existing));existing=parent;
  }
  return path.join(fs.realpathSync.native(existing),...missing);
}
function config(file=path.join(BASE,'config.json'),env=process.env) {
  const codexHome=env.CODEX_HOME || path.join(os.homedir(),'.codex');
  const local=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const c={authPath:path.join(codexHome,'auth.json'),
    vaultRoot:path.join(codexHome,'account-switch','vault'),stateRoot:path.join(codexHome,'account-switch','state'),
    clashConfigRoot:path.join(env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'io.github.clash-verge-rev.clash-verge-rev'),
    nodePath:process.execPath,launchDelaySeconds:3,closeGraceSeconds:5,
    accounts:{pro:{credentialSources:[]},plus:{credentialSources:[]}},
    traceUrls:['https://chatgpt.com/cdn-cgi/trace','https://api.openai.com/cdn-cgi/trace'],...local};
  // Respect an intentionally configured home without assigning to CODEX_HOME.
  if (env.CODEX_HOME) c.authPath = path.join(env.CODEX_HOME, 'auth.json');
  // Windows shells may expand an 8.3 alias while Node preserves its spelling.
  // Use one on-disk representation at both sides of the worker boundary, but
  // reject credential-path links before resolving them.
  for(const key of ['authPath','vaultRoot','stateRoot'])noLinks(c[key]);
  for(const key of ['authPath','vaultRoot','stateRoot','clashConfigRoot','nodePath'])c[key]=canonicalPath(c[key]);
  if(!Number.isFinite(c.launchDelaySeconds) || c.launchDelaySeconds<0 || c.launchDelaySeconds>60)fail('CONFIG_DELAY_INVALID');
  if(!Number.isFinite(c.closeGraceSeconds) || c.closeGraceSeconds<0 || c.closeGraceSeconds>60)fail('CONFIG_CLOSE_GRACE_INVALID');
  return c;
}
function powershell(action, args = {}) {
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_HELPER, '-Action', action];
  for (const [k,v] of Object.entries(args)) argv.push('-'+k, String(v));
  const r = spawnSync(PS, argv, {encoding:'utf8', windowsHide:true, timeout:70000, maxBuffer:8*1024*1024});
  let out; try { out = JSON.parse((r.stdout || '').replace(/^\uFEFF/, '').trim()); } catch { fail('WINDOWS_HELPER_UNAVAILABLE'); }
  if (r.status !== 0 || !out.ok) {
    const error = new SwitchError(/^[A-Z][A-Z0-9_]{2,80}$/.test(out.errorCode || '') ? out.errorCode : 'WINDOWS_HELPER_FAILED');
    if (typeof out.shutdownAttempted === 'boolean') error.shutdownAttempted = out.shutdownAttempted;
    if (/^[a-z_]{3,60}$/.test(out.phase || '')) error.helperPhase=out.phase;
    if (/^[A-Za-z]{3,80}$/.test(out.errorKind || '')) error.helperErrorKind=out.errorKind;
    throw error;
  }
  return out;
}
function safeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data,null,2)+'\n', {encoding:'utf8'}); }
function signalJson(file,data) {
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try {safeJson(temporary,data);fs.renameSync(temporary,file);}
  finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function noLinks(file) {
  let p = path.resolve(file);
  while (true) {
    try {if(fs.lstatSync(p).isSymbolicLink())fail('LINK_PATH_REJECTED');}
    catch(error) {if(error.code!=='ENOENT' && error.code!=='ENOTDIR')throw error;}
    const parent = path.dirname(p); if (p === parent) break; p = parent;
  }
}
function privateWrite(file, bytes) {
  noLinks(file);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp = path.join(path.dirname(file), '.'+path.basename(file)+'.'+crypto.randomUUID()+'.tmp');
  try {
    fs.closeSync(fs.openSync(tmp, 'wx'));
    powershell('SetPrivateAcl', {FilePath:tmp});
    fs.writeFileSync(tmp, bytes);
    if (!fs.readFileSync(tmp).equals(bytes)) fail('BACKUP_VERIFY_FAILED');
    fs.renameSync(tmp,file);
    powershell('SetPrivateAcl', {FilePath:file});
    if (!fs.readFileSync(file).equals(bytes)) fail('BACKUP_VERIFY_FAILED');
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function scalarConfig(file) {
  const out = {};
  for (const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*?)\s*$/); if (!m) continue;
    let v = m[2];
    if (v.startsWith('"')) { try { v=JSON.parse(v); } catch { continue; } }
    else if (v.startsWith("'")) v=v.slice(1,-1).replaceAll("''", "'");
    out[m[1]]=v;
  }
  return out;
}
function apiRequest(endpoint, secret, route, method='GET', data) {
  return new Promise((resolve,reject) => {
    const body = data === undefined ? null : JSON.stringify(data);
    const options = {method,path:route,timeout:5000,headers:{Authorization:'Bearer '+secret}};
    if (endpoint.pipe) options.socketPath=endpoint.pipe;
    else { options.hostname='127.0.0.1'; options.port=endpoint.port; }
    if (body) { options.headers['Content-Type']='application/json'; options.headers['Content-Length']=Buffer.byteLength(body); }
    const req=http.request(options,res=>{
      let s=''; res.setEncoding('utf8');
      res.on('data',chunk=>{s+=chunk;if(s.length>16*1024*1024)req.destroy();});
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300) return reject(new SwitchError('CLASH_API_REJECTED'));
        try { resolve(s?JSON.parse(s):null); } catch { reject(new SwitchError('CLASH_RESPONSE_INVALID')); }
      });
    });
    req.on('timeout',()=>req.destroy()); req.on('error',()=>reject(new SwitchError('CLASH_UNAVAILABLE')));
    req.end(body);
  });
}
async function connectClash(c) {
  // Read the effective config last. Never change its controller/secret fields.
  const raw={...scalarConfig(path.join(c.clashConfigRoot,'config.yaml')),
    ...scalarConfig(path.join(c.clashConfigRoot,'clash-verge.yaml'))};
  const endpoints=[];
  if (/^(?:127\.0\.0\.1|localhost):\d+$/.test(raw['external-controller'] || ''))
    endpoints.push({port:Number(raw['external-controller'].split(':').at(-1))});
  if (raw['external-controller-pipe']) endpoints.push({pipe:raw['external-controller-pipe']});
  // Verge 2.5.8 can run a production pipe while a stale sidecar pipe remains in YAML.
  // Discovery uses OS-returned names; it never guesses an undiscovered pipe.
  try {
    for (const name of fs.readdirSync('\\\\.\\pipe\\'))
      if (/^verge-mihomo-(?:production|sidecar-release)-[a-f0-9]+$/i.test(name)) endpoints.push({pipe:'\\\\.\\pipe\\'+name});
  } catch { /* A supported loopback controller may still be available. */ }
  const unique=[...new Map(endpoints.map(x=>[JSON.stringify(x),x])).values()];
  const good=[];
  for (const endpoint of unique) {
    try {
      const version=await apiRequest(endpoint,raw.secret || '', '/version');
      if(version && typeof version.version==='string') good.push(endpoint);
    } catch { /* Try only other observed local endpoints. */ }
  }
  if(!good.length)fail('CLASH_UNAVAILABLE');
  // Multiple live backends require explicit reconfiguration instead of arbitrary choice.
  if(good.length>1)fail('CLASH_MULTIPLE_CONTROLLERS');
  return {transport:good[0].pipe?'named-pipe':'loopback-http',
    request:(route,method,data)=>apiRequest(good[0],raw.secret || '',route,method,data)};
}
async function inspectAccountNetwork(c, connect=connectClash) {
  if(c.proxyUrl) {
    const match=String(c.proxyUrl).match(/^http:\/\/127\.0\.0\.1:(\d{1,5})$/);
    if(!match || Number(match[1])<1 || Number(match[1])>65535)fail('PROXY_URL_INVALID');
    const port=Number(match[1]);
    return {runtime:{'mixed-port':port},proxyUrl:c.proxyUrl,
      public:{mixedPort:port,transport:'configured-loopback-proxy',readOnly:true}};
  }
  const rawClient=await connect(c);
  // Account operations may observe the existing proxy, never configure it.
  const client=Object.freeze({transport:rawClient.transport,
    request:(route,method='GET',data)=>{
      if(method!=='GET' || data!==undefined)fail('NETWORK_WRITE_DISABLED');
      return rawClient.request(route,'GET');
    }});
  const runtime=await client.request('/configs');
  const rawPort=runtime?.['mixed-port'];
  const port=Number(rawPort);
  if(!(typeof rawPort==='number' || typeof rawPort==='string' && /^\d+$/.test(rawPort)) ||
    !Number.isInteger(port) || port<1 || port>65535)fail('CLASH_PROXY_PORT_INVALID');
  return {client,runtime:{...runtime,'mixed-port':port},proxyUrl:'http://127.0.0.1:'+port,
    public:{mode:runtime.mode || 'unknown',mixedPort:port,transport:client.transport,readOnly:true}};
}
async function verifyAccountEgress(c,ops={}) {
  const inspect=ops.inspectAccountNetwork || inspectAccountNetwork;
  const probe=ops.traceCountry || traceCountry;
  const net=await inspect(c);
  const countries=await probe(c,net,ACCOUNT_COUNTRY);
  if(!Array.isArray(countries) || !countries.length ||
    !['chatgpt.com','api.openai.com'].every(host=>countries.some(x=>x?.host===host)))fail('EGRESS_PROBE_UNAVAILABLE');
  if(countries.some(x=>x?.country!==ACCOUNT_COUNTRY))fail('EGRESS_COUNTRY_MISMATCH');
  return {net,countries,proxyUrl:net.proxyUrl || 'http://127.0.0.1:'+net.runtime['mixed-port']};
}
function chooseTarget(current,to) {
  if(to==='auto')return current.plan==='pro'?'plus':'pro';
  if(!['pro','plus'].includes(to))fail('TARGET_REQUIRED');return to;
}
function resolveSavedCredential(c,target) {
  if(!['pro','plus'].includes(target))fail('TARGET_REQUIRED');
  const vault=path.resolve(c.vaultRoot,target+'.json');
  const configured=c.accounts?.[target]?.credentialSources ?? [];
  if(!Array.isArray(configured) || configured.some(file=>typeof file!=='string' || !path.isAbsolute(file) || file.includes('\0')))fail('CREDENTIAL_SOURCE_INVALID');
  const seen=new Set();
  for(const file of [vault,...configured]) {
    const full=path.resolve(file), key=process.platform==='win32'?full.toLowerCase():full;
    if(seen.has(key))continue;seen.add(key);
    if(!fs.existsSync(full))continue;
    noLinks(full);
    const auth=readAuth(full);
    if(auth.plan!==target)fail('TARGET_PLAN_MISMATCH');
    return {path:full,auth,origin:full===vault?'vault':'configured-source'};
  }
  return null;
}
async function plan(c,to,ops={}) {
  // A login plan checks the current egress, without selecting a node or group.
  const proof=await (ops.verifyAccountEgress || verifyAccountEgress)(c);
  const {net,countries,proxyUrl}=proof;
  const current=readAuth(c.authPath);
  const target=chooseTarget(current,to);
  const credential=resolveSavedCredential(c,target);
  const targetPath=credential?.path ?? path.join(c.vaultRoot,target+'.json');
  const saved=credential?.auth ?? null;
  return {net,countries,proxyUrl,current,saved,target,targetPath,public:{network:net.public,current:publicAuth(current),
    switchMode:ACCOUNT_SWITCH_MODE,networkChanged:false,target,targetCountry:ACCOUNT_COUNTRY,countries,targetCredentialPresent:!!saved,
    targetCredentialPath:credential?.path ?? null,targetCredentialOrigin:credential?.origin ?? null,
    targetCredential:saved?publicAuth(saved):null,sameAccount:!!saved && saved.identity===current.identity}};
}
function saveCurrent(c,auth,write=privateWrite) {
  const destination=path.join(c.vaultRoot,auth.plan+'.json');
  const existing=resolveSavedCredential(c,auth.plan);
  if(existing)assertSameIdentity(auth,existing.auth);
  write(destination,auth.raw);
  return {account:auth.plan,path:destination,verified:true};
}
async function traceCountry(c,net,expected) {
  const countries=[];
  for(const url of c.traceUrls) {
    const curl=path.join(process.env.SystemRoot || 'C:/Windows','System32/curl.exe');
    const r=spawnSync(curl,['--silent','--show-error','--fail','--noproxy','', '--proxy',
      'http://127.0.0.1:'+net.runtime['mixed-port'],'--connect-timeout','8','--max-time','18',url],
      {encoding:'utf8',windowsHide:true,timeout:21000,maxBuffer:65536});
    const match=(r.stdout || '').match(/^loc=([A-Z]{2})\s*$/m);
    if(r.status!==0 || !match)fail('EGRESS_PROBE_UNAVAILABLE');
    countries.push({host:new URL(url).hostname,country:match[1]});
    if(expected && match[1]!==expected)fail('EGRESS_COUNTRY_MISMATCH');
  }
  return countries;
}
function acquireOperationLock(c,operation) {
  noLinks(c.stateRoot);fs.mkdirSync(c.stateRoot,{recursive:true});
  const file=path.join(c.stateRoot,'switch.lock');
  let fd;
  try{fd=fs.openSync(file,'wx');}catch{fail('ANOTHER_SWITCH_PENDING');}
  try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,operation,createdAt:new Date().toISOString()}));}
  catch(e){fs.closeSync(fd);fs.unlinkSync(file);throw e;}
  let released=false;
  return ()=>{if(released)return;released=true;fs.closeSync(fd);fs.unlinkSync(file);};
}
function assertNoPendingSwitch(c,now=Date.now()) {
  if(!fs.existsSync(c.stateRoot))return;
  for(const name of fs.readdirSync(c.stateRoot)) {
    if(!/^job-[a-f0-9-]+\.json$/i.test(name))continue;
    let job;try{job=JSON.parse(fs.readFileSync(path.join(c.stateRoot,name),'utf8'));}catch{continue;}
    const age=now-Date.parse(job.createdAt);
    if([1,2,3,4].includes(job.schema) && !job.completedAt && Number.isFinite(age) && age>=-10000 && age<=180000)fail('ANOTHER_SWITCH_PENDING');
  }
}
function saveAccount(c,target,write=privateWrite) {
  const release=acquireOperationLock(c,'save');
  try {
    assertNoPendingSwitch(c);
    const current=readAuth(c.authPath);
    if(target && target!==current.plan)fail('CURRENT_PLAN_MISMATCH');
    return {switchMode:ACCOUNT_SWITCH_MODE,networkChanged:false,...saveCurrent(c,current,write)};
  } finally {release();}
}
async function onlineAccount(c,cliPath,proxyUrl) {
  if(!cliPath || !fs.existsSync(cliPath))fail('CODEX_CLI_NOT_FOUND');
  const proc=spawn(cliPath,['app-server','--listen','stdio://'],{windowsHide:true,
    env:{...process.env,CODEX_HOME:path.dirname(c.authPath),HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,ALL_PROXY:proxyUrl,NO_PROXY:'localhost,127.0.0.1,::1'},
    stdio:['pipe','pipe','pipe']});
  // Discard stderr: upstream diagnostics may contain authentication details.
  proc.stderr.resume();
  let next=0;const pending=new Map();
  const lines=readline.createInterface({input:proc.stdout});
  lines.on('line',line=>{
    let msg;try{msg=JSON.parse(line);}catch{return;}
    const p=pending.get(msg.id);if(!p)return;
    pending.delete(msg.id);clearTimeout(p.timer);
    if(msg.error)p.reject(new SwitchError('ONLINE_AUTH_REJECTED'));else p.resolve(msg.result);
  });
  const abort=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new SwitchError('ONLINE_AUTH_UNAVAILABLE'));}pending.clear();};
  proc.on('error',abort);proc.on('exit',abort);
  proc.stdin.on('error',abort);
  function rpc(method,params) {
    const id=++next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new SwitchError('ONLINE_AUTH_TIMEOUT'));},25000);
      pending.set(id,{resolve,reject,timer});
      proc.stdin.write(JSON.stringify({id,method,...(params?{params}:{})})+'\n');
    });
  }
  try {
    await rpc('initialize',{clientInfo:{name:'codex_account_switch',version:'1.0.0'}});
    proc.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    const account=(await rpc('account/read',{refreshToken:false})).account;
    if(!account || account.type!=='chatgpt')fail('ONLINE_ACCOUNT_TYPE_MISMATCH');
    await rpc('account/rateLimits/read');
    return {authenticated:true,plan:account.planType || null};
  } finally {
    lines.close();proc.stdin.end();
    if(proc.exitCode===null)proc.kill();
    if(proc.exitCode===null)await Promise.race([new Promise(r=>proc.once('exit',r)),delay(3000)]);
  }
}
async function status(c) {
  const current=readAuth(c.authPath);
  const credentials=Object.fromEntries(['pro','plus'].map(k=>[k,resolveSavedCredential(c,k)]));
  return {switchMode:ACCOUNT_SWITCH_MODE,requiredCountry:ACCOUNT_COUNTRY,networkChanged:false,egressChecked:false,
    current:publicAuth(current),saved:Object.fromEntries(['pro','plus'].map(k=>[k,credentials[k]?publicAuth(credentials[k].auth):null])),
    savedPaths:Object.fromEntries(['pro','plus'].map(k=>[k,credentials[k]?.path ?? null]))};
}
function accountOperations(ops={}) {
  const operations={verifyAccountEgress,powershell,onlineAccount,inspectChatActivity,delay,privateWrite,...ops};
  if(!ops.saveCurrent)operations.saveCurrent=(c,auth)=>saveCurrent(c,auth,operations.privateWrite);
  return operations;
}
async function waitForWorker(c,jobPath,pid,operations,suffix='.ready.json') {
  const readyPath=jobPath+suffix;
  for(let attempt=0;attempt<100;attempt++) {
    if(fs.existsSync(readyPath)) {
      let ready;try{ready=JSON.parse(fs.readFileSync(readyPath,'utf8'));}catch{}
      if(ready) {
        if(ready.pid!==pid || ready.jobPath!==jobPath || ready.authPath!==c.authPath)fail('WORKER_READY_INVALID');
        return;
      }
    }
    await operations.delay(100);
  }
  fail(suffix==='.ready.json'?'WORKER_START_TIMEOUT':'WORKER_ARM_TIMEOUT');
}
async function waitForArm(c,jobPath,operations) {
  for(let attempt=0;attempt<100;attempt++) {
    const latest=JSON.parse(fs.readFileSync(jobPath,'utf8'));
    if(latest.completedAt)fail('JOB_EXPIRED');
    if(fs.existsSync(jobPath+'.armed.json')) {
      let armed;try{armed=JSON.parse(fs.readFileSync(jobPath+'.armed.json','utf8'));}catch{fail('WORKER_NOT_ARMED');}
      if(armed.pid!==process.pid || armed.jobPath!==jobPath || armed.authPath!==c.authPath)fail('WORKER_NOT_ARMED');
      return;
    }
    await operations.delay(100);
  }
  fail('WORKER_NOT_ARMED');
}
async function schedule(c,to,ops={}) {
  const operations=accountOperations(ops);
  const release=acquireOperationLock(c,'schedule');
  try {
  assertNoPendingSwitch(c);
  const activity=operations.inspectChatActivity(c,{phase:'schedule',callerThreadId:process.env.CODEX_THREAD_ID || null});
  const p=await plan(c,to,operations);
  if(!p.saved)fail('TARGET_CREDENTIAL_MISSING');
  if(p.saved.identity===p.current.identity && p.current.plan!==p.target)fail('ACCOUNT_IDENTITY_CONFLICT');
  if(p.saved.identity===p.current.identity) {
    operations.saveCurrent(c,p.current);
    return {alreadyActive:true,target:p.target,switchMode:ACCOUNT_SWITCH_MODE,network:p.net.public,
      countries:p.countries,credentialSaved:true,networkChanged:false};
  }
  const manifest=operations.powershell('Discover');
  if(manifest.roots.length!==1)fail('DESKTOP_ROOT_AMBIGUOUS');
  if(manifest.standaloneCli.length)fail('STANDALONE_CODEX_RUNNING');
  const cliPath=manifest.cliPaths.find(x=>x.exists)?.path;
  if(!cliPath)fail('CODEX_CLI_NOT_FOUND');
  fs.mkdirSync(c.stateRoot,{recursive:true});noLinks(c.stateRoot);
  const jobPath=path.join(c.stateRoot,'job-'+crypto.randomUUID()+'.json');
  const job={...manifest,schema:4,launchMode:WORKER_LAUNCH_MODE,authPath:c.authPath,
    activityContext:{callerThreadId:activity.callerThreadId,callerTurnId:activity.callerTurnId},
    switchMode:ACCOUNT_SWITCH_MODE,requiredCountry:ACCOUNT_COUNTRY,createdAt:new Date().toISOString(),target:p.target,
    sourceIdentity:p.current.identity,sourceDigest:p.current.digest,targetDigest:p.saved.digest,
    cliPath,desktopPath:manifest.roots[0].path};
  safeJson(jobPath,job);
  // All requests are validated again in the worker after the grace period.
  let launched;
  try {
    launched=operations.powershell('LaunchWorker',{NodePath:c.nodePath,WorkerPath:__filename,JobPath:jobPath,CodexHome:path.dirname(c.authPath)});
    if(launched.jobIsolated!==true)fail('WORKER_NOT_ISOLATED');
    await waitForWorker(c,jobPath,launched.pid,operations);
    // The persisted pending job now excludes competing operations. Release the
    // scheduling lock before permitting even a zero-delay worker to acquire it.
    release();
    signalJson(jobPath+'.armed.json',{pid:launched.pid,jobPath,authPath:c.authPath});
    await waitForWorker(c,jobPath,launched.pid,operations,'.armed-ack.json');
  } catch(error) {
    // A created but unconfirmed worker must observe cancellation before closing
    // the desktop. Never leave an unacknowledged request armed for later use.
    safeJson(jobPath,{...job,completedAt:new Date().toISOString(),cancelled:true,error:safeError(error)});
    safeJson(path.join(c.stateRoot,'status.json'),{at:new Date().toISOString(),target:p.target,
      state:'failed_before_desktop_close',error:safeError(error),networkChanged:false});
    throw error;
  }
  return {scheduled:true,target:p.target,switchMode:ACCOUNT_SWITCH_MODE,networkChanged:false,
    chatActivityChecked:true,otherChatsIdle:true,activityCoverage:activity.coverage,
    countries:p.countries,delaySeconds:c.launchDelaySeconds,workerPid:launched.pid,workerReady:true,workerJobIsolated:true,
    statusPath:path.join(c.stateRoot,'status.json'),warning:'DESKTOP_RESTART_REQUIRED'};
  } finally {release();}
}
async function worker(c,jobPath,ops={}) {
  const operations=accountOperations(ops);
  if(path.dirname(path.resolve(jobPath)).toLowerCase()!==path.resolve(c.stateRoot).toLowerCase())fail('JOB_PATH_INVALID');
  const job=JSON.parse(fs.readFileSync(jobPath,'utf8'));
  if(job.schema!==4 || !job.activityContext || job.launchMode!==WORKER_LAUNCH_MODE || job.switchMode!==ACCOUNT_SWITCH_MODE || job.requiredCountry!==ACCOUNT_COUNTRY)fail('JOB_FORMAT_UNSUPPORTED');
  if(job.authPath!==c.authPath)fail('WORKER_AUTH_PATH_MISMATCH');
  if(!Number.isFinite(Date.parse(job.createdAt)) || Date.now()-Date.parse(job.createdAt)>180000 || Date.parse(job.createdAt)>Date.now()+10000)fail('JOB_EXPIRED');
  if(job.completedAt)fail('JOB_EXPIRED');
  signalJson(jobPath+'.ready.json',{pid:process.pid,jobPath,authPath:c.authPath,at:new Date().toISOString()});
  await waitForArm(c,jobPath,operations);
  signalJson(jobPath+'.armed-ack.json',{pid:process.pid,jobPath,authPath:c.authPath,at:new Date().toISOString()});
  await operations.delay(Math.max(0,c.launchDelaySeconds)*1000);
  const lock=path.join(c.stateRoot,'switch.lock');
  let fd;
  try{fd=fs.openSync(lock,'wx');}catch{
    let old;try{old=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{fail('STALE_LOCK_REQUIRES_CHECK');}
    try{process.kill(old.pid,0);fail('ANOTHER_SWITCH_PENDING');}catch(e){
      if(e.code!=='ESRCH')throw e;
      fs.unlinkSync(lock);fd=fs.openSync(lock,'wx');
    }
  }
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));
  const writeStatus=data=>safeJson(path.join(c.stateRoot,'status.json'),{at:new Date().toISOString(),target:job.target,...data});
  let p,closed=false,shutdownAttempted=false,changed=false,rollback=null;
  try {
    const latestJob=JSON.parse(fs.readFileSync(jobPath,'utf8'));
    const jobAge=Date.now()-Date.parse(latestJob.createdAt);
    if(latestJob.schema!==4 || latestJob.launchMode!==WORKER_LAUNCH_MODE || latestJob.authPath!==c.authPath ||
      latestJob.switchMode!==ACCOUNT_SWITCH_MODE || latestJob.requiredCountry!==ACCOUNT_COUNTRY ||
      latestJob.target!==job.target || latestJob.sourceIdentity!==job.sourceIdentity || latestJob.targetDigest!==job.targetDigest)fail('JOB_CHANGED');
    if(latestJob.completedAt || !Number.isFinite(jobAge) || jobAge>180000 || jobAge< -10000)fail('JOB_EXPIRED');
    p=await plan(c,job.target,operations); // Read-only US proof before closing anything.
    if(!p.saved)fail('TARGET_CREDENTIAL_MISSING');
    if(p.current.identity!==job.sourceIdentity)fail('SOURCE_ACCOUNT_CHANGED');
    // Auth can refresh during the grace period. Identity must match; snapshot the newest bytes after closure.
    if(p.saved.digest!==job.targetDigest)fail('TARGET_CREDENTIAL_CHANGED');
    operations.inspectChatActivity(c,{phase:'close',callerThreadId:job.activityContext.callerThreadId,
      expectedCallerTurnId:job.activityContext.callerTurnId});
    writeStatus({state:'closing_desktop'});
    shutdownAttempted=true;
    try {operations.powershell('StopDesktop',{ManifestPath:jobPath,PreserveProcessIds:process.pid,CloseGraceSeconds:c.closeGraceSeconds ?? 5});}
    catch(error) {if(error.shutdownAttempted===false)shutdownAttempted=false;throw error;}
    closed=true;
    const fresh=readAuth(c.authPath);if(fresh.identity!==job.sourceIdentity)fail('SOURCE_ACCOUNT_CHANGED');
    operations.saveCurrent(c,fresh);
    rollback=path.join(c.stateRoot,'rollback.json');operations.privateWrite(rollback,fresh.raw);
    writeStatus({state:'checking_current_us_egress',networkChanged:false});
    await operations.verifyAccountEgress(c);
    const target=p.current.identity===p.saved.identity?fresh:readAuth(p.targetPath);
    if(target.identity!==fresh.identity && target.digest!==job.targetDigest)fail('TARGET_CREDENTIAL_CHANGED');
    if(target.identity!==fresh.identity) {changed=true;operations.privateWrite(c.authPath,target.raw);}
    writeStatus({state:'checking_online_auth',networkChanged:false});
    const loginProof=await operations.verifyAccountEgress(c);
    const check=await operations.onlineAccount(c,job.cliPath,loginProof.proxyUrl);
    const after=readAuth(c.authPath);
    if(after.identity!==target.identity || after.plan!==p.target || (check.plan && check.plan!==p.target))fail('AUTH_VALIDATION_MISMATCH');
    // Persist any token refresh made by the authenticated check.
    operations.saveCurrent(c,after);
    const targetTokens=JSON.parse(target.raw.toString('utf8').replace(/^\uFEFF/,'')).tokens;
    const afterTokens=JSON.parse(after.raw.toString('utf8').replace(/^\uFEFF/,'')).tokens;
    const tokenFieldsChangedDuringValidation=['access_token','id_token','refresh_token'].some(key=>targetTokens[key]!==afterTokens[key]);
    const startProof=await operations.verifyAccountEgress(c);
    operations.powershell('StartDesktop',{DesktopPath:job.desktopPath,ProxyUrl:startProof.proxyUrl});
    writeStatus({state:'restarted_pending_desktop_confirmation',account:publicAuth(after),
      onlineAuthVerified:true,desktopIdentityVerified:false,country:ACCOUNT_COUNTRY,countries:startProof.countries,
      sourceCredentialSaved:true,targetCredentialSaved:true,tokenFieldsChangedDuringValidation,
      chatActivityCheckedBeforeClose:true,activityCoverage:'local-turn-projection',
      switchMode:ACCOUNT_SWITCH_MODE,networkChanged:false});
  } catch(e) {
    let recovered=false,originalDesktopRunning=false,recoveryError=null;
    let credentialRollbackAttempted=false,credentialRollbackSucceeded=null,credentialRollbackError=null;
    if(shutdownAttempted && p) {
      try {
        if(changed) {
          credentialRollbackAttempted=true;
          if(!rollback)fail('ROLLBACK_CREDENTIAL_MISSING');
          operations.privateWrite(c.authPath,readAuth(rollback).raw);
        }
        const restored=readAuth(c.authPath);
        if(restored.identity!==p.current.identity || restored.plan!==p.current.plan)fail('CREDENTIAL_ROLLBACK_MISMATCH');
        credentialRollbackSucceeded=true;
      } catch(rollbackError) {
        credentialRollbackSucceeded=false;
        credentialRollbackError=safeError(rollbackError);
      }
      // Never start any account when source restoration failed or could not be
      // verified. A VPN retry cannot repair a credential-write failure.
      if(credentialRollbackSucceeded) {
        try {
          // A partial shutdown can leave the original or a newly launched
          // desktop running. Observe before attempting a recovery launch.
          const state=operations.powershell('DesktopState');
          if(typeof state.desktopRunning!=='boolean')fail('DESKTOP_STATE_UNAVAILABLE');
          originalDesktopRunning=state.desktopRunning;
          if(!originalDesktopRunning) {
            const proof=await operations.verifyAccountEgress(c);
            operations.powershell('StartDesktop',{DesktopPath:job.desktopPath,ProxyUrl:proof.proxyUrl});
            recovered=true;originalDesktopRunning=true;
          }
        } catch(recoveryFailure) {recoveryError=safeError(recoveryFailure);}
      }
    }
    writeStatus({state:'failed',error:safeError(e),switchMode:ACCOUNT_SWITCH_MODE,networkChanged:false,originalDesktopRestarted:recovered,
      ...(e.helperPhase?{helperPhase:e.helperPhase}:{}),...(e.helperErrorKind?{helperErrorKind:e.helperErrorKind}:{}),
      desktopShutdownAttempted:shutdownAttempted,desktopClosedConfirmed:closed,originalDesktopRunning,
      credentialRollbackAttempted,credentialRollbackSucceeded,...(recoveryError?{recoveryError}:{}),
      ...(credentialRollbackError?{credentialRollbackError}:{}),...(rollback?{rollbackPath:rollback}:{}),
      actionRequired:shutdownAttempted&&credentialRollbackSucceeded===false?'RESTORE_CREDENTIALS_FROM_BACKUP':
        shutdownAttempted&&!originalDesktopRunning?'CHECK_ERROR_AND_REOPEN_CODEX':'READ_ERROR_AND_RETRY'});
    throw e;
  } finally {
    try{safeJson(jobPath,{...job,completedAt:new Date().toISOString()});}
    finally{fs.closeSync(fd);fs.unlinkSync(lock);}
  }
}
function safeError(e) {
  const msg=String(e?.code || e?.message || '');return /^[A-Z][A-Z0-9_]{2,80}$/.test(msg)?msg:'OPERATION_FAILED';
}
async function main(argv=process.argv.slice(2)) {
  const c=config();const [command,to]=argv;
  switch(command) {
    case 'status':return await status(c);
    case 'plan':return (await plan(c,to || 'auto')).public;
    case 'save':return saveAccount(c,to);
    case 'probe': {
      if(to && !['pro','plus'].includes(to))fail('TARGET_REQUIRED');
      const proof=await verifyAccountEgress(c);
      return {network:proof.net.public,countries:proof.countries,requiredCountry:ACCOUNT_COUNTRY,networkChanged:false};
    }
    case 'switch':if(!argv.includes('--execute'))fail('EXECUTE_FLAG_REQUIRED');return await schedule(c,to || 'auto');
    case 'worker':return await worker(c,to);
    default:fail('COMMAND_REQUIRED');
  }
}
if(require.main===module)main().then(x=>{if(x)console.log(JSON.stringify(x,null,2));}).catch(e=>{
  console.error(JSON.stringify({ok:false,error:safeError(e),
    ...(e.nodeRollback?{rollback:e.nodeRollback}:{}),...(e.originalError?{originalError:e.originalError}:{})}));process.exitCode=1;
});
module.exports={scalarConfig,apiRequest,chooseTarget,resolveSavedCredential,saveCurrent,saveAccount,safeError,config,connectClash,inspectAccountNetwork,verifyAccountEgress,traceCountry,privateWrite,acquireOperationLock,assertNoPendingSwitch,plan,status,schedule,worker,main};
