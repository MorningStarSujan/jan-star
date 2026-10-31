'use strict';
// Starts the real Worker locally (workerd = the Cloudflare runtime) twice: once normally, once with a short idle limit, then runs the tests.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { totals } = require('./lib');

const root = path.join(__dirname, '..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'jan-star-test-'));
const procs = [];
function start(port, extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 100), '--persist-to', path.join(state, String(port)), ...extra], { cwd: root, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
    procs.push(p); let out = '';
    const on = (d) => { out += d; if (/Ready on/.test(out)) resolve('http://127.0.0.1:' + port); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('exit', () => reject(new Error('wrangler exited early:\n' + out.slice(-1500))));
    setTimeout(() => reject(new Error('wrangler did not start:\n' + out.slice(-1500))), 60000);
  });
}
const stop = () => { procs.forEach((p) => { p.removeAllListeners('exit'); try { process.kill(-p.pid, 'SIGKILL'); } catch { /* already gone */ } }); try { fs.rmSync(state, { recursive: true, force: true }); } catch { /* ignore */ } };

(async () => {
  const only = process.argv[2];
  const base = await start(8811, []);
  const fast = only === 'ui' ? null : await start(8812, ['--var', 'IDLE_MS:3000']);
  setTimeout(() => { console.log('TIMEOUT'); stop(); process.exit(2); }, 240000).unref();
  if (only !== 'ui') await require('./api.test')(base, fast);
  if (only !== 'api') await require('./ui.test')(base);
  const { pass, fail } = totals();
  console.log(`\n${fail ? '✗' : '✓'} ${pass}/${pass + fail} checks passed\n`);
  stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); stop(); process.exit(1); });
