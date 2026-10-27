'use strict';

// A credential-free process fixture. It only writes markers inside its own
// temporary test directory; it never loads account-switch configuration.
const fs = require('node:fs');
const path = require('node:path');

if (process.argv[2] !== 'worker') process.exit(2);
const configFile = path.resolve(process.argv[3]);
const settings = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
const directory = path.dirname(configFile);
if (!path.basename(directory).startsWith('codex-switch-win-test-')) process.exit(2);
if (!['old', 'new', 'sleep'].includes(settings.role)) process.exit(2);

const output = name => path.join(directory, settings.role + '-' + name);
const metadata = {
  pid: process.pid,
  codexHome: process.env.CODEX_HOME || null,
  apiKeyInherited: Object.hasOwn(process.env, 'OPENAI_API_KEY'),
  nodeOptionsInherited: Object.hasOwn(process.env, 'NODE_OPTIONS'),
  sessionMarkerInherited: Object.hasOwn(process.env, 'CODEX_TEST_SESSION_MARKER')
};
fs.writeFileSync(output('ready.json'), JSON.stringify(metadata));
const watchdog = setTimeout(() => process.exit(3), 30000);
if (settings.role !== 'sleep') {
  const poll = setInterval(() => {
    if (!fs.existsSync(path.join(directory, 'release.txt'))) return;
    clearInterval(poll);
    setTimeout(() => {
      fs.writeFileSync(output('finished.json'), JSON.stringify({pid: process.pid, completed: true}));
      clearTimeout(watchdog);
    }, 150);
  }, 25);
}
