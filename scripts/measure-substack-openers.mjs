#!/usr/bin/env node
// Measure the length of Substack opening paragraphs, through the SAME gate the app applies.
// ([BUG-115]) Every statistic quoted in tasks/BUG-115.md came from this script; without it in the
// repo those numbers rest on an artefact a later reader cannot reproduce.
//
//   node scripts/measure-substack-openers.mjs [host ...]
//
// WHY THE GATE MATTERS. api/feed.js's handleSubstack answers any feed without a <generator>Substack
// tag with a 502, so posts from such a feed can never become a card. A first pass at this measurement
// called parseSubstackFeed directly and reported "max 1456 characters" — that opener belonged to
// Marginal Revolution, a WordPress blog the app cannot add at all. Publications that fail the gate
// are listed as REJECTED and excluded from the statistics.
//
// Network-dependent by nature: it reads live feeds, so the numbers move as publications post. Treat
// a run as a dated sample, not a constant.
import { fetchSubstackXml, substackFeedUrl, isSubstackFeed, capPreview, PREVIEW_CAP } from '../api/_substack.js';

const DEFAULT_HOSTS = [
  'astralcodexten.substack.com', 'newsletter.pragmaticengineer.com', 'www.noahpinion.blog',
  'www.slowboring.com', 'www.honest-broker.com', 'experimentalhistory.substack.com',
  'www.thefp.com', 'garymarcus.substack.com', 'www.construction-physics.com',
];

// The opener exactly as firstParagraph() derives it, minus the cap — so we measure the RAW length
// the cap is applied to. Kept deliberately close to api/_substack.js:firstParagraph.
function rawOpener(contentEncoded) {
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(contentEncoded))) {
    const t = m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (t && !/^read more$/i.test(t)) return t;
  }
  return '';
}

const hosts = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_HOSTS;
const lengths = [];
const accepted = [], rejected = [];

for (const host of hosts) {
  const xml = await fetchSubstackXml(substackFeedUrl(host)).catch(() => null);
  if (!xml) { rejected.push(`${host} (no feed reachable)`); continue; }
  if (!isSubstackFeed(xml)) { rejected.push(`${host} (no <generator>Substack — the app 502s this)`); continue; }
  accepted.push(host);
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const ce = (item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/) || [])[1] || '';
    const t = rawOpener(ce);
    if (t) lengths.push(t);
  }
}

const lens = lengths.map(t => t.length).sort((a, b) => a - b);
const q = f => lens[Math.min(lens.length - 1, Math.floor(f * lens.length))];
const shortened = lengths.filter(t => capPreview(t) !== t).length;

console.log(`ACCEPTED (${accepted.length}): ${accepted.join(', ')}`);
if (rejected.length) console.log(`REJECTED (${rejected.length}): ${rejected.join(' | ')}`);
if (!lens.length) { console.log('\nNo openers measured.'); process.exit(0); }
console.log(`\nRaw opening paragraphs: N=${lens.length}`);
console.log(`  p50 ${q(.5)}   p90 ${q(.9)}   p99 ${q(.99)}   max ${lens[lens.length - 1]}`);
console.log(`\nAt PREVIEW_CAP=${PREVIEW_CAP}: ${shortened} shortened (${Math.round(100 * shortened / lens.length)}%), ` +
            `${lens.length - shortened} untouched (${Math.round(100 * (lens.length - shortened) / lens.length)}%)`);
console.log(`  longest capped result: ${Math.max(...lengths.map(t => capPreview(t).length))} (hard bound ${PREVIEW_CAP})`);
