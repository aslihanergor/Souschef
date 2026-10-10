// Server-side HTML sanitizer for remote article HTML (Substack reader).
//
// The reader fetches a Substack post's HTML and injects it into the page via innerHTML, so this
// module is the trust boundary. There is no build step and no dependencies (vanilla, zero-dep),
// so we can't use DOMPurify/sanitize-html — this is a hand-rolled, allowlist-based sanitizer that
// runs on the server and returns a string the client can trust.
//
// Strategy: (1) strip comments, (2) remove dangerous elements *with their content*, (3) scan the
// remaining tags — keep allowlisted tags (attributes stripped, except a/img which are rewritten to
// a safe form), unwrap everything else (drop the tag, keep the text), and escape any '<' that does
// not begin a fully parseable tag, (4) a belt-and-braces pass to kill any leftover event handler /
// javascript: URL.
//
// Step 3 fails CLOSED: anything the tokenizer cannot parse becomes visible text rather than markup.
// Step 4 is genuinely redundant and must stay that way — when it was the only thing catching
// malformed tags, a quote-glued handler defeated it.

// Elements removed entirely, content and all — never safe to surface.
const REMOVE_WITH_CONTENT = [
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'template',
  'form', 'input', 'select', 'textarea', 'button', 'audio', 'video', 'canvas', 'head',
  'title', 'link', 'meta', 'base',
];

// Tags we keep (attributes stripped unless listed below). Anything not here is unwrapped.
const ALLOWED = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sup', 'sub', 'mark', 'small',
  'a', 'img', 'figure', 'figcaption',
]);

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getAttr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

// A safe href for <a>: absolute http(s) only. Fragments, relative paths, javascript:, data: → null.
function safeHref(url) {
  if (!url) return null;
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : null;
}

// A safe <img> src: https only (an http image would be blocked as mixed content on our https site
// anyway, and data: URIs are an XSS vector we don't need).
function safeImg(url) {
  if (!url) return null;
  const u = url.trim();
  return /^https:\/\//i.test(u) ? u : null;
}

function openTag(name, attrs) {
  if (name === 'a') {
    const href = safeHref(getAttr(attrs, 'href'));
    return href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener nofollow">`
      : '<a>'; // unsafe/missing href → bare, non-clickable anchor (text preserved)
  }
  if (name === 'img') {
    const src = safeImg(getAttr(attrs, 'src'));
    if (!src) return ''; // drop images we can't safely load
    const alt = esc(getAttr(attrs, 'alt') || '');
    return `<img src="${esc(src)}" alt="${alt}" loading="lazy">`;
  }
  return `<${name}>`; // ordinary allowed tag — strip every attribute
}

export function sanitizeHtml(input) {
  if (!input || typeof input !== 'string') return '';
  let html = input;

  // 1. comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 2. dangerous elements, content included
  for (const tag of REMOVE_WITH_CONTENT) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '');
    html = html.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), ''); // stray/self-closing openers
  }

  // 3. Scan the remaining tags left to right. The attribute run is matched quote-aware ("…"/'…'
  //    consumed whole) so a '>' *inside* a quoted value can't end the tag early and spill the rest
  //    as text — that was the Substack tweet-embed JSON leak.
  //
  //    This is a SCAN, not a replace, and the difference is the security property. At every '<' the
  //    tokenizer is tried ANCHORED at that position (sticky flag). A match is allow-listed and
  //    cleaned as before. A NON-match means the tag could not be fully parsed — most often an
  //    unbalanced quote — and such a tag is neither allow-listed nor removed, so a plain replace
  //    left it in the output as live markup. Escaping the '<' makes it visible text instead: the
  //    sanitizer fails CLOSED. Leaving it in was a zero-click XSS, because step 4 below only
  //    strips a handler preceded by whitespace and a quote-glued one slipped past both layers.
  //
  //    Text between tags is copied verbatim, never re-escaped, so existing entities (&amp;, &lt;)
  //    survive a round trip unchanged.
  const TAG_RE = /<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b((?:"[^"]*"|'[^']*'|[^"'>])*)>/y;
  let out = '';
  let i = 0;
  for (;;) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      out += '&lt;';      // unparseable — emit as text and resume just after it
      i = lt + 1;
      continue;
    }
    const name = m[2].toLowerCase();
    if (!ALLOWED.has(name)) out += '';                 // unwrap unknown tag (keep inner text)
    else if (m[1]) out += `</${name}>`;
    else out += openTag(name, m[3]);
    i = lt + m[0].length;
  }
  html = out;

  // 4. belt-and-braces: nothing above should let these through, but strip any residue
  html = html
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');

  return html.trim();
}
