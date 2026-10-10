#!/usr/bin/env node
// Mutation battery runner.
//
//   npm run mutate mutations/<spec>.mjs
//
// A green suite proves the code ran. It does not prove a defect would be noticed.
// The only thing that answers that is deliberately breaking the code and checking
// the suite screams. This runs that battery so it does not have to be hand-rolled
// each time, because a hand-rolled one easily gets one of the
// properties below wrong.
//
//   1. Revert from a COPY of the file, never `git checkout` — that restores HEAD,
//      silently deleting an uncommitted fix, so every later mutation runs against
//      already-broken code and reports a triumphant RED.
//   2. Assert the mutation is still present AFTER the suite runs, not only before.
//      A batched harness was measured reporting false GREENs: `diff -q` passed
//      before the run and the mutation was gone during it.
//   3. Report which NAMED test killed each mutation. One killed only by an
//      unrelated test is a coverage gap, not a kill.
//
// This file NEVER touches git. Batteries run mid-build with an uncommitted fix on
// disk, which is exactly the case property 1 exists for.
//
// SCOPE, stated so nobody over-credits it: this mechanises property 1, property 2
// and the FIRST HALF of property 3 (it names the killer; it does not judge whether
// the killer is related). The other rules of a sound battery — recreate the defect
// rather than delete the fix, mutate each term and every line, mutate the condition
// your change made load-bearing, check all N new tests appear by name at RED, size
// the fixture so only the guard under test can fire — are NOT mechanised here and
// remain the author's job.
//
// KNOWN LIMITS. Each was measured and judged minor, so they are recorded here, where the next
// person on this file actually looks. Two larger ones are also open: a run can be
// misclassified as TIMEOUT, and there is no baseline check on how many tests ran.
//
//   - TAP directives. A failing `todo` test emits `not ok N - x # TODO` but counts
//     in `# todo`, not `# fail`, so the cross-check below reports ERROR for a real
//     kill, and the directive is not stripped from the name. The suite has no
//     todo/skip test today.
//   - Path containment. `resolve(root, f)` accepts `../`, so a typo'd `file:`
//     writes outside the repo silently. This is NOT a security boundary — a spec
//     is `import()`ed and already has full code execution — it is blast radius
//     from a slip.
//   - utf8 round-trip. readFile/writeFile decode and re-encode, so a byte that is
//     not valid utf8 becomes U+FFFD: a `find` spanning it reports a false
//     "absent", and a later mutation on that file runs against corrupted bytes.
//     No file in the repo is non-utf8 today — escalate when a battery targets one.
//   - An infrastructure throw (an unwritable target, say) propagates out of
//     runBattery, so a failure on mutation 20 of 30 discards the 19 results
//     already computed. The files themselves are unaffected.
//   - spawnSync's timeout signals only the direct child, and `node --test` spawns
//     one process per test file, so on a timeout those grandchildren keep running
//     briefly against a file this runner is about to restore.
//   - CRLF: /^# fail (\d+)$/m does not match when a \r precedes the newline.
//   - `why` is optional, though the entire reason this spec format is .mjs rather
//     than JSON is that a mutation can say which defect it recreates.
//   - report() and the CLI block have no unit tests; isMainPath is the piece
//     extracted so that the part which silently skipped everything could have one.
//
// NOT built here: a permanent fixed mutation set on a schedule.
// This catches a NEW guard shipped with a test that cannot fail for it. A fixed set
// would catch an EXISTING test that ROTS, which no ad-hoc battery points at.
//
// Crash behaviour is deliberate. There is no backup file
// and no signal handler: a hard kill leaves the mutated file on disk, and THE SPEC
// IS THE RECOVERY RECORD — it states file/find/with, so undoing is applying it in
// reverse. A hidden `.mutate-backup` is deliberately not used: it makes the damage look
// like your own edit in `git status`, which is the reflex that destroys uncommitted
// work.
//
// TWO guards catch a leftover mutation, and it takes both — preflight
// alone is insufficient in two ways:
//
//   - `preflight` checks that each target named in THE CURRENT SPEC is in the state
//     that spec expects. It cannot see a file the current spec does not mention, and
//     it passes a leftover whose `with` contains its `find` (the guard-moved shape),
//     which would then be applied on top of itself and restored corrupted.
//   - `baseline` closes both: one unmutated suite run before anything is written. A
//     leftover of either kind reds the suite, so the battery refuses. This is also
//     what stops a pre-existing failure being credited to every mutation.

import { readFileSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LOCK = '.mutate.lock'

// SURVIVED and ERROR must stay distinct. An error means this battery told you
// NOTHING; a survivor means it told you something bad. Conflating them is how a
// broken battery reads as a clean one — this tool's own failure mode.
export const OUTCOME = {
  KILLED: 'KILLED',
  SURVIVED: 'SURVIVED',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
}

// --- spec validation -------------------------------------------------------

// Every field is checked because none of them fail loudly on their own. The one
// that matters most is `with`: Array.prototype.join(undefined) falls back to ",",
// so a missing field replaced the target with a comma, syntax-broke the file, red
// the suite, and reported KILLED with a real test name — a fabricated kill, which
// is the worst output this tool can produce.
export function validateSpec(spec) {
  if (!Array.isArray(spec)) {
    return { ok: false, errors: ['the spec must export default an array of mutations'] }
  }
  if (spec.length === 0) {
    return { ok: false, errors: ['the spec is empty — a battery that tests nothing must not report success'] }
  }

  const errors = []
  const seen = new Set()

  spec.forEach((m, i) => {
    const at = `mutation ${i + 1}${typeof m?.id === 'string' ? ` (${m.id})` : ''}`
    for (const field of ['id', 'file', 'find', 'with']) {
      if (typeof m?.[field] !== 'string' || m[field] === '') {
        errors.push(`${at}: \`${field}\` must be a non-empty string`)
      }
    }
    // Optional, but if present it must state WHY the survivor is known — a bare
    // `true` would mark a gap as expected while recording no reason for it.
    if ('expectSurvive' in (m ?? {}) && (typeof m.expectSurvive !== 'string' || m.expectSurvive === '')) {
      errors.push(`${at}: \`expectSurvive\` must be a non-empty string saying why the gap is known`)
    }
    if (typeof m?.id === 'string') {
      if (seen.has(m.id)) {
        errors.push(`${at}: duplicate id \`${m.id}\` — two results would be indistinguishable`)
      }
      seen.add(m.id)
    }
  })

  return { ok: errors.length === 0, errors }
}

// --- pure core -------------------------------------------------------------

export function applyMutation(source, mutation) {
  // AN EMPTY `find` IS A CORRUPTION VECTOR, not a way to disable an entry. `''.split` semantics mean
  // `source.split('')` splits between every character, so `count` becomes the file's LENGTH rather
  // than 0 — the `absent` branch below never fires, preflight passes, and the join rewrites the whole
  // file with `with` wedged between every character. The runner would report a healthy battery while
  // destroying the file under test.
  //
  // There is NO `skip` flag in this runner. To retire a mutation, DELETE the entry and leave a
  // comment saying why it went.
  if (typeof mutation.find !== 'string' || mutation.find === '') {
    return { ok: false, reason: 'empty-find', count: 0 }
  }
  const parts = source.split(mutation.find)
  const count = parts.length - 1
  if (count === 0) return { ok: false, reason: 'absent', count }
  if (count > 1) return { ok: false, reason: 'ambiguous', count }

  // Matching exactly once is not the same as changing anything. `find === with`
  // writes the file back unchanged and the suite then reports a clean SURVIVED —
  // a battery that tested nothing, read as a hole in your tests.
  const text = parts.join(mutation.with)
  if (text === source) return { ok: false, reason: 'noop', count }

  return { ok: true, text, count }
}

// Leading whitespace is tolerated so a nested suite does not silently parse as
// zero failures — but node --test also prints each failure's `error:`/`actual:`
// as an INDENTED YAML block scalar, fenced by `---` and `...`. Any TAP text
// inside a fixture is echoed there verbatim, so a plain whitespace-tolerant regex
// counted it and reported a genuinely killed mutation as ERROR. This file's own
// test fixtures contain `not ok` lines, so it was self-inflicting.
//
// The `# fail N` tally is read from the raw text on purpose: node escapes stray
// child output into `# ` comments and block scalars are always indented, so a
// column-0 `# fail` line cannot be spoofed by a test.
export function parseFailures(stdout) {
  const names = []
  let inYaml = false

  for (const line of stdout.split('\n')) {
    if (inYaml) {
      if (/^\s*\.\.\.\s*$/.test(line)) inYaml = false
      continue
    }
    if (/^\s*---\s*$/.test(line)) { inYaml = true; continue }

    const m = line.match(/^[ \t]*not ok \d+ - (.+?)[ \t]*$/)
    if (m) names.push(m[1])
  }

  const tally = stdout.match(/^# fail (\d+)$/m)
  const reported = tally ? Number(tally[1]) : null

  if (reported === null) {
    return { ok: false, names, reported, error: 'no "# fail N" line in the suite output' }
  }
  if (reported !== names.length) {
    return {
      ok: false, names, reported,
      error: `parsed ${names.length} failing test name(s) but the suite reported ${reported}`,
    }
  }
  return { ok: true, names, reported }
}

// spawnSync reports a timeout by killing the child: ETIMEDOUT with a null status.
// Distinguishing that from a normal failure is what keeps a hung suite out of the
// SURVIVED column — a hang means no test died, not that no test noticed.
export function classifyRun(r) {
  const timedOut = r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal != null)
  return { stdout: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status, timedOut }
}

// THE CONTROL RUN. One unmutated suite run before the battery starts.
//
// Without it the runner cannot tell "my mutation killed a test" from "a test was
// already failing", so a single pre-existing failure turns EVERY mutation into a
// KILLED at exit 0 — measured, with a mutation that only edited a comment. And the
// tool's documented use is mid-build with an uncommitted fix on disk, which is
// exactly when the tree is most likely red.
//
// This is family 1's rule turned on this tool: before a reading counts as
// evidence, the instrument must be shown capable of detecting the thing. A battery
// with no control measures nothing.
export function baseline(deps) {
  const result = deps.runSuite()

  if (result.timedOut) {
    return { ok: false, error: 'the baseline suite run did not finish — nothing was mutated' }
  }

  const parsed = parseFailures(result.stdout)
  if (parsed.reported === null) {
    return {
      ok: false,
      error: 'could not read the baseline suite output — nothing was mutated. ' +
             'Every verdict would be attributed to a run this tool cannot interpret.',
    }
  }
  if (parsed.reported > 0) {
    return {
      ok: false,
      error: `the suite is already red before any mutation (${parsed.reported} failing) — ` +
             'nothing was mutated. Every mutation would be reported KILLED by these:\n' +
             parsed.names.map((n) => `      ${n}`).join('\n'),
    }
  }

  // `tests` is recorded but NOT enforced. Comparing it per mutation is not built;
  // capturing it here is what makes that cheap when it is.
  const count = result.stdout.match(/^# tests (\d+)$/m)
  return { ok: true, tests: count ? Number(count[1]) : null }
}

// --- preflight -------------------------------------------------------------

// Checked before ANYTHING is written, and before the lock is taken — a stranded
// lock must not hide the more urgent news that one of your files is still mutated.
//
// SCOPE: this sees only
// the targets named in the spec it is given, and its test is "does `find` still
// match exactly once". A leftover in a file this spec does not mention is invisible
// to it, and a leftover whose `with` CONTAINS its `find` still matches once and
// passes. `baseline` is what actually catches those; this catches the common case
// early and names the file, which baseline cannot do.
export function preflight(spec, deps) {
  const errors = []

  for (const m of spec) {
    let source
    try {
      source = deps.readFile(m.file)
    } catch (e) {
      errors.push(`${m.id}: cannot read ${m.file} — ${e.message}`)
      continue
    }

    const applied = applyMutation(source, m)
    if (!applied.ok) {
      // A malformed `find` is a SPEC bug, and it must not borrow the interrupted-battery wording
      // below: that sends the reader to inspect a file which was never touched, which is the
      // wrong-pointer failure the guard in `applyMutation` exists to prevent.
      errors.push(applied.reason === 'empty-find'
        ? `${m.id}: \`find\` is empty or not a string — the spec entry is malformed, ${m.file} is ` +
          'untouched. There is no skip flag: delete a retired entry and say why it went.'
        : `${m.id}: ${m.file} is not in the state the spec expects (${applied.reason}). ` +
          'If a battery was interrupted, that file may still be mutated — the spec ' +
          'entry says what to swap back.',
      )
    }
  }

  return { ok: errors.length === 0, errors }
}

// --- one mutation ----------------------------------------------------------

export function runOne(mutation, deps) {
  const { readFile, writeFile, runSuite } = deps
  const base = {
    id: mutation.id,
    file: mutation.file,
    why: mutation.why,
    expectSurvive: mutation.expectSurvive,
  }
  const err = (error) => ({ ...base, outcome: OUTCOME.ERROR, error })

  let before
  try {
    before = readFile(mutation.file)
  } catch (e) {
    return err(e.message)
  }

  const applied = applyMutation(before, mutation)
  if (!applied.ok) {
    return err(applied.reason === 'absent'
      ? `find string is absent from ${mutation.file}`
      : `find string matches ${applied.count} times in ${mutation.file} — ` +
        'cannot know which site was mutated')
  }

  writeFile(mutation.file, applied.text)

  let outcome
  try {
    const result = runSuite()
    if (result.timedOut) {
      outcome = { ...base, outcome: OUTCOME.TIMEOUT, error: 'the suite did not finish' }
    } else if (readFile(mutation.file) !== applied.text) {
      // Property 2 — checked AFTER the run, not only before. A check that passes
      // beforehand and vanishes during the run produces a confident, meaningless
      // GREEN, which is what a batched harness was measured doing.
      outcome = err('the mutation vanished during the run — the suite did not test it')
    } else {
      const parsed = parseFailures(result.stdout)
      outcome = parsed.ok
        ? {
          ...base,
          outcome: parsed.names.length ? OUTCOME.KILLED : OUTCOME.SURVIVED,
          killedBy: parsed.names,
        }
        : err(parsed.error)
    }
  } catch (e) {
    outcome = err(`the suite could not be run: ${e.message}`)
  }

  // Property 1 — restore the PRE-RUN bytes, never HEAD. An uncommitted fix on
  // disk is the normal case for a battery, not the exception. And VERIFY it: the
  // first round assumed the restore took, so the runner could report a clean
  // KILLED while the developer's file sat mutated on disk. A failed restore
  // outranks whatever the suite said, because the file matters more than the
  // result.
  try {
    writeFile(mutation.file, before)
    if (readFile(mutation.file) !== before) {
      return err(
        `restore did not take — ${mutation.file} is still modified on disk. ` +
        'The spec entry says what to swap back.',
      )
    }
  } catch (e) {
    return err(`restore failed for ${mutation.file}: ${e.message}`)
  }

  return outcome
}

// --- the battery -----------------------------------------------------------

export function runBattery(spec, deps) {
  return spec.map((mutation) => runOne(mutation, deps))
}

// A mutation may declare `expectSurvive` when the gap it exposes is already known
// and recorded. Then SURVIVED is the expected result and must not fail the run —
// otherwise the battery that documents a known gap is permanently red, which
// trains the reader to ignore the exit code. The mirror matters more: if a declared survivor is KILLED, the gap
// closed (or the runner is lying) and the spec's stated assumption is stale, so
// that fails loudly rather than passing as a bonus.
export function summarise(results) {
  // Only KILLED and SURVIVED depend on what was expected. ERROR and TIMEOUT are
  // counted whatever the expectation: filtering them by `expectSurvive` put a
  // declared survivor that errored into no bucket at all, so the summary read
  // "1 killed" while the developer's file sat modified on disk.
  const declared = (o) => results.filter((r) => r.outcome === o && !r.expectSurvive).length
  const anyOutcome = (o) => results.filter((r) => r.outcome === o).length
  const killed = declared(OUTCOME.KILLED)
  const expectedSurvivors = results.filter(
    (r) => r.expectSurvive && r.outcome === OUTCOME.SURVIVED).length
  const unexpectedKills = results.filter(
    (r) => r.expectSurvive && r.outcome === OUTCOME.KILLED).length
  const asExpected = (r) => (r.expectSurvive
    ? r.outcome === OUTCOME.SURVIVED
    : r.outcome === OUTCOME.KILLED)

  return {
    killed,
    expectedSurvivors,
    unexpectedKills,
    survived: declared(OUTCOME.SURVIVED),
    errors: anyOutcome(OUTCOME.ERROR),
    timeouts: anyOutcome(OUTCOME.TIMEOUT),
    // `results.length > 0` is not redundant with validateSpec's empty-spec check:
    // summarise is exported and 0 === 0 would otherwise report a battery that ran
    // nothing exactly as it reports one that killed everything.
    ok: results.length > 0 && results.every(asExpected),
  }
}

// --- lock ------------------------------------------------------------------

// Two batteries at once cross-contaminate: one suite run picks up the other's
// mutation and reports a KILL by tests that cannot possibly relate to it. That was
// observed during review — a spurious kill nobody could reproduce, because the
// cause was in another process. `wx` is an atomic exclusive create, so the check
// and the claim cannot be separated.
const pidIsAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// The pid was written and never read, so "a battery is already running" was said
// after a Ctrl-C when nothing was running — and it was said INSTEAD of the fact
// that mattered, because the lock is checked before any file is. Now the holder is
// named, liveness is decided rather than guessed, and a dead holder carries the
// warning about what it may have left behind.
export function acquireLock(fs, lockPath, isAlive = pidIsAlive) {
  try {
    fs.exclusiveCreate(lockPath, `${process.pid}\n`)
  } catch (e) {
    if (e.code === 'EEXIST') {
      let pid = null
      try { pid = Number(String(fs.readFile(lockPath)).trim()) || null } catch { /* unreadable */ }
      const alive = pid === null ? null : isAlive(pid)

      if (alive === false) {
        return {
          ok: false,
          stale: true,
          error: `a previous battery (pid ${pid}) died without releasing ${lockPath}, and that ` +
                 'process is gone. Delete the lock — and check the file it was mutating: the ' +
                 'spec entry says what to swap back.',
        }
      }
      return {
        ok: false,
        stale: false,
        error: `a battery is already running${pid === null ? '' : ` (pid ${pid})`} ` +
               `(lock file: ${lockPath}).`,
      }
    }
    return { ok: false, stale: false, error: `cannot take the lock ${lockPath}: ${e.message}` }
  }
  return { ok: true, release: () => { try { fs.remove(lockPath) } catch { /* already gone */ } } }
}

// --- real dependencies -----------------------------------------------------

export function makeFs(root) {
  return {
    readFile: (f) => readFileSync(resolve(root, f), 'utf8'),
    writeFile: (f, text) => writeFileSync(resolve(root, f), text),
    exclusiveCreate: (f, text) => writeFileSync(resolve(root, f), text, { flag: 'wx' }),
    remove: (f) => unlinkSync(resolve(root, f)),
  }
}

export function realDeps({ root = ROOT, timeoutMs = 60_000 } = {}) {
  const fs = makeFs(root)
  return {
    ...fs,
    runSuite: () => classifyRun(spawnSync('node', ['--test', 'test/'], {
      cwd: root, encoding: 'utf8', timeout: timeoutMs,
    })),
  }
}

// --- report ----------------------------------------------------------------

function report(results) {
  for (const r of results) {
    console.log(`\n  ${r.id}  ${r.file}`)
    if (r.why) console.log(`      ${r.why}`)
    if (r.outcome === OUTCOME.KILLED) {
      for (const name of r.killedBy) console.log(`      KILLED by "${name}"`)
      if (r.expectSurvive) {
        console.log(`      UNEXPECTED KILL <- this was declared a known survivor: ${r.expectSurvive}`)
      }
    } else if (r.outcome === OUTCOME.SURVIVED) {
      console.log(r.expectSurvive
        ? `      SURVIVED (expected) <- ${r.expectSurvive}`
        : '      SURVIVED  <- no test noticed')
    } else {
      console.log(`      ${r.outcome}  <- this mutation proved nothing: ${r.error}`)
    }
  }

  const s = summarise(results)
  const parts = [`${s.killed} killed`]
  if (s.expectedSurvivors) parts.push(`${s.expectedSurvivors} survived as declared`)
  if (s.unexpectedKills) parts.push(`${s.unexpectedKills} UNEXPECTED KILL`)
  if (s.survived) parts.push(`${s.survived} SURVIVED`)
  if (s.timeouts) parts.push(`${s.timeouts} TIMEOUT`)
  if (s.errors) parts.push(`${s.errors} ERROR`)

  // States the count and nothing more. Seven mutations is a sample, not an audit,
  // so "verified" is not in this vocabulary however green the run was.
  console.log(`\n  ${results.length} mutations run, ${parts.join(', ')}`)
  return s.ok
}

// --- CLI -------------------------------------------------------------------

// realpathSync on BOTH sides: `resolve()` does not resolve symlinks while
// `import.meta.url` is already realpath'd, so a symlinked invocation (on macOS
// /tmp is one) silently skipped the whole battery and exited 0 — a battery that
// never ran reporting success.
export function isMainPath(argv1, moduleUrl) {
  if (!argv1) return false
  const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
  return real(argv1) === real(fileURLToPath(moduleUrl))
}

if (isMainPath(process.argv[1], import.meta.url)) {
  const specPath = process.argv[2]
  if (!specPath) {
    console.error('usage: node scripts/mutate.mjs <spec.mjs>')
    process.exit(2)
  }

  let spec
  try {
    spec = (await import(pathToFileURL(resolve(ROOT, specPath)).href)).default
  } catch (e) {
    console.error(`cannot load spec ${specPath}: ${e.message}`)
    process.exit(2)
  }

  const invalid = validateSpec(spec)
  if (!invalid.ok) {
    console.error(`spec ${specPath} is not usable:`)
    for (const e of invalid.errors) console.error(`  - ${e}`)
    process.exit(2)
  }

  const deps = realDeps()

  // ORDER MATTERS. Preflight runs FIRST, before
  // the lock, because it reads files and needs no lock — and because putting the
  // lock first meant that after a Ctrl-C you were told "a battery is already
  // running" and never told which of your files was still mutated. The urgent fact
  // was hidden behind the harmless one.
  const pre = preflight(spec, deps)
  if (!pre.ok) {
    console.error('preflight failed — nothing was mutated:')
    for (const e of pre.errors) console.error(`  - ${e}`)
    process.exitCode = 2
  } else {
    const lock = acquireLock(deps, LOCK)
    if (!lock.ok) {
      // No release here on purpose: the lock belongs to whoever holds it.
      console.error(lock.error)
      process.exitCode = 2
    } else {
      // process.exit() does NOT run `finally`, so nothing inside this block may
      // call it — an early exit here once stranded the lock.
      try {
        const base = baseline(deps)
        if (!base.ok) {
          console.error(`baseline: ${base.error}`)
          process.exitCode = 2
        } else {
          console.log(`  baseline: suite green${base.tests ? ` (${base.tests} tests)` : ''}`)
          process.exitCode = report(runBattery(spec, deps)) ? 0 : 1
        }
      } finally {
        lock.release()
      }
    }
  }
}
