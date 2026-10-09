/* Landing hero: the scroll-driven dot story (TASK-091).
 *
 * Lifted from mockups/landing-redesign/souschef-landing-concept.html, which is a working prototype
 * rather than a mockup — the beat timings, the bloom sprite and the per-dot stagger are its code,
 * kept deliberately close so the two stay comparable.
 *
 * WHY THIS IS AN EXTERNAL FILE, not the inline <script> the prototype uses: vercel.json sets
 *   script-src 'self' '<sha256 of the app's theme script>'
 * with no 'unsafe-inline'. An inline script here is blocked by the browser — the page renders, the
 * copy reads, and the stage is a dead black rectangle. Pinned by test/public-landing.test.mjs.
 *
 * WHY IT SITS AT THE END OF <body>: the CSS defaults are the readable, no-JavaScript state
 * (headline lit, CTA visible), so that a visitor whose script is blocked or 404s still gets a
 * legible page. This script's first act is to take that back over, and it can only do so once the
 * markup it drives exists — which, last in <body>, it does.
 *
 * `defer` is omitted rather than forbidden. An earlier version of this comment claimed defer would
 * make "every visitor see a flash of the fallback state"; that was asserted, never measured, and a
 * reviewer was right that it does not follow — for a script that is already the last element in
 * <body>, defer changes almost nothing about when it runs.
 *
 * The five beats, and why each is shaped as it is, are documented in the brief that ships with the
 * prototype — not restated here, because a restated rationale drifts from the one it copied.
 */
(function () {
  "use strict";

  var stage = document.getElementById("stage");
  if (!stage) return;                       // not the landing page
  var pin   = document.getElementById("pin");

  var reduced  = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var cvs      = document.getElementById("field");
  var ctx      = cvs.getContext("2d");
  var phone    = document.getElementById("phone");
  var screenEl = document.getElementById("screen");
  var feed     = document.getElementById("feed");
  var caught   = document.getElementById("caught");
  var daylight = document.getElementById("daylight");
  var bar      = document.querySelector(".nav");
  var copy     = document.getElementById("copy");
  var rows     = document.getElementById("rows");
  var hint     = document.getElementById("hint");
  var count    = document.getElementById("screenCount");
  var stageCta = document.getElementById("stage-cta");
  var words    = [document.getElementById("w1"), document.getElementById("w2"), document.getElementById("w3")];
  var posts    = Array.prototype.slice.call(feed.querySelectorAll(".post"));

  // Hand over from the no-JS fallback state before the first frame. Everything below assumes the
  // animation owns these; leaving the fallback classes on would show a lit headline over beat 1.
  document.documentElement.classList.add("js-stage");

  // ── beat boundaries on scroll progress 0..1 ──────────────────
  // Re-paced for BUG-082: the story used to spend 0.84 screen heights on an unchanging grey cloud
  // before anything happened, and asked for 6.0 screens end to end. Reported from a phone: "the
  // scroll amount is a bit too much before the dots turn gold." The track went 700vh -> 450vh AND
  // the first beat moved forward — shortening alone still left the opening the longest stretch,
  // and moving the first beat alone still asked for six screens.
  var SELECT = [0.05, 0.19];   // dots light up in place
  var QUEUE  = [0.21, 0.37];   // column forms, greys leave
  // 0.37 → 0.485 is a deliberate hold: the column has to exist long enough to be
  // read as a column. Without it the pivot beat of the whole page is invisible.
  // Preserved proportionally through the re-pacing at ~340px, not squeezed out to buy speed.
  var FLY    = [0.485, 0.66];  // column pours into the phone, staggered
  var CLEAR  = [0.71, 0.85];   // posts clear one by one
  var LIFT   = [0.89, 0.99];   // daylight spreads

  var NPOST = posts.length, PER = 4, NCHOSEN = NPOST * PER, NNOISE = 300;

  var W = 0, H = 0, dots = [], glow = null, mobile = false, seeds = null;
  var lightX = 0.5, lightY = 0.5;
  var lastBar = null;

  function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(a, b, v) { var t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Pre-rendered bloom sprite: one radial gradient, blitted. Never shadowBlur
  // per dot per frame — that is what kills mid-range phones.
  function buildGlow() {
    var s = 96, c = document.createElement("canvas");
    c.width = c.height = s;
    var g = c.getContext("2d");
    var grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0,    "rgba(224,170,79,0.85)");
    grad.addColorStop(0.22, "rgba(224,170,79,0.34)");
    grad.addColorStop(0.55, "rgba(224,170,79,0.09)");
    grad.addColorStop(1,    "rgba(224,170,79,0)");
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    return c;
  }

  // ── The field's IDENTITY, drawn once and never again (BUG-079) ──
  //
  // WHICH dot this is — its angle, its distance from centre, its size, how it wobbles — is a
  // property of the field. WHERE it lands on screen is a property of the viewport. layout()
  // re-rolled both, and boot() re-runs layout() 140ms after any resize; iOS Safari fires resize
  // when the URL bar collapses on the first scroll. So the whole cloud teleported to a new
  // arrangement exactly once, mid-story, in front of the user — and then behaved perfectly,
  // because the bar stays collapsed after that.
  //
  // Distances are kept normalised (0..1) so a viewport change re-projects the same field instead
  // of generating a new one. NNOISE seeds are always drawn even though a narrow screen renders
  // half of them, so the surviving dots keep their places across the 860px breakpoint too.
  function buildSeeds() {
    var s = { noise: [], chosen: [] }, i;
    for (i = 0; i < NNOISE; i++) {
      // Slight centre bias so the field reads as a drifting mass, not a grid.
      s.noise.push({
        a: Math.random() * Math.PI * 2, d: Math.pow(Math.random(), 0.72),
        r: 1.1 + Math.random() * 1.9,
        amp: 4 + Math.random() * 11, sp: 0.16 + Math.random() * 0.3, ph: Math.random() * 6.283
      });
    }
    for (i = 0; i < NCHOSEN; i++) {
      s.chosen.push({
        a: Math.random() * Math.PI * 2, d: Math.pow(Math.random(), 0.6),
        r: 2.6 + Math.random() * 1.1,
        amp: 4 + Math.random() * 9, sp: 0.18 + Math.random() * 0.28, ph: Math.random() * 6.283
      });
    }
    return s;
  }

  function layout() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Measure the box we actually draw into, not the window (BUG-079, second half). #field is
    // `position: absolute; inset: 0` inside .pin, and .pin is `height: 100vh` — which on iOS
    // resolves to the LARGE viewport and does NOT change when the URL bar shows or hides, while
    // window.innerHeight does, by 7-12%. Measuring the window therefore rescaled every dot's
    // vertical position, and stretched the canvas away from its own container, on the first scroll
    // of every phone visit. The container is the honest source: it is the coordinate space the
    // canvas is painted in.
    var box = pin ? pin.getBoundingClientRect() : null;
    W = box && box.width  ? box.width  : window.innerWidth;
    H = box && box.height ? box.height : window.innerHeight;
    mobile = W < 860;
    cvs.width = Math.round(W * dpr); cvs.height = Math.round(H * dpr);
    cvs.style.width = W + "px"; cvs.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var sr = screenEl.getBoundingClientRect();
    var pr = phone.getBoundingClientRect();
    lightX = (pr.left + pr.width / 2) / W * 100;
    lightY = (pr.top + pr.height / 2) / H * 100;
    daylight.style.setProperty("--lx", lightX + "%");
    daylight.style.setProperty("--ly", lightY + "%");

    // Queue column: left of the phone on desktop, directly above it on mobile.
    var qx = mobile ? sr.left + sr.width / 2 : Math.max(46, sr.left - 96);
    var qTop, qBot;
    if (mobile) { qTop = Math.max(62, sr.top - 200); qBot = Math.max(qTop + 60, sr.top - 26); }
    else        { qTop = H * 0.25; qBot = H * 0.75; }

    // Post landing slots inside the screen.
    var slotTop = sr.top + 46, slotH = Math.max(30, (sr.height - 70) / NPOST);

    if (!seeds) seeds = buildSeeds();

    var noise = mobile ? 150 : NNOISE;
    dots = [];

    for (var i = 0; i < noise; i++) {
      var n = seeds.noise[i], nox = Math.cos(n.a), noy = Math.sin(n.a);
      dots.push({
        chosen: false,
        hx: W * 0.5 + nox * n.d * W * 0.62,
        hy: H * 0.5 + noy * n.d * H * 0.62,
        r: n.r,
        amp: n.amp, sp: n.sp, ph: n.ph,
        ox: nox, oy: noy
      });
    }

    for (var k = 0; k < NCHOSEN; k++) {
      var c = seeds.chosen[k], post = Math.floor(k / PER);
      dots.push({
        chosen: true, order: k, lag: (k / NCHOSEN) * 0.4,
        hx: W * 0.5 + Math.cos(c.a) * c.d * W * 0.55,
        hy: H * 0.5 + Math.sin(c.a) * c.d * H * 0.55,
        r: c.r,
        amp: c.amp, sp: c.sp, ph: c.ph,
        qx: qx + (k % 2 ? 2 : -2),
        qy: qTop + (qBot - qTop) * (k / (NCHOSEN - 1)),
        tx: sr.left + sr.width * (0.3 + 0.4 * ((k % PER) / (PER - 1))),
        ty: slotTop + slotH * post + slotH * 0.4
      });
    }
    if (!glow) glow = buildGlow();
  }

  function progress() {
    var r = stage.getBoundingClientRect();
    // The distance the sticky pin travels is the stage minus the PIN, not minus the window. Using
    // the window meant the URL bar collapsing changed the divisor, so the same first scroll nudged
    // the whole story forward. (The fallback covers a scroll arriving before the first layout();
    // boot() lays out before it renders, so it is defensive rather than a path under test.)
    var span = r.height - (H || window.innerHeight);
    return span <= 0 ? 0 : clamp(-r.top / span);
  }

  function draw(p, time) {
    ctx.clearRect(0, 0, W, H);

    var sel    = smooth(SELECT[0], SELECT[1], p);
    var queue  = smooth(QUEUE[0],  QUEUE[1],  p);
    var flyRaw = clamp((p - FLY[0]) / (FLY[1] - FLY[0]));  // staggered per dot below
    var wob    = reduced ? 0 : 1;

    // ── The grey field: everything out there, which is not yours ──
    //
    // Its alpha is a function of scroll position and nothing else, so all ~150 noise dots share one
    // colour — and can therefore be ONE path with one fill. Each dot used to rebuild that identical
    // rgba string (with a toFixed), set the composite mode again, and submit a path of its own.
    //
    // This is also the beat with the most dots on screen by a factor of 7 (174 here against 24 once
    // the queue has formed), which is why a real phone stuttered through the opening and ran clean
    // from the queue onward. Gating the whole pass on the shared alpha also skips ~150 sine/cosine
    // pairs per frame once the field has gone, which the per-dot version computed and threw away.
    var noiseA = (1 - 0.66 * sel) * (1 - queue);
    if (noiseA > 0.012) {
      var push = queue * queue * 420;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(91,98,110," + (noiseA * 0.9).toFixed(3) + ")";
      ctx.beginPath();
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        if (d.chosen) continue;
        var nx = d.hx + Math.sin(time * d.sp + d.ph) * d.amp * wob + d.ox * push;
        var ny = d.hy + Math.cos(time * d.sp * 0.92 + d.ph) * d.amp * wob + d.oy * push;
        // moveTo before EVERY arc. arc() draws a line from the current point to where the arc
        // starts, so a batched path without this renders the field as a web joining every dot.
        ctx.moveTo(nx + d.r, ny);
        ctx.arc(nx, ny, d.r, 0, 6.2832);
      }
      ctx.fill();
    }

    // ── The chosen dots: yours ──
    //
    // Only ~24 of them, and their alpha genuinely differs per dot because the flight lag staggers
    // it, so these keep a fill each. What is frame-constant is the COLOUR, so it is built once here
    // rather than per dot.
    //
    // The glow-then-body interleaving is preserved deliberately. Drawing every glow first and every
    // body after would be marginally cheaper and would quietly change the picture: a dot sitting
    // inside a neighbour's bloom is currently lit by it, and batching would put the body on top of
    // every glow instead. The blooms are 34-74px wide over 3px dots, so that overlap is the norm,
    // not an edge case — and this is the beat the whole page is about.
    var lit = sel;
    var bloom = Math.sin(lit * Math.PI);
    var cr = Math.round(lerp(91, 63, lit)), cg = Math.round(lerp(98, 163, lit)), cb = Math.round(lerp(110, 125, lit));
    var rgb = "rgba(" + cr + "," + cg + "," + cb + ",";
    var bodyA = lerp(0.55, 1, lit);

    for (var k = 0; k < dots.length; k++) {
      var c = dots[k];
      if (!c.chosen) continue;

      var px = c.hx + Math.sin(time * c.sp + c.ph) * c.amp * wob;
      var py = c.hy + Math.cos(time * c.sp * 0.92 + c.ph) * c.amp * wob;
      if (queue > 0) { px = lerp(px, c.qx, queue); py = lerp(py, c.qy, queue); }

      // Each dot leaves the column on its own beat, so the queue pours into the
      // phone from the top down instead of teleporting all at once.
      var f = smooth(c.lag, c.lag + 0.6, flyRaw);
      if (f > 0) { var fe = f * f; px = lerp(px, c.tx, fe); py = lerp(py, c.ty, fe); }

      var alpha = 1 - smooth(0.72, 0.97, f);
      if (alpha <= 0.01) continue;
      var rad = c.r * (1 - 0.4 * f);

      if (bloom > 0.02) {
        var gs = 34 + bloom * 40;
        ctx.globalCompositeOperation = "lighter";
        // trimmed from .9: every bloom now peaks together, so the summed light
        // on screen is higher than it was when ignition rolled across the field
        ctx.globalAlpha = bloom * 0.78 * alpha;
        ctx.drawImage(glow, px - gs / 2, py - gs / 2, gs, gs);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }

      ctx.fillStyle = rgb + (bodyA * alpha).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function paintDom(p) {
    words[0].classList.add("lit");                       // lit at rest, before any scroll
    words[1].classList.toggle("lit", p >= QUEUE[0] + 0.02);
    words[2].classList.toggle("lit", p >= FLY[0] + 0.02);

    rows.style.opacity = (1 - smooth(0.12, 0.21, p)).toFixed(3);
    hint.style.opacity = (1 - smooth(0.02, 0.09, p)).toFixed(3);

    // Phone appears; it never moves, so the dot targets stay valid.
    phone.style.opacity = smooth(QUEUE[0] + 0.04, QUEUE[1] + 0.02, p).toFixed(3);

    // On a narrow screen the SUBHEAD steps back so the phone owns the view — and then comes back as
    // the feed empties, finishing exactly as the daylight starts.
    //
    // The variable is still set on `.copy` and inherits, but only `.sub` spends it (BUG-085). It
    // used to be `.copy` itself, which wraps the headline and the CTA as well, and that cost two
    // separate defects: the button — the page's ONE conversion path — rendered at 0.26 on every
    // phone for the entire beat that exists to convert (round-1 H1, found by two reviewers), and
    // the headline's third clause lit at p=0.60 *inside* the fade, so all nine words dimmed
    // together instead and the third beat was never seen at all. The return below is what fixed the
    // first; moving the opacity off `.copy` is what fixed the second. Pinned by
    // test/public-landing.test.mjs, which the harness cannot do — it records this VALUE and cannot
    // see which element the cascade spends it on.
    var back = smooth(0.38, 0.54, p) * (1 - smooth(CLEAR[1], LIFT[0], p));
    copy.style.setProperty("--copyfade", mobile ? (1 - 0.74 * back).toFixed(3) : "1");

    var flySpan = FLY[1] - FLY[0];
    for (var i = 0; i < NPOST; i++) {
      var inAt = FLY[0] + flySpan * (0.45 + i * 0.055);   // lands as its dots arrive
      var clearAt = CLEAR[0] + i * ((CLEAR[1] - CLEAR[0]) / NPOST);
      posts[i].classList.toggle("in", p >= inAt);
      posts[i].classList.toggle("cleared", p >= clearAt);
    }
    var left = posts.filter(function (el) {
      return el.classList.contains("in") && !el.classList.contains("cleared");
    }).length;
    // Counting UP while the feed fills, DOWN while it empties. Saying "2 left"
    // mid-pour reads as "only 2 exist" when four more are still on the way.
    //
    // `left || NPOST` covers the gap the old three-way form left open (round-1 M1): the pour starts
    // at FLY[0] but the first post does not land until 0.652, so between them `left` is legitimately
    // 0 while the promise still stands — and the phone is fully opaque throughout, so the visitor
    // watched "6 new" fall to "0 new" over an empty feed and climb back. It also drops a hardcoded
    // "6" that would have gone on promising six posts after one was deleted from the markup.
    count.textContent = p < CLEAR[0] ? (left || NPOST) + " new"
                      : left + " left";

    caught.classList.toggle("on", p >= CLEAR[1] + 0.008);

    var lift = smooth(LIFT[0], LIFT[1], p);
    daylight.style.opacity = lift.toFixed(3);
    daylight.style.setProperty("--lr", (lift * 128).toFixed(1));

    // TASK-091: the page's one CTA, arriving with the daylight rather than at a fixed
    // scroll point — it belongs to the moment the argument lands, not to a position.
    stageCta.classList.toggle("on", lift > 0.12);

    var day = lift > 0.45;
    if (day !== lastBar) {
      bar.classList.toggle("day", day);
      copy.classList.toggle("day", day);
      lastBar = day;
    }
  }

  // ── The frame loop ───────────────────────────────────────────
  // TASK-091. The prototype re-requested a frame unconditionally, which was invisible there
  // because the brief sat below the stage and nobody scrolled past it. Here the loop would run at
  // 60fps for as long as the tab is open.
  //
  // The first attempt at this suspended on an IntersectionObserver over `.stage`, and measured
  // 120 frames/sec at the footer — i.e. it did nothing. (Stated precisely, because the earlier
  // wording said "exactly as before" and there is no "before": the unfixed loop was never measured.
  // That one reading was sound; later readings of 0 were taken in a background tab, where Chrome
  // suspends rAF, and meant nothing.) The stage is 700vh and the footer is ~85px, so the stage
  // occupies the viewport at every scroll position on this page; that observer can never fire.
  // Visibility was the wrong question.
  //
  // The right one is whether anything is still MOVING. Only the dots animate under their own
  // steam (drift, bloom, flight); everything after them — posts clearing, daylight, the bar swap —
  // is a CSS transition driven by a class, which needs a repaint on scroll and nothing more. By
  // FLY[1] every chosen dot has f = 1, so `alpha` is 0 and it is skipped, and every noise dot went
  // to zero back at QUEUE[1]. Past that point the canvas is empty and a frame cannot change it.
  //
  // So: run continuously while dots are alive, then fall back to repaint-on-scroll.
  var raf = null, t0 = performance.now(), onStage = true;

  // +0.01 for the boundary itself, so the last flight frame is not clipped.
  //
  // `reduced` short-circuits it entirely (round-1 H2). Only the dots animate under their own steam,
  // and their whole time dependence is the per-dot wobble — which is 0 under reduced motion. So
  // every frame paints identical pixels and the loop is pure waste, on the one setting that has
  // explicitly asked for less of it. Scroll still repaints via request(); the still frames advance.
  function moving(p) { return !reduced && p < FLY[1] + 0.01; }

  function at() {
    var p = progress();
    if (!reduced) return p;
    // Snap to beat centres: the same story, told in still frames. Re-derived when the beats moved
    // for BUG-082 — a stop that no longer sits on a beat centre snaps the reduced-motion visitor to
    // a position that is not a moment in the story, which is worse than the pacing it replaced.
    var stops = [0.02, 0.12, 0.29, 0.43, 0.57, 0.78, 0.96];
    var best = stops[0];
    for (var i = 0; i < stops.length; i++) if (Math.abs(stops[i] - p) < Math.abs(best - p)) best = stops[i];
    return best;
  }

  // Canvas and DOM are always painted together, from ONE reading of progress. Splitting them is
  // how a resize left the dot queue on screen above a header reading "0 new".
  function render(now) {
    var p = at();
    draw(p, (now - t0) / 1000);
    paintDom(p);
    return p;
  }

  function frame(now) {
    raf = null;
    if (onStage && moving(render(now))) raf = requestAnimationFrame(frame);
  }

  function request() {
    if (raf === null && onStage) raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
  }

  // Every scroll paints exactly one frame; while the dots are alive that frame re-arms the loop.
  window.addEventListener("scroll", request, { passive: true });

  // Still worth observing: it is what suspends the loop if the page ever grows content below the
  // stage tall enough to push it out of view, and it costs nothing when it never fires.
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(function (entries) {
      onStage = entries[0].isIntersecting;
      if (onStage) request(); else stop();
    }, { rootMargin: "120px" }).observe(pin || stage);
  }

  // render() SYNCHRONOUSLY, then arm the loop. Both halves are load-bearing and each was learned
  // by breaking it: dropping the synchronous render left the whole stage in its pre-animation
  // state whenever the first rAF was delayed — a fully dim headline, because `lit` is applied by
  // paintDom and nothing else — and Chrome does not run rAF at all in a background tab.
  function boot() { layout(); render(performance.now()); request(); }

  var rz;
  window.addEventListener("resize", function () {
    clearTimeout(rz);
    rz = setTimeout(boot, 140);
  });

  boot();
})();
