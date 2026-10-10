// api/_hosts.js — the one place that decides whether a hostname is safe to fetch server-side.
//
// Before this, the same rule lived in FOUR copies (feed.js, _substack.js — which had none,
// resolve-channel.js, substack-post.js) and they disagreed; that divergence is how _substack.js
// ended up with no guard at all. One source of truth now.
//
// CONTRACT: callers MUST pass a NORMALISED hostname — `new URL(...).hostname`, never a raw user
// string. new URL() collapses 127.1, 0177.0.0.1 and 2130706433 all to 127.0.0.1, so validating the
// normalised form rejects those encodings for free; validating the raw string does not (that was a
// live bypass in feed.js's own guard). What lies beyond a hostname check is deliberately out
// of scope here.

// The host IS youtube.com or a subdomain of it — an EXACT rule, not `endsWith('youtube.com')`
// (which also matched notyoutube.com and let the resolver fetch an attacker host).
export function isYouTubeHost(host) {
  return typeof host === 'string' && (host === 'youtube.com' || host.endsWith('.youtube.com'));
}

// A public, fetchable host: a dotted hostname that is not an IPv4 literal and not localhost. Rejects
// IPv6 literals ([::1]) and bare words too, since neither matches the dotted-hostname shape.
export function isSafePublicHost(host) {
  if (!host || typeof host !== 'string') return false;
  if (!/^[\w-]+(\.[\w-]+)+$/.test(host)) return false; // dotted hostname only
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;  // IPv4 literal (normalised loopback lands here)
  if (/(^|\.)localhost$/i.test(host)) return false;     // localhost / *.localhost
  return true;
}
