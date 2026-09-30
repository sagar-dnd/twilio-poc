/**
 * Smallest check that fails if route wiring / token shape breaks.
 * Usage:
 *   node scripts/check-server.js          # syntax + module load without listen
 *   node scripts/check-server.js --live   # hit running server on PORT
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const serverFile = path.join(root, 'server', 'index.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function get(port, pathName) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${pathName}`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      })
      .on('error', reject);
  });
}

async function checkSyntax() {
  assert(fs.existsSync(serverFile), 'server/index.js missing');
  assert(fs.existsSync(path.join(root, 'client', 'src', 'useTwilioDevice.js')), 'hook missing');
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--check', serverFile], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`--check exit ${code}`))));
  });
  console.log('ok: syntax');
}

async function checkLive() {
  const port = process.env.PORT || 3001;
  const health = await get(port, '/health');
  assert(health.status === 200, 'health 200');
  const body = JSON.parse(health.data);
  assert(body.ok === true, 'health.ok');

  const token = await get(port, '/token?identity=check-agent');
  if (body.missingEnv?.length) {
    assert(token.status === 500, 'token 500 without env');
    console.log('ok: live health + token guard');
  } else {
    assert(token.status === 200, 'token 200');
    const t = JSON.parse(token.data);
    assert(t.token.split('.').length === 3, 'jwt');
    console.log('ok: live token for', t.identity);
  }
}

async function main() {
  if (process.argv.includes('--live')) {
    await checkLive();
  } else {
    await checkSyntax();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
