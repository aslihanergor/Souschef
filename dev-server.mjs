// Local dev server — the app's own files and /api handlers, routed the way Vercel routes them
// Run: node dev-server.mjs
import http from 'http';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// Response headers from vercel.json so local dev mirrors production's
// security headers — including the CSP, which can only be exercised against real embeds.
// Read fresh each call so editing vercel.json takes effect on the next reload (no restart).
// Vercel applies these to every route; we apply them to static responses, which carry the
// page's Content-Security-Policy.
function vercelHeaders(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const rule = (cfg.headers || []).find(h => h.source === '/(.*)');
    return Object.fromEntries((rule?.headers || []).map(h => [h.key, h.value]));
  } catch { return {}; }
}

// What this server will serve: the app's own files, by name, and nothing else. It used
// to serve any path under this folder that had an extension — `.env.local`, private notes, `tasks/`
// — to any website open in the same browser. A file the app gains must be added here;
// test/dev-server.test.mjs fails when a page references one that is missing.
const STATIC_FILES = new Set([
  'index.html', 'app.js', 'style.css', 'landing.js', 'admin.html', 'admin.js',
  'og-image.png', 'apple-touch-icon.png',
]);
const STATIC_DIRS = new Set(['app', 'privacy', 'lib']);

// Which file, relative to the served folder, a static request is answered from — or null when the
// path is not the app's to serve. The names on the list are matched exactly here; `staticFile`
// below then refuses a file whose real name or location differs from the path asked for, which is
// what stops `/lib/PURE.js` on a file system that ignores capitals.
export function staticFileFor(pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!path.extname(rel)) rel = path.posix.join(rel, 'index.html');
  const segs = rel.split('/');
  if (segs.some((seg) => seg.startsWith('.'))) return null;
  if (!Object.hasOwn(MIME, path.extname(rel))) return null;
  const listed = segs.length === 1 ? STATIC_FILES.has(rel) : STATIC_DIRS.has(segs[0]);
  return listed ? rel : null;
}

// Which addresses the server listens on. This computer only, unless started with
// `--lan` (a handset walk): the /api handlers run with the keys of whoever started the server, and
// every device on the same network could call them. `undefined` is Node's "every interface".
export function listenHosts(argv) {
  return argv.includes('--lan') ? [undefined] : ['127.0.0.1', '::1'];
}

function staticFile(res, root, rel) {
  if (!rel) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(rel);
  try {
    // Serve the file only if it really lives at the path asked for. `realpathSync.native` answers
    // with the name as it is on disk, so this refuses a symlink out of an allowed folder
    // (`app/x.js -> ../secrets.js`) and a different capitalisation (`/lib/PURE.js`) alike.
    const file = path.join(fs.realpathSync.native(root), rel);
    if (fs.realpathSync.native(file) !== file) throw new Error('not where it says it is');
    const data = fs.readFileSync(file);
    // Never cache in dev. Without this the server sends no Cache-Control, no ETag and no
    // Last-Modified, so a browser applies HEURISTIC caching and may serve a stale copy with no way
    // to tell — which is exactly what happened while verifying a fix on a handset: several rounds
    // of "the fix did nothing" against a page that may never have been re-fetched. A dev server
    // that can silently serve yesterday's file is not a dev server.
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
      ...vercelHeaders(root),
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// Minimal req/res adapter so Vercel-style handlers work
function makeReq(req, query, body) {
  return { query, headers: req.headers, method: req.method, body };
}
// Buffer + JSON-parse the request body (Vercel does this for us in prod; the dev
// server must do it so PUT/POST handlers see req.body). Non-JSON → the raw string.
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); } catch { resolve(data); }
    });
    req.on('error', () => resolve(undefined));
  });
}
function makeRes(res) {
  let statusCode = 200;
  const headers = {};
  return {
    status(s) { statusCode = s; return this; },
    setHeader(k, v) { headers[k] = v; },
    json(obj) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    },
    send(body) {
      res.writeHead(statusCode, headers);
      res.end(body);
    },
    // Mirrors Vercel's res.redirect(status, url) so auth/callback works locally.
    redirect(status, location) {
      res.writeHead(status, { ...headers, Location: location });
      res.end();
    },
  };
}

// `root` is the folder served. A test passes a temp folder; the server itself uses this one.
export function createHandler(root = __dir) { return async function handle(req, res) {
  // A request target `new URL` cannot parse (`GET //`) is answered, not thrown: an uncaught error
  // here ends the whole server, and any page can make a browser send one.
  let url;
  try { url = new URL(req.url, `http://localhost:${PORT}`); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  const pathname = url.pathname;

  // No Access-Control-Allow-Origin header, on purpose. The app is same-origin with this
  // server and needs none; `*` let any website read every answer.

  if (pathname.startsWith('/api/')) {
    const query = Object.fromEntries(url.searchParams.entries());
    const name  = pathname.replace('/api/', '').replace(/\/$/, '');
    // `_*.js` are helpers, not handlers: Vercel does not route them, so neither does this.
    if (name.split('/').some((seg) => seg.startsWith('_'))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    try {
      const body = (req.method === 'GET' || req.method === 'HEAD')
        ? undefined : await readBody(req);
      // Resolve the handler file. Exact match first; otherwise fall back to a Vercel-style dynamic
      // route — api/<dir>/[param].js catches /api/<dir>/<segment>, with the segment as query[param].
      let rel = `api/${name}.js`;
      if (!fs.existsSync(path.join(root, rel))) {
        const segs = name.split('/');
        const last = segs.pop();
        const dir  = path.join(root, 'api', ...segs);
        const dyn  = fs.existsSync(dir) && fs.readdirSync(dir).find(f => /^\[[^/\]]+\]\.js$/.test(f));
        if (dyn) {
          query[dyn.slice(1, dyn.indexOf(']'))] = last;
          rel = path.join('api', ...segs, dyn);
        }
      }
      if (!fs.existsSync(path.join(root, rel))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const mod = await import(`${pathToFileURL(path.join(root, rel)).href}?t=${Date.now()}`);
      await mod.default(makeReq(req, query, body), makeRes(res));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files
  staticFile(res, root, staticFileFor(pathname));
}; }

const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

// Every address of this machine at which something already accepts a connection on `port`.
export async function portAnsweredAt(port) {
  const addrs = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).map((a) =>
    (a.family === 'IPv6' && a.address.startsWith('fe80') ? `${a.address}%${name}` : a.address)));
  const tries = await Promise.all([...new Set(addrs)].map((host) => new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (answered) => { socket.destroy(); resolve(answered ? host : null); };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  })));
  return tries.filter(Boolean);
}

async function main() {
  // Load local secrets (e.g. YOUTUBE_API_KEY) into process.env for /api handlers.
  // Optional: the API path falls back to keyless scraping when it's absent. On
  // Vercel this file isn't used — env vars come from the dashboard.
  try { process.loadEnvFile(path.join(__dir, '.env')); } catch {}

  const hosts = listenHosts(process.argv.slice(2));
  const lan = hosts.includes(undefined);

  // Refuse to start beside another server on this port. Two can share it when one holds every
  // interface and the other only this computer's: this one would then print "this computer only"
  // while the other — an older dev server left running, say — kept answering the network.
  const taken = await portAnsweredAt(PORT);
  if (taken.length) {
    console.error(`✗ port ${PORT} is already answered at ${taken.join(', ')} by another process. Stop it, then start again.`);
    process.exit(1);
  }
  const up = await Promise.all(hosts.map((host) => new Promise((resolve) => {
    const server = http.createServer(createHandler());
    server.once('error', (e) => resolve(e));
    server.listen(PORT, host, () => resolve(null));
  })));
  // The only failure that is not fatal: no IPv6 on this machine, so there is no ::1 to listen on.
  const failed = up.filter((e, i) => e && !(hosts[i] === '::1' && NO_IPV6.has(e.code)));
  if (failed.length || up.every(Boolean)) {
    console.error(`✗ could not listen on port ${PORT}: ${(failed[0] || up[0]).message}`);
    process.exit(1);
  }
  console.log(`Focus dev server → http://localhost:${PORT}`);
  console.log(lan
    ? 'Net → open to your network (--lan). Anyone on it can use this server.'
    : 'Net → this computer only. For a handset walk, start with --lan.');

  // Say which database this dev server writes to. `vercel env pull` writes the Neon
  // integration's DATABASE_URL, which is the production one — so "localhost" has never implied
  // "a safe database", and nothing here used to say so.
  const { dbHost, isProductionDb, resolveDatabaseUrl } = await import('./api/_db.js');
  const url = resolveDatabaseUrl();
  if (!url) {
    console.log('DB  → none (no DATABASE_URL) — /api/state will 503, app stays on localStorage');
  } else if (isProductionDb(url)) {
    console.log(`DB  → ${dbHost(url)}`);
    console.log('    ⚠️  THIS IS PRODUCTION. Local writes hit real users\' rows. Point DATABASE_URL at a dev branch.');
  } else {
    console.log(`DB  → ${dbHost(url)}  (non-production)`);
  }
}

// Start only when run directly (`node dev-server.mjs`), so a test can import the functions above
// without opening a port or loading `.env` into its own process.
function isRunDirectly() {
  // `argv[1]` need not be a file at all (`node -e '…' some-word`), and realpath throws on that.
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isRunDirectly()) main();
