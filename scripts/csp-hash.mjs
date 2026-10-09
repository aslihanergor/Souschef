// Compute the CSP sha256 hash for the inline <head> theme script in app/index.html (TASK-065;
// the app shell moved to /app in TASK-069).
// Run: node scripts/csp-hash.mjs  → prints `sha256-...` to paste into vercel.json's
// Content-Security-Policy `script-src`. Rerun whenever that inline script's bytes change.
//
// The hash must cover the EXACT text between <script> and </script> (leading/trailing
// whitespace included) — that is what the browser hashes. We anchor the match on a stable
// string in the script body so an HTML comment that merely mentions the tag can't fool us.
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');

const m = html.match(/<script>([\s\S]*?Resolve theme[\s\S]*?)<\/script>/);
if (!m) {
  console.error('csp-hash: inline theme <script> not found in app/index.html');
  process.exit(1);
}
const hash = 'sha256-' + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
console.log(hash);
