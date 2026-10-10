// Owner-only analytics dashboard client. Fetches the gated GET /api/state?admin and
// renders the rollups. Access is enforced server-side (ADMIN_EMAIL vs the session email); a 403
// just shows a notice. No framework — matches the app's vanilla/no-build convention.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDateTime = iso => iso ? new Date(iso).toLocaleString(undefined,
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(undefined,
  { month: 'short', day: 'numeric' }) : '—';
const fmtAgo = iso => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
};

const sub = document.getElementById('sub');
const content = document.getElementById('content');
const refreshBtn = document.getElementById('refresh');

async function load() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let r;
  try {
    r = await fetch(`/api/state?admin=1&tz=${encodeURIComponent(tz)}`, { headers: { Accept: 'application/json' } });
  } catch {
    sub.textContent = 'Network error — is the app reachable?';
    return;
  }
  if (r.status === 403) {
    sub.textContent = '';
    content.innerHTML = `<div class="notice">This page is owner-only. Sign in to SousChef with the
      owner account, then reload.<br><br><a href="/">← Back to SousChef</a></div>`;
    return;
  }
  if (!r.ok) { sub.textContent = `Couldn't load stats (${r.status}).`; return; }

  const d = await r.json();
  refreshBtn.hidden = false;
  render(d);
}

function barRows(items, labelOf, valueOf) {
  const max = Math.max(1, ...items.map(valueOf));
  return items.map(it => `
    <div class="bar-row">
      <div class="bar-label">${esc(labelOf(it))}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(valueOf(it) / max * 100).toFixed(1)}%"></div></div>
      <div class="bar-num">${valueOf(it)}</div>
    </div>`).join('');
}

// ── X cost & volume ───────────────────────────────────────────────
// Money is always distinct posts x price; `volume` is the fairness meter and is NEVER priced.
//
// Two decimals throughout. An earlier version used three below $1 and claimed it stopped a real
// 22-cent day rendering as "$0.00" — that was measured false in review: at $0.005/post even ONE
// post is (0.005).toFixed(2) === "0.01", so two decimals can never render a nonzero day as zero.
// What the mixed precision actually did was break decimal alignment in a tabular-nums column.
//
// A missing or unreadable figure reads "—", NOT "$0.00", matching fmtRatio. `Number(n) || 0` used
// to collapse null/NaN into $0.00, which is the exact ambiguity this panel exists to remove: a
// spend readout of zero should mean "nothing was fetched", never "something is broken".
//
// Per-day figures round independently of the total, so the rendered rows can differ from the
// rendered total by a cent. The total is computed from the total post COUNT, not by summing
// rounded rows, so it is the more accurate of the two.
const fmtUsd = n => {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : '—';
};
const fmtRatio = r => (r == null ? '—' : `${Number(r).toFixed(2)}×`);

// The server contains its own rollup failures and answers x:null (api/state.js). This is the
// client half of that same fail-soft: `render` assigns content.innerHTML ONCE for the whole page,
// so a throw anywhere in here would blank the entire dashboard — People, DAU and all — and then
// repeat every 30s via setInterval, silently, because load() is async and uncaught. Today's rollup
// shapes cannot throw; that is a property of the current server output, not of this file.
function xMeterHtml(x) {
  try {
    return renderXMeters(x);
  } catch {
    return X_EMPTY;
  }
}

const X_EMPTY = '<div class="card"><span class="muted">No X meter data yet.</span></div>';

// Deliberately OUTSIDE xMeterHtml/renderXMeters, and that is the whole design: those
// return X_EMPTY the moment there are no meter rows, so a fuse reading placed inside them would
// vanish on a quiet day and whenever a meter query fails — an instrument absent exactly when it is
// needed. This row is the threshold the numbers below are measured against, so it also reads first.
function fuseHtml(f) {
  // An older deployment's response has no `fuse` key at all. Say so, rather than rendering a
  // confident "OFF" that would be indistinguishable from a real unset fuse.
  if (!f || !f.state) {
    return '<div class="card"><span class="muted">Fuse state unavailable \u2014 this deployment predates CHR-074.</span></div>';
  }
  const LABEL = {
    on:         `<strong>${esc(f.limit)} posts</strong> per person per day`,
    unset:      '<strong>OFF</strong> \u2014 not set',
    disabled:   '<strong>OFF</strong> \u2014 explicitly disabled (0)',
    unreadable: '<strong>OFF</strong> \u2014 set, but the value could not be read',
  };
  // A state this file does not know is reported as such rather than silently falling through to a
  // reassuring default. A panel that invents a reading is worse than one that admits confusion.
  const body = LABEL[f.state] || `<strong>OFF</strong> \u2014 unrecognised state ${esc(f.state)}`;
  return `<div class="card">
      <div class="fuse">Daily per-user X fuse: ${body}</div>
      <p class="caveat">This is what the <strong>currently serving deployment</strong> read at
        start-up. Changing the environment variable without redeploying will not move it.</p>
    </div>`;
}

function renderXMeters(x) {
  // An empty panel is what BOTH a quiet day and stopped metering look like, and recordUsage
  // swallows every error by design — so this string is the only symptom a broken meter can produce.
  if (!x || !(x.days || []).length) return X_EMPTY;
  const t = x.totals || {};
  // Newest first everywhere in this panel — the bars, the day table and the per-person table all
  // read the same direction. The two older bar charts on this page run oldest-first; consistency
  // WITHIN a panel wins, because these three surfaces are read against each other.
  const recent = (x.days || []).slice().reverse();
  // esc() on every value that came out of the database, including the numeric ones. They are
  // integers today only because asCount coerces them in api/_analytics.js — a different file, with
  // nothing recording that this markup depends on it. Escaping a number is free.
  const dayRows = recent.map(r => `
    <tr>
      <td>${esc(r.day)}</td>
      <td class="num">${esc(r.posts)}</td>
      <td class="num">${esc(fmtUsd(r.costUsd))}</td>
      <td class="num">${esc(r.volume)}</td>
      <td class="num">${esc(fmtRatio(r.ratio))}</td>
    </tr>`).join('');
  const ownerRows = (x.owners || []).map(o => `
    <tr><td>${esc(o.day)}</td><td>${esc(o.label)}</td><td class="num">${esc(o.posts)}</td></tr>`).join('')
    || `<tr><td colspan="3" class="muted">No per-person volume yet.</td></tr>`;

  return `
    <div class="totals">
      <div class="card"><div class="n">${esc(t.posts || 0)}</div><div class="k">posts fetched</div></div>
      <div class="card"><div class="n">${esc(fmtUsd(t.costUsd))}</div><div class="k">X spend</div></div>
      <div class="card"><div class="n">${esc(t.volume || 0)}</div><div class="k">counted volume</div></div>
      <div class="card"><div class="n">${esc(fmtRatio(t.ratio))}</div><div class="k">dedup ratio</div></div>
    </div>

    <p class="caveat">The dedup ratio is <strong>inflated while BUG-110 is open</strong>: the same
      post is counted once per device, so most of what looks like cross-user overlap is one person
      re-fetching on a second device. Spend (distinct posts × price) is exact and unaffected.</p>

    <h2>Distinct posts fetched per day (UTC) — this is spend</h2>
    <div class="card bars">${barRows(recent, r => r.day, r => r.posts)}</div>

    <div class="card tbl-scroll">
      <table>
        <thead><tr>
          <th>Day (UTC)</th><th class="num">Posts</th><th class="num">Cost</th>
          <th class="num">Volume</th><th class="num">Ratio</th>
        </tr></thead>
        <tbody>${dayRows}</tbody>
      </table>
    </div>

    <h2>Per-person volume (UTC) — fairness, not spend</h2>
    <div class="card tbl-scroll">
      <table>
        <thead><tr><th>Day (UTC)</th><th>Who</th><th class="num">Posts counted</th></tr></thead>
        <tbody>${ownerRows}</tbody>
      </table>
    </div>`;
}

function render(d) {
  const t = d.totals || {};
  sub.textContent = `Times shown in ${d.tz}. ${t.events || 0} events tracked.`;

  const peopleRows = (d.people || []).map(p => `
    <tr>
      <td>${esc(p.email)}</td>
      <td class="num">${p.events}</td>
      <td class="num">${p.signins}</td>
      <td>${esc(fmtDate(p.first_seen))}</td>
      <td>${esc(fmtDateTime(p.last_active))}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="muted">No signed-in activity yet.</td></tr>`;

  const signinRows = (d.recentSignins || []).map(s =>
    `<tr><td>${esc(s.email)}</td><td>${esc(fmtDateTime(s.at))}</td></tr>`).join('')
    || `<tr><td colspan="2" class="muted">No sign-ins yet.</td></tr>`;

  const active = d.activeNow || [];
  const activeList = active.map(p => `
    <div class="active-row">
      <span class="dot"></span>
      <span class="who">${esc(p.who)}</span>
      <span class="ago">${esc(fmtAgo(p.last_active))}</span>
    </div>`).join('') || '<span class="muted">No one active in the last 5 minutes.</span>';

  // Hour-of-day: fill all 24 buckets so the shape is readable even with gaps.
  const hourMap = Object.fromEntries((d.byHour || []).map(h => [h.hour, h.events]));
  const hourMax = Math.max(1, ...Object.values(hourMap));
  const hourBars = Array.from({ length: 24 }, (_, h) =>
    `<div class="hour" style="height:${((hourMap[h] || 0) / hourMax * 100).toFixed(1)}%" title="${h}:00 — ${hourMap[h] || 0}"></div>`).join('');
  const hourAxis = Array.from({ length: 24 }, (_, h) => `<span>${h % 6 === 0 ? h : ''}</span>`).join('');

  content.innerHTML = `
    <div class="live card">
      <div class="live-head">
        <span class="live-dot"></span>
        <strong>${active.length}</strong> active now
        <span class="muted">· last 5 min</span>
      </div>
      <div class="live-list">${activeList}</div>
    </div>

    <div class="totals">
      <div class="card"><div class="n">${t.events || 0}</div><div class="k">events</div></div>
      <div class="card"><div class="n">${t.accounts || 0}</div><div class="k">people</div></div>
      <div class="card"><div class="n">${t.identified || 0}</div><div class="k">identified</div></div>
      <div class="card"><div class="n">${t.anonymous || 0}</div><div class="k">anonymous</div></div>
    </div>

    <h2>X cost &amp; volume (UTC)</h2>
    <p class="muted">Both X meters key on a <strong>UTC</strong> day, while every other panel here
      buckets by ${esc(d.tz)} — for a reader east of UTC these describe different 24-hour windows,
      and the per-post timestamps needed to reconcile them are not kept. Owner included.</p>
    ${fuseHtml(d.fuse)}
    ${xMeterHtml(d.x)}

    <h2>People</h2>
    <div class="card tbl-scroll">
      <table>
        <thead><tr><th>Email</th><th class="num">Events</th><th class="num">Sign-ins</th><th>First seen</th><th>Last active</th></tr></thead>
        <tbody>${peopleRows}</tbody>
      </table>
    </div>

    <h2>Recent sign-ins</h2>
    <div class="card tbl-scroll">
      <table><thead><tr><th>Email</th><th>When</th></tr></thead><tbody>${signinRows}</tbody></table>
    </div>

    <h2>Feature usage</h2>
    <div class="card bars">${barRows(d.eventCounts || [], x => x.name, x => x.count) || '<span class="muted">No events.</span>'}</div>

    <h2>Activity — last 30 days</h2>
    <div class="card bars">${barRows(d.byDay || [], x => fmtDate(x.day + 'T12:00:00'), x => x.events) || '<span class="muted">No activity.</span>'}</div>

    <h2>Daily active users — last 30 days</h2>
    <p class="muted">DAU = distinct active users per day. Active = ≥1 event that day; a user = account (or device if signed-out). Owner/test account excluded.</p>
    <div class="card bars">${barRows(d.dau || [], x => fmtDate(x.day + 'T12:00:00'), x => x.dau) || '<span class="muted">No activity.</span>'}</div>

    <h2>New vs returning</h2>
    <div class="card tbl-scroll">
      <table>
        <thead><tr><th>Day</th><th class="num">New</th><th class="num">Returning</th><th class="num">DAU</th></tr></thead>
        <tbody>${(d.dau || []).map(x => `<tr><td>${esc(fmtDate(x.day + 'T12:00:00'))}</td><td class="num">${x.fresh}</td><td class="num">${x.returning}</td><td class="num">${x.dau}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No activity.</td></tr>'}</tbody>
      </table>
    </div>

    <h2>Time of day (${esc(d.tz)})</h2>
    <div class="card">
      <div class="hours">${hourBars}</div>
      <div class="hour-axis">${hourAxis}</div>
    </div>`;
}

refreshBtn.addEventListener('click', load);
load();
// Keep the "Active now" panel live without a manual refresh.
setInterval(load, 30_000);
