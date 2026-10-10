// GET /api/substack-post?url=<post-url> — the in-app Substack reader's content endpoint.
//
// Lazily fetched when the user taps "…read more" on a Substack card (the feed itself stays light —
// it only carries a one-paragraph preview). Fetches the post page, pulls the article body out of
// <div class="available-content">, sanitises it server-side (the client injects it via innerHTML),
// and reports whether the post is paywalled. For a free post the body is the whole article; for a
// paywalled one it's the free preview, and the card links out for the rest.
import { fetchSubstackHtml, extractSubstackArticle, stripSubstackAppendix, isPaywalled } from './_substack.js';
import { sanitizeHtml } from './_sanitize.js';
import { isSafePublicHost } from './_hosts.js';

export default async function handler(req, res) {
  const { url } = req.query;

  // SSRF guard: this endpoint fetches a caller-supplied URL, so constrain it hard. https only, a
  // public dotted hostname, no IP-literals / localhost. Below, we only ever return *sanitised
  // article HTML* extracted from a Substack <div class="available-content"> — an internal service
  // won't have one, so nothing useful leaks even if a host slips past. (Cf. handleSubstack.)
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'https:' || !isSafePublicHost(u.hostname)) {
      return res.status(400).json({ error: 'invalid url' });
    }
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  try {
    const html = await fetchSubstackHtml(String(url));
    if (html == null) return res.status(502).json({ error: 'post fetch failed' });

    const article = extractSubstackArticle(html);
    if (article == null) {
      // Not a readable Substack post (or markup changed) — tell the client to just link out.
      return res.status(200).json({ html: null, paywalled: isPaywalled(html) });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    // Prune curated "Other Reading…/On X…" roundup sections before sanitising.
    res.status(200).json({ html: sanitizeHtml(stripSubstackAppendix(article)), paywalled: isPaywalled(html) });
  } catch {
    res.status(502).json({ error: 'post fetch failed' });
  }
}
