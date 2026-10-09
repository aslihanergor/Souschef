// dev-server.mjs: what it serves, to whom, and on which addresses ([BUG-131]).
//
// The dev server used to serve any file under the repo root that had an extension, with
// `Access-Control-Allow-Origin: *`, on every network interface. So while it ran, any website open in
// the same browser — and any device on the same network — could read `.env.local`, `Users.md` or
// `tasks/*.md`. Reproduced against a running server on 2026-10-08 (table in tasks/BUG-131.md).
//
// Three tiers here, because each one can be wrong while the others are right:
//   1. the two decisions as functions (`staticFileFor`, `listenHosts`);
//   2. the real request handler over real HTTP — against a TEMP folder holding planted private
//      files, so "404" is never vacuous on a checkout that happens not to have `Users.md`, and
//      against the real repo root for the files the app needs;
//   3. `node dev-server.mjs` as a child process, because a wrong "run directly" check would leave
//      every test above green while the command itself did nothing.
//
// NOT PINNED, knowingly: that the started server loads `.env` (it needs a real one beside the file,
// which a clean checkout does not have); the failure branch after `listen` (the check before it
// refuses first, so only a race reaches it); and a non-numeric `PORT`, which falls back to 3000.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticFileFor, listenHosts, createHandler } from '../dev-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'dev-server.mjs');

// The handlers below must see no database, whatever this shell exports: c10 pins the answer of a
// real handler, and that answer depends on it.
delete process.env.DATABASE_URL;
delete process.env.DEV_DATABASE_URL;

// ── 1. The decisions ────────────────────────────────────────────────────────────────────────────

// Every path here was served before the fix, or would have been had the file existed.
const PRIVATE = [
  '/.env.local', '/.env.development.local', '/.env.bug131probe', '/.env',
  '/Users.md', '/MEETINGS.md', '/INTERVIEWS.md', '/CLAUDE.md', '/README.md', '/CHANGELOG.md',
  '/TASK-REGISTRY.md', '/tasks/BUG-055.md', '/recaps/RECAP-REGISTRY.md', '/docs/architecture.md',
  '/package.json', '/package-lock.json', '/vercel.json', '/dev-server.mjs',
  '/test/docs.test.mjs', '/test/fixtures/videos.json', '/test-helpers/handler.mjs',
  '/scripts/init-db.mjs', '/mutations/CHR-080.mjs', '/mockups/index.html',
  '/node_modules/@neondatabase/serverless/index.js',
  '/.git/config', '/.git/HEAD', '/.claude/settings.json', '/.vercel/project.json',
  '/.githooks/pre-commit', '/.github/workflows/test.yml',
  // An allowed folder's name deeper in the path, or as a file, earns nothing.
  '/test/lib/pure.js', '/mockups/app/index.html', '/scripts/app/tool.js', '/app.js/x.js',
  // A private folder holding a file of a served type: refused by the folder, not by the type.
  '/tasks/x.js', '/recaps/x.html', '/docs/index.html', '/test/x.js', '/api/feed.js',
];

test('BUG-131 a1: no private path resolves to a file', () => {
  for (const p of PRIVATE) assert.equal(staticFileFor(p), null, `${p} must not be served`);
});

test('BUG-131 a2: every path the app needs resolves to its file', () => {
  const SERVED = {
    '/': 'index.html',
    '/app': 'app/index.html',
    '/app/': 'app/index.html',
    '/app/index.html': 'app/index.html',
    '/privacy': 'privacy/index.html',
    '/app.js': 'app.js',
    '/style.css': 'style.css',
    '/landing.js': 'landing.js',
    '/lib/pure.js': 'lib/pure.js',
    '/admin.html': 'admin.html',
    '/admin.js': 'admin.js',
    '/og-image.png': 'og-image.png',
    '/apple-touch-icon.png': 'apple-touch-icon.png',
  };
  for (const [p, rel] of Object.entries(SERVED)) assert.equal(staticFileFor(p), rel, p);
});

// Every same-site path a page's `src` and `href` attributes ask for: absolute or relative, in
// either kind of quote. Another site, `data:`, `mailto:` and a bare `#anchor` are not ours to serve.
const PAGES = { 'index.html': '/', 'app/index.html': '/app/', 'privacy/index.html': '/privacy/', 'admin.html': '/admin.html' };
function localRefs(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const ref = m[1] ?? m[2];
    if (!ref || ref.startsWith('#') || ref.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
    const p = new URL(ref, `http://x${pageUrl}`).pathname;
    if (!p.startsWith('/api/') && !p.startsWith('/_vercel/')) out.push(p);
  }
  return out;
}

test('BUG-131 a3b: the reference finder sees relative and single-quoted references too', () => {
  const html = `<script src="extra.js"></script><link href='/style.css'><a href="#top"></a>
    <img src="https://example.com/x.png"><a href="mailto:a@example.com"></a><script src="../lib/pure.js"></script>`;
  assert.equal(localRefs(html, '/privacy/').join(' '), '/privacy/extra.js /style.css /lib/pure.js');
});

test('BUG-131 a3: every local file the four pages ask for is on the list, and exists', () => {
  // The guard against the list drifting: a page that gains a script the list does not name would
  // work on Vercel and 404 here. `/api/...` is a handler and `/_vercel/...` exists only on Vercel.
  const asked = new Set(['/lib/pure.js']); // app.js's own import, which no page names
  for (const [page, url] of Object.entries(PAGES)) {
    for (const p of localRefs(readFileSync(join(ROOT, page), 'utf8'), url)) asked.add(p);
  }
  assert.ok(asked.size >= 8, `expected the pages to reference at least 8 local paths, saw ${asked.size}`);
  for (const p of asked) {
    const rel = staticFileFor(p);
    assert.notEqual(rel, null, `${p} is referenced by a page but is not on the dev server's list`);
    assert.ok(existsSync(join(ROOT, rel)), `${p} resolves to ${rel}, which does not exist`);
  }
});

test('BUG-131 a4: the names on the list are matched exactly', () => {
  // The Mac's file system ignores capitals, so `/USERS.MD` read `Users.md` before the fix. A
  // different capitalisation of a file INSIDE an allowed folder is c8's, against real files.
  for (const p of ['/APP.JS', '/Index.html', '/INDEX.HTML', '/App/index.html', '/LIB/pure.js', '/lib/PURE.JS', '/USERS.MD']) {
    assert.equal(staticFileFor(p), null, p);
  }
});

test('BUG-131 a5: inside an allowed folder, only the served file types', () => {
  for (const p of ['/lib/notes.md', '/app/data.json', '/app/.env.local', '/lib/.env', '/privacy/dump.sql', '/lib/pure.mjs']) {
    assert.equal(staticFileFor(p), null, p);
  }
});

test('BUG-131 a5b: a dotfile or dot-folder is refused even with a served file type', () => {
  for (const p of ['/app/.secret.js', '/lib/.cache/x.js', '/.hidden/index.html', '/app/.index.html']) {
    assert.equal(staticFileFor(p), null, p);
  }
});

test('BUG-131 a6: a top-level file that is not named is not served, whatever its type', () => {
  for (const p of ['/secrets.js', '/notes.html', '/backup.css', '/photo.png']) {
    assert.equal(staticFileFor(p), null, p);
  }
});

test('BUG-131 b1: started plainly, the server listens on this computer only', () => {
  const hosts = listenHosts([]);
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0], '127.0.0.1');
  assert.equal(hosts[1], '::1');
});

test('BUG-131 b2: --lan opens it to the network, and only that exact flag does', () => {
  const lan = listenHosts(['--lan']);
  assert.equal(lan.length, 1);
  assert.equal(lan[0], undefined);
  assert.equal(listenHosts(['--lanx'])[0], '127.0.0.1');
  assert.equal(listenHosts(['lan'])[0], '127.0.0.1');
});

// ── 2. The real handler over real HTTP ──────────────────────────────────────────────────────────

const SECRET = 'PROBE_SECRET=bug131-dummy-not-a-real-key';
let tmp, fake, real;

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
const get = (base, p) => fetch(base + p, { headers: { Origin: 'https://evil.example' } });

before(async () => {
  tmp = mkdtempSync(join(os.tmpdir(), 'bug131-'));
  for (const d of ['app', 'lib', 'api', 'tasks', 'scripts']) mkdirSync(join(tmp, d));
  writeFileSync(join(tmp, 'lib', 'pure.js'), 'export const pure = 1;');
  // Links out of an allowed folder, each with a served file type.
  symlinkSync('../secrets.js', join(tmp, 'app', 'linkfile.js'));
  symlinkSync('../.env.local', join(tmp, 'lib', 'env.html'));
  symlinkSync('..', join(tmp, 'app', 'linkdir'));
  writeFileSync(join(tmp, 'api', '_helper.js'), 'export default (req, res) => res.status(200).json({ ran: true });');
  writeFileSync(join(tmp, 'api', 'boom.js'), 'export default () => { throw new Error("boom"); };');
  writeFileSync(join(tmp, 'api', 'send.js'), 'export default (req, res) => res.status(200).send("sent");');
  writeFileSync(join(tmp, 'app', '.secret.js'), SECRET);
  writeFileSync(join(tmp, 'scripts', 'tool.js'), SECRET);
  writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
  writeFileSync(join(tmp, '.env.local'), SECRET);
  writeFileSync(join(tmp, '.env.development.local'), SECRET);
  writeFileSync(join(tmp, 'Users.md'), SECRET);
  writeFileSync(join(tmp, 'secrets.js'), SECRET);
  writeFileSync(join(tmp, 'tasks', 'BUG-055.md'), SECRET);
  writeFileSync(join(tmp, 'app', '.env.local'), SECRET);
  writeFileSync(join(tmp, 'lib', 'notes.md'), SECRET);
  writeFileSync(join(tmp, 'app.js'), 'console.log("app")');
  writeFileSync(join(tmp, 'app', 'index.html'), '<p>app</p>');
  writeFileSync(join(tmp, 'api', 'ping.js'), 'export default (req, res) => res.status(200).json({ ok: true });');
  fake = await serve(createHandler(tmp));
  real = await serve(createHandler());
});

after(() => {
  fake?.s.close();
  real?.s.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('BUG-131 c1: planted private files answer 404 and their bytes never leave', async () => {
  const paths = ['/.env.local', '/.env.development.local', '/Users.md', '/USERS.MD', '/secrets.js',
    '/tasks/BUG-055.md', '/package.json', '/app/.env.local', '/lib/notes.md',
    '/app/.secret.js', '/scripts/tool.js'];
  for (const p of paths) {
    const r = await get(fake.base, p);
    const body = await r.text();
    assert.equal(r.status, 404, `${p} answered ${r.status}`);
    assert.ok(!body.includes('bug131-dummy'), `${p} leaked the planted file`);
  }
});

test('BUG-131 c2: the same folder still serves its app files, byte for byte', async () => {
  const a = await get(fake.base, '/app.js');
  assert.equal(a.status, 200);
  assert.equal(await a.text(), 'console.log("app")');
  const b = await get(fake.base, '/app');
  assert.equal(b.status, 200);
  assert.equal(await b.text(), '<p>app</p>');
});

test('BUG-131 c3: no response says another website may read it', async () => {
  // One row per way the handler can answer; the status proves the row took the path it names.
  const rows = [
    ['/app.js', 200],      // a served file
    ['/Users.md', 404],    // a refused path
    ['/style.css', 404],   // on the list, missing from this folder
    ['/api/ping', 200],    // a handler answering with json()
    ['/api/send', 200],    // a handler answering with send()
    ['/api/boom', 500],    // a handler that throws
    ['/api/nope', 404],    // no handler
    ['/api/_helper', 404], // a helper file
  ];
  for (const [p, status] of rows) {
    const r = await get(fake.base, p);
    await r.text();
    assert.equal(r.status, status, `${p} answered ${r.status}`);
    assert.equal(r.headers.get('access-control-allow-origin'), null, `${p} carries the header`);
  }
});

test('BUG-131 c4: an API handler still runs', async () => {
  const r = await get(fake.base, '/api/ping');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"ok":true}');
});

test('BUG-131 c5: a path under /api with no handler is a 404 that names no file', async () => {
  for (const p of ['/api/nope', '/api/ping.js', '/api/_db.js', '/api/_helper', '/api/.hidden']) {
    const r = await get(fake.base, p);
    const body = await r.text();
    assert.equal(r.status, 404, `${p} answered ${r.status}`);
    assert.ok(!body.includes(tmp), `${p} printed the folder it was looked for in`);
    assert.ok(!body.includes('ran'), `${p} ran a helper file as a handler`);
  }
});

test('BUG-131 c6: the real repo serves the app\'s files byte for byte', async () => {
  const files = APP_FILES;
  for (const [p, rel] of Object.entries(files)) {
    const r = await get(real.base, p);
    assert.equal(r.status, 200, `${p} answered ${r.status}`);
    const sent = Buffer.from(await r.arrayBuffer());
    assert.ok(sent.equals(readFileSync(join(ROOT, rel))), `${p} is not byte-identical to ${rel}`);
  }
});

test('BUG-131 c7: the real repo refuses files that exist beside the server', async () => {
  // Each of these exists in every checkout once `npm install` has run, the public copy included, so
  // a 404 here is the refusal.
  // The last is a `.js`, a type this server does serve: it is refused by the list of names alone,
  // where the others would also be stopped by their file type.
  for (const p of ['/package.json', '/dev-server.mjs', '/test/docs.test.mjs', '/vercel.json', '/api/_db.js',
    '/node_modules/@neondatabase/serverless/index.js']) {
    assert.ok(existsSync(join(ROOT, p)), `${p} should exist for this test to mean anything`);
    const r = await get(real.base, p);
    await r.text();
    assert.equal(r.status, 404, `${p} answered ${r.status}`);
  }
});

test('BUG-131 c8: a file is served only from where its path says, under its own name', async () => {
  // Links out of an allowed folder, and (on a file system that ignores capitals) another spelling
  // of a real file. All were served before the review fix; the first three leaked the planted file.
  for (const p of ['/app/linkfile.js', '/lib/env.html', '/app/linkdir/secrets.js', '/app/linkdir/app.js',
    '/app/INDEX.html', '/app/Index.html', '/lib/Pure.js', '/lib/PURE.js']) {
    const r = await get(fake.base, p);
    const body = await r.text();
    assert.equal(r.status, 404, `${p} answered ${r.status}`);
    assert.ok(!body.includes('bug131-dummy'), `${p} leaked the planted file`);
  }
  const ok = await get(fake.base, '/lib/pure.js');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'export const pure = 1;');
});

// One request line exactly as written — `fetch` would tidy `..` and `//` away before sending.
function raw(base, target) {
  return new Promise((resolve) => {
    const { port } = new URL(base);
    const sock = net.connect(Number(port), '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    let data = '';
    sock.setTimeout(3000, () => { sock.destroy(); resolve('timeout'); });
    sock.on('data', (d) => { data += d; });
    sock.on('close', () => resolve(data || 'closed without an answer'));
    sock.on('error', () => resolve('socket error'));
  });
}

test('BUG-131 c9: dot-dot written on the wire does not reach a private file', async () => {
  for (const target of ['/app/../.env.local', '/lib/../Users.md', '/app/../secrets.js', '/app/%2e%2e/secrets.js']) {
    const answer = await raw(fake.base, target);
    assert.match(answer, /^HTTP\/1\.1 404 /, `${target} answered: ${answer.slice(0, 40)}`);
    assert.ok(!answer.includes('bug131-dummy'), `${target} leaked the planted file`);
  }
});

test('BUG-131 c9b: a request target that cannot be parsed is a 400, and the server lives', async () => {
  assert.match(await raw(fake.base, '//'), /^HTTP\/1\.1 400 /);
  const after = await get(fake.base, '/app.js');
  assert.equal(after.status, 200);
});

test('BUG-131 c10: a real handler answers as it did before the change', async () => {
  // Criterion 6. With no database configured, /api/auth/me cannot check a session.
  const r = await get(real.base, '/api/auth/me');
  assert.equal(r.status, 503);
  assert.equal(await r.text(), '{"error":"auth unavailable"}');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

// ── 3. The command itself ───────────────────────────────────────────────────────────────────────

test('BUG-131 d1: importing dev-server.mjs opens no port and loads no .env', () => {
  // A child process, so the check is on a process that did nothing else. If the import started a
  // server the child would never exit and the timeout fails the test. On a checkout with no `.env`
  // the second half cannot fail; the first half always can.
  //
  // The child gets a BARE environment, not this process's. This file imports dev-server.mjs too, so
  // if importing loaded `.env` this process would already hold those keys, the child would inherit
  // them, and it would report "unchanged" — which is how the first version of this test passed with
  // the defect in place (mutation M19 survived it).
  const code = `const before = JSON.stringify(process.env);
    await import(${JSON.stringify(SERVER)});
    console.log(JSON.stringify(process.env) === before ? 'env-unchanged' : 'env-changed');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, `the importing process did not exit cleanly: ${r.signal || r.stderr}`);
  assert.equal(r.stdout.trim(), 'env-unchanged');
});

test('BUG-131 d2: importing it works when the process was not started from a file', () => {
  // `node -e '…' some-word` puts `some-word` where the script path usually is.
  const code = `await import(${JSON.stringify(SERVER)}); console.log('imported');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, 'not-a-file'], { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr.slice(0, 200));
  assert.equal(r.stdout.trim(), 'imported');
});

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
const hasIPv6Loopback = () => Object.values(os.networkInterfaces()).some((list) => (list || []).some((a) => a.address === '::1'));

// Run `node <script> [args]` on `port` from ANOTHER folder — the server must serve its own folder,
// not the one it was started in — and settle when it prints its first line or exits.
function run(args, port, script = SERVER) {
  const child = spawn(process.execPath, [script, ...args], { cwd: os.tmpdir(), env: { ...process.env, PORT: String(port) } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev-server.mjs printed nothing in 10s: ${out}`)), 10000);
    child.stdout.on('data', () => { if (out.includes('dev server')) { clearTimeout(timer); resolve(); } });
    exited.then((code) => { clearTimeout(timer); reject(new Error(`dev-server.mjs exited (${code}) before listening: ${out}`)); });
  });
  listening.catch(() => {});
  return { port, listening, exited, out: () => out, stop: () => { child.kill(); return exited; } };
}
async function start(args, script) {
  const srv = run(args, await freePort(), script);
  await srv.listening;
  return srv;
}
// How a process that should refuse to start ended: its exit code, or 'still running' after 8 s —
// in which case it is stopped here. A bare `await srv.exited` would hang the whole suite on exactly
// the defect these tests exist for (it did, the first time they were run against the old code).
async function exitOf(srv) {
  let timer;
  const code = await Promise.race([srv.exited, new Promise((resolve) => { timer = setTimeout(() => resolve('still running'), 8000); })]);
  clearTimeout(timer);
  if (code === 'still running') await srv.stop();
  return code;
}

// 200/404/… when something answered; 'refused' ONLY when the connection was refused. A timeout or
// an unreachable network is reported as itself, so it cannot pass for a refusal.
const reachable = (url) => fetch(url, { signal: AbortSignal.timeout(3000) }).then(
  (r) => r.text().then(() => r.status),
  (e) => (e.cause?.code === 'ECONNREFUSED' ? 'refused' : `failed: ${e.cause?.code || e.name}`),
);

const APP_FILES = {
  '/': 'index.html', '/app': 'app/index.html', '/privacy': 'privacy/index.html',
  '/app.js': 'app.js', '/style.css': 'style.css', '/landing.js': 'landing.js',
  '/lib/pure.js': 'lib/pure.js', '/admin.html': 'admin.html', '/admin.js': 'admin.js',
  '/og-image.png': 'og-image.png', '/apple-touch-icon.png': 'apple-touch-icon.png',
};

test('BUG-131 e1: run directly, it serves every app file byte for byte and refuses a private one', async () => {
  const srv = await start([]);
  try {
    for (const [p, rel] of Object.entries(APP_FILES)) {
      const r = await fetch(`http://127.0.0.1:${srv.port}${p}`);
      assert.equal(r.status, 200, `${p} answered ${r.status}`);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(ROOT, rel))), `${p} is not byte-identical to ${rel}`);
    }
    assert.equal(await reachable(`http://127.0.0.1:${srv.port}/package.json`), 404);
  } finally { await srv.stop(); }
});

test('BUG-131 e1b: run directly, both loopback addresses answer', async (t) => {
  // `localhost` may mean either, and a client that only tries ::1 gets nothing from a server that
  // listens on 127.0.0.1 alone. Each address is asked by number, so neither can stand in for the other.
  if (!hasIPv6Loopback()) return t.skip('this machine has no ::1');
  const srv = await start([]);
  try {
    assert.equal(await reachable(`http://127.0.0.1:${srv.port}/privacy`), 200);
    assert.equal(await reachable(`http://[::1]:${srv.port}/privacy`), 200);
  } finally { await srv.stop(); }
});

test('BUG-131 e2: run directly without --lan, the network address is refused', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip('this machine has no network address to test against');
  const srv = await start([]);
  try {
    assert.equal(await reachable(`http://${ip}:${srv.port}/privacy`), 'refused');
    assert.match(srv.out(), /this computer only/);
  } finally { await srv.stop(); }
});

test('BUG-131 e3: with --lan, the network address answers', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip('this machine has no network address to test against');
  const srv = await start(['--lan']);
  try {
    assert.equal(await reachable(`http://${ip}:${srv.port}/privacy`), 200);
    assert.equal(await reachable(`http://${ip}:${srv.port}/package.json`), 404);
    assert.match(srv.out(), /open to your network/);
  } finally { await srv.stop(); }
});

test('BUG-131 e4: it will not start beside a server that already answers the network on that port', async () => {
  // Review finding 1. Two servers can share a port when one holds every interface and the other
  // only this computer's; the second then printed "this computer only" while the first — an older
  // dev server left running — kept answering the network.
  const first = await start(['--lan']);
  try {
    const second = run([], first.port);
    assert.equal(await exitOf(second), 1, second.out());
    assert.match(second.out(), /already answered/);
    assert.doesNotMatch(second.out(), /this computer only/);
  } finally { await first.stop(); }
});

test('BUG-131 e5: nor the other way round, --lan beside a server on this computer only', async () => {
  const first = await start([]);
  try {
    const second = run(['--lan'], first.port);
    assert.equal(await exitOf(second), 1, second.out());
    assert.match(second.out(), /already answered/);
    assert.doesNotMatch(second.out(), /open to your network/);
  } finally { await first.stop(); }
});

test('BUG-131 e6: nor when another program holds just one of the two loopback addresses', async () => {
  const port = await freePort();
  const other = http.createServer((req, res) => res.end('someone else'));
  await new Promise((resolve) => other.listen(port, '127.0.0.1', resolve));
  try {
    const srv = run([], port);
    assert.equal(await exitOf(srv), 1, srv.out());
    assert.match(srv.out(), /already answered at 127\.0\.0\.1/);
  } finally { await new Promise((resolve) => other.close(resolve)); }
});

test('BUG-131 e6b: nor when something answers on the network address alone', async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip('this machine has no network address to test against');
  const port = await freePort();
  const other = http.createServer((req, res) => res.end('someone else'));
  await new Promise((resolve) => other.listen(port, ip, resolve));
  try {
    const srv = run([], port);
    assert.equal(await exitOf(srv), 1, srv.out());
    assert.match(srv.out(), /already answered/);
  } finally { await new Promise((resolve) => other.close(resolve)); }
});

test('BUG-131 e7: started through a symlink to the file, it still starts and serves its own folder', async () => {
  const link = join(tmp, 'linked-server.mjs');
  symlinkSync(SERVER, link);
  const srv = await start([], link);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/app.js`);
    assert.equal(r.status, 200);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(ROOT, 'app.js'))));
  } finally { await srv.stop(); }
});
