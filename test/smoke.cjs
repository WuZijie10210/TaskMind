const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const port = 38921;
const child = spawn(process.execPath, ['app/server.js'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 5000);
child.stdout.once('data', async () => {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const page = await fetch(`http://127.0.0.1:${port}/about`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TaskMind/);
    const missing = await fetch(`http://127.0.0.1:${port}/api/missing`);
    assert.equal(missing.status, 404);
    console.log('HTTP smoke PASS');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { clearTimeout(timer); child.kill(); }
});
child.on('error', (e) => { clearTimeout(timer); console.error(e); process.exitCode = 1; });
