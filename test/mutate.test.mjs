// Tests for the mutation battery runner (CHR-010).
//
// This file exists because the runner's own failure modes are the defect class it
// was built to catch. A runner that reports a false GREEN tells you your tests are
// assertive when they are not — strictly worse than having no runner, because it
// replaces "I don't know" with a wrong answer. One was measured doing exactly that
// during BUG-077, which is why these are detection tests rather than happy paths.
//
// Every assertion here is on observable output — what the fake store holds, what
// the result object says — never "was this function called".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  applyMutation, parseFailures, runOne, summarise, OUTCOME,
  validateSpec, classifyRun, acquireLock, preflight, makeFs, isMainPath, baseline, LOCK,
} from '../scripts/mutate.mjs'

// A stateful fake, not a call recorder: it holds file contents, so a test asserts
// what the disk WOULD hold rather than that a write happened. Same principle as
// test-helpers/handler.mjs.
function fakeDeps(files, runSuite, opts = {}) {
  const store = { ...files }
  let writes = 0
  return {
    store,
    readFile: (f) => {
      if (!(f in store)) throw new Error(`fake: no such file ${f}`)
      return store[f]
    },
    writeFile: (f, text) => {
      writes += 1
      // dropRestore models a restore that silently does not take — a failed
      // write, a read-only file, another process winning a race. The runner must
      // notice rather than report a clean result over a still-mutated file.
      if (opts.dropRestore && writes > 1) return
      store[f] = text
    },
    runSuite,
  }
}

const greenSuite = () => ({ stdout: '# pass 3\n# fail 0\n', code: 0 })
const redSuite = (name) => () => ({
  stdout: `not ok 1 - ${name}\n# pass 2\n# fail 1\n`, code: 1,
})

// --- applyMutation: you must know what you mutated --------------------------

test('applyMutation replaces the target and reports success', () => {
  const r = applyMutation('const a = 1;\n', { find: '= 1', with: '= 999' })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'const a = 999;\n')
})

test('preflight: a malformed find is reported as a SPEC bug, not an interrupted battery', () => {
  // The stock preflight message says the file "is not in the state the spec expects" and that "a
  // battery was interrupted, that file may still be mutated". For an empty `find` that is actively
  // misleading — the file is fine and the SPEC is broken — and sending someone to inspect a healthy
  // file is the same class of wrong-pointer this guard exists to prevent.
  const r = preflight(
    [{ id: 'M1', file: 'app.js', find: '', with: 'x' }],
    { readFile: () => 'const a = 1;\n' },
  )
  assert.equal(r.ok, false, 'a malformed entry must fail preflight')
  assert.match(r.errors[0], /M1/, 'the failing entry is named')
  assert.match(r.errors[0], /find/i, 'and the message points at the spec entry, not at the file')
  assert.doesNotMatch(r.errors[0], /interrupted/i,
    'and it must NOT suggest an interrupted battery — the file was never touched')
})

test('applyMutation: an EMPTY find is rejected, not treated as absent', () => {
  // A retired mutation must be DELETED from the spec, never disabled by emptying `find` — and there
  // is no `skip` flag to reach for either. Written after an entry in `mutations/BUG-092.mjs` was
  // nearly retired that way during [BUG-113].
  //
  // Why it is worse than it looks: `''` is not "absent". `String.split('')` splits between EVERY
  // character, so `count` is the file's length rather than 0, the `absent` branch never fires,
  // preflight PASSES, and the join then rewrites the whole file with the replacement wedged between
  // every character. The runner would report a healthy battery while corrupting app.js.
  const r = applyMutation('const a = 1;\n', { find: '', with: 'x' })
  assert.equal(r.ok, false, 'an empty find must never apply')
  assert.equal(r.reason, 'empty-find',
    'and it must say so distinctly — reporting it as `absent` would send the reader looking for a '
    + 'file in the wrong state instead of at the spec entry that is malformed')
})

test('applyMutation: a non-string find is rejected the same way', () => {
  // The other half of the same slip: a spec entry written with `find: undefined` (a typo'd key, or a
  // template that never got filled) must not reach `split`.
  for (const bad of [undefined, null, 42]) {
    const r = applyMutation('const a = 1;\n', { find: bad, with: 'x' })
    assert.equal(r.ok, false, `find: ${JSON.stringify(bad)} must not apply`)
    assert.equal(r.reason, 'empty-find', 'reported distinctly, not as absent')
  }
})

test('applyMutation: a find string that is absent is an error, not a silent pass', () => {
  const r = applyMutation('const a = 1;\n', { find: 'not in here', with: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'absent')
})

test('applyMutation: a find string matching twice is an error', () => {
  // Two matches means the mutation is ambiguous — whichever one it hit, the
  // battery cannot say which line it proved anything about.
  const r = applyMutation('a();\nb();\na();\n', { find: 'a();', with: 'c();' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ambiguous')
  assert.equal(r.count, 2)
})

// --- parseFailures: the runner checking its own instrument -------------------

test('parseFailures names each failing test', () => {
  const r = parseFailures('not ok 1 - esc escapes <\nnot ok 2 - esc escapes &\n# fail 2\n')
  assert.deepEqual(r.names, ['esc escapes <', 'esc escapes &'])
})

test('parseFailures reads the suite own fail count', () => {
  const r = parseFailures('not ok 1 - a thing\n# fail 1\n')
  assert.equal(r.reported, 1)
})

test('parseFailures: a parse disagreeing with the suite fail count is an error', () => {
  // The parser found one name, the suite says two failed. Reporting one name
  // would understate the kill and hide a coverage gap behind a confident answer.
  const r = parseFailures('not ok 1 - a thing\n# fail 2\n')
  assert.equal(r.ok, false)
})

test('parseFailures ignores not ok lines inside a YAML failure dump', () => {
  // node --test prints each failure's `error:`/`actual:` as an indented YAML
  // block scalar. When a test's own fixture data contains TAP text — which this
  // very file's fixtures do — those lines were counted as failures, so a
  // genuinely KILLED mutation was reported as ERROR ("proved nothing").
  const stdout = [
    'not ok 1 - alpha',
    '  ---',
    '  error: |-',
    '    suite output did not match:',
    '    not ok 1 - some other suite test',
    '  actual: |-',
    '    not ok 1 - alpha',
    '    not ok 2 - beta',
    '  ...',
    '# fail 1',
    '',
  ].join('\n')

  const r = parseFailures(stdout)
  assert.deepEqual(r.names, ['alpha'])
  assert.equal(r.ok, true)
})

test('parseFailures: an indented not ok is still a failure name', () => {
  // Every test in the suite is flat today, so this is correct now and fragile later —
  // a nested suite must not silently parse as zero failures.
  const r = parseFailures('    not ok 1 - a nested one\n# fail 1\n')
  assert.deepEqual(r.names, ['a nested one'])
})

// --- runOne: apply, run, restore --------------------------------------------

test('runOne reports KILLED with the killing test name', () => {
  const deps = fakeDeps({ 'lib/x.js': 'KEEP' }, redSuite('the guard test'))
  const r = runOne({ id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE' }, deps)
  assert.equal(r.outcome, OUTCOME.KILLED)
  assert.deepEqual(r.killedBy, ['the guard test'])
})

test('runOne reports SURVIVED when nothing noticed', () => {
  const deps = fakeDeps({ 'lib/x.js': 'KEEP' }, greenSuite)
  const r = runOne({ id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE' }, deps)
  assert.equal(r.outcome, OUTCOME.SURVIVED)
})

test('runOne restores the file byte-identically after the run', () => {
  // BUG-068's scenario: the pre-run content is what comes back, whatever git
  // holds. An uncommitted fix on disk must survive a battery.
  const deps = fakeDeps({ 'lib/x.js': 'KEEP\n// uncommitted fix\n' }, redSuite('t'))
  runOne({ id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE' }, deps)
  assert.equal(deps.store['lib/x.js'], 'KEEP\n// uncommitted fix\n')
})

test('runOne: a mutation that disappears during the run is an ERROR, not a GREEN', () => {
  // The false GREEN measured in BUG-077 round 1: diff -q passed BEFORE the run
  // and the mutation was gone DURING it, so the suite ran against clean code and
  // its green was meaningless.
  const files = { 'lib/x.js': 'KEEP' }
  const deps = fakeDeps(files, () => {
    deps.store['lib/x.js'] = 'KEEP'      // something restores it mid-run
    return greenSuite()
  })
  const r = runOne({ id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE' }, deps)
  assert.equal(r.outcome, OUTCOME.ERROR)
  assert.match(r.error, /vanish|during the run/i)
})

test('runOne: an unapplied mutation is an ERROR and never writes the file', () => {
  const deps = fakeDeps({ 'lib/x.js': 'KEEP' }, greenSuite)
  const r = runOne({ id: 'M1', file: 'lib/x.js', find: 'ABSENT', with: 'X' }, deps)
  assert.equal(r.outcome, OUTCOME.ERROR)
  assert.equal(deps.store['lib/x.js'], 'KEEP')
})

test('runOne: a hanging suite is TIMEOUT, distinct from SURVIVED', () => {
  const deps = fakeDeps({ 'lib/x.js': 'KEEP' }, () => ({ stdout: '', code: null, timedOut: true }))
  const r = runOne({ id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE' }, deps)
  assert.equal(r.outcome, OUTCOME.TIMEOUT)
  assert.equal(deps.store['lib/x.js'], 'KEEP')
})

// --- summarise: an error is not a survivor ----------------------------------

test('summarise counts errors separately and fails the run', () => {
  // An ERROR means the battery told you nothing. Folding it into SURVIVED would
  // make a broken battery read as a clean one.
  const s = summarise([
    { outcome: OUTCOME.KILLED }, { outcome: OUTCOME.SURVIVED }, { outcome: OUTCOME.ERROR },
  ])
  assert.equal(s.killed, 1)
  assert.equal(s.survived, 1)
  assert.equal(s.errors, 1)
  assert.equal(s.ok, false)
})

test('summarise passes only when every mutation was killed', () => {
  assert.equal(summarise([{ outcome: OUTCOME.KILLED }, { outcome: OUTCOME.KILLED }]).ok, true)
  assert.equal(summarise([{ outcome: OUTCOME.KILLED }, { outcome: OUTCOME.TIMEOUT }]).ok, false)
})

test('summarise: an empty battery is not a success', () => {
  // killed === results.length is 0 === 0. A run that tested nothing must not
  // report the same thing as a run that killed everything.
  assert.equal(summarise([]).ok, false)
})

// --- spec validation: a malformed spec must not become a confident result -----

test('validateSpec rejects a mutation with no `with` field', () => {
  // Array.prototype.join(undefined) falls back to "," — so a missing `with`
  // silently replaces the target with a comma, syntax-breaks the file, reds the
  // suite, and reports KILLED with a real test name for a mutation that never
  // happened. A fabricated kill is this tool's worst possible output.
  const r = validateSpec([{ id: 'M1', file: 'a.js', find: 'x' }])
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /with/)
})

test('validateSpec rejects missing id, file and find', () => {
  assert.equal(validateSpec([{ file: 'a.js', find: 'x', with: 'y' }]).ok, false)
  assert.equal(validateSpec([{ id: 'M1', find: 'x', with: 'y' }]).ok, false)
  assert.equal(validateSpec([{ id: 'M1', file: 'a.js', with: 'y' }]).ok, false)
})

test('validateSpec rejects a non-string field', () => {
  assert.equal(validateSpec([{ id: 'M1', file: 'a.js', find: 3, with: 'y' }]).ok, false)
})

test('validateSpec rejects duplicate ids', () => {
  // Two M1 blocks in the report are indistinguishable, so a survivor cannot be
  // traced back to the mutation that produced it.
  const r = validateSpec([
    { id: 'M1', file: 'a.js', find: 'x', with: 'y' },
    { id: 'M1', file: 'b.js', find: 'x', with: 'y' },
  ])
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /M1/)
})

test('validateSpec rejects a spec that is empty or not an array', () => {
  assert.equal(validateSpec([]).ok, false)
  assert.equal(validateSpec(undefined).ok, false)
  assert.equal(validateSpec({ id: 'M1' }).ok, false)
})

test('validateSpec accepts a well-formed spec', () => {
  assert.equal(validateSpec([{ id: 'M1', file: 'a.js', find: 'x', with: 'y' }]).ok, true)
})

test('validateSpec rejects a non-string expectSurvive', () => {
  // `expectSurvive: true` would read as "expected" while recording no reason.
  // A known survivor is only acceptable if it says why it is known.
  const r = validateSpec([{ id: 'M1', file: 'a.js', find: 'x', with: 'y', expectSurvive: true }])
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /expectSurvive/)
})

// --- expectSurvive: a known gap is not a failing battery ----------------------

test('summarise: a declared survivor is the expected outcome, not a failure', () => {
  const s = summarise([
    { outcome: OUTCOME.KILLED },
    { outcome: OUTCOME.SURVIVED, expectSurvive: 'CHR-061 records this gap' },
  ])
  assert.equal(s.ok, true)
  assert.equal(s.expectedSurvivors, 1)
  assert.equal(s.survived, 0)
})

test('summarise: a declared survivor that gets KILLED fails the run', () => {
  // The gap closed, or the runner is lying. Either way the spec's stated
  // assumption is stale and must not pass silently.
  const s = summarise([{ outcome: OUTCOME.KILLED, expectSurvive: 'known gap' }])
  assert.equal(s.ok, false)
  assert.equal(s.unexpectedKills, 1)
})

test('summarise: an undeclared survivor still fails the run', () => {
  assert.equal(summarise([{ outcome: OUTCOME.SURVIVED }]).ok, false)
})

test('runOne carries expectSurvive through to the result', () => {
  const deps = fakeDeps({ 'lib/x.js': 'KEEP' }, greenSuite)
  const r = runOne(
    { id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE', expectSurvive: 'why' },
    deps,
  )
  assert.equal(r.expectSurvive, 'why')
  assert.equal(r.outcome, OUTCOME.SURVIVED)
})

test('applyMutation rejects a no-op mutation', () => {
  // find === with writes the file unchanged and reports SURVIVED — inventing a
  // coverage gap out of a battery that tested nothing.
  const r = applyMutation('const a = 1;\n', { find: '= 1', with: '= 1' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'noop')
})

// --- the restore is verified, not assumed ------------------------------------

test('runOne reports ERROR when the restore does not take', () => {
  const deps = fakeDeps({ 'lib/x.js': 'KEEP\n// uncommitted fix\n' }, redSuite('t'), {
    dropRestore: true,
  })
  const r = runOne({ id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE' }, deps)
  // The file really is left mutated — that is the state being detected.
  assert.notEqual(deps.store['lib/x.js'], 'KEEP\n// uncommitted fix\n')
  assert.equal(r.outcome, OUTCOME.ERROR)
  assert.match(r.error, /restore/i)
})

// --- classifyRun: criterion 6's real derivation ------------------------------

test('classifyRun detects a timeout from spawnSync', () => {
  // spawnSync reports a timeout by killing the child: ETIMEDOUT, null status.
  const r = classifyRun({ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM', stdout: '', stderr: '' })
  assert.equal(r.timedOut, true)
})

test('classifyRun does not call a normal failure a timeout', () => {
  const r = classifyRun({ status: 1, signal: null, stdout: 'not ok 1 - x\n# fail 1\n', stderr: '' })
  assert.equal(r.timedOut, false)
  assert.equal(r.code, 1)
})

test('classifyRun merges stderr into stdout', () => {
  const r = classifyRun({ status: 0, stdout: 'a', stderr: 'b' })
  assert.equal(r.stdout, 'ab')
})

// --- preflight: refuse before writing anything -------------------------------

test('preflight refuses when a target is not in the state the spec expects', () => {
  // A leftover mutation from a killed run leaves `find` absent. Catching it here
  // is what replaces the backup file: the battery refuses to start rather than
  // compounding the damage.
  const deps = fakeDeps({ 'lib/x.js': 'ALREADY MUTATED' }, greenSuite)
  const r = preflight([{ id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE' }], deps)
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /lib\/x\.js/)
})

test('preflight passes on a clean tree and writes nothing', () => {
  const deps = fakeDeps({ 'lib/x.js': 'KEEP' }, greenSuite)
  const r = preflight([{ id: 'M1', file: 'lib/x.js', find: 'KEEP', with: 'GONE' }], deps)
  assert.equal(r.ok, true)
  assert.equal(deps.store['lib/x.js'], 'KEEP')
})

// --- the disk layer, against a real temp directory ---------------------------
// Not the fake store: this is the code that actually writes a developer's files,
// and every mutation of it survived the first round because nothing reached it.

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-test-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('makeFs reads and writes a real file under its root', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'a.js'), 'ORIGINAL')
    const fs = makeFs(dir)
    assert.equal(fs.readFile('a.js'), 'ORIGINAL')
    fs.writeFile('a.js', 'CHANGED')
    assert.equal(readFileSync(join(dir, 'a.js'), 'utf8'), 'CHANGED')
  })
})

test('acquireLock refuses a second battery while one is running', () => {
  withTempDir((dir) => {
    const fs = makeFs(dir)
    const first = acquireLock(fs, LOCK)
    assert.equal(first.ok, true)

    const second = acquireLock(fs, LOCK)
    assert.equal(second.ok, false)
    // Specifically the "already running" message, not merely any failure: the
    // generic catch-all also says "lock", so a looser regex passed even with the
    // EEXIST branch removed. The bootstrap battery caught that (M15 survived).
    //
    // This asserted /stale/ until round 5. It no longer does, and that is the fix
    // rather than a weakening: the holder here is THIS process, which is alive, so
    // calling it stale was the old message guessing. It now names the pid instead,
    // and only says "died without releasing" when the holder is really gone.
    assert.match(second.error, /already running/)
    assert.match(second.error, new RegExp(`pid ${process.pid}\\b`))
    assert.equal(second.stale, false)

    first.release()
    const third = acquireLock(fs, LOCK)
    assert.equal(third.ok, true)
    third.release()
  })
})

// --- the control run --------------------------------------------------------
// The runner had no control. Nothing established the suite was green before a
// mutation was applied, so it could not tell "my mutation killed a test" from "a
// test was already failing" — and a mutation editing a COMMENT was measured being
// reported KILLED, at exit 0, on a tree with one unrelated failure. That is
// CLAUDE.md family 1 (an instrument must be shown able to detect the thing) broken
// by the tool built to mechanise family 2.

test('baseline refuses to start when the suite is already red', () => {
  const deps = fakeDeps({}, redSuite('a test that was already failing'))
  const r = baseline(deps)
  assert.equal(r.ok, false)
  assert.match(r.error, /already/i)
  // Names the failures, so the developer can see it is nothing to do with them.
  assert.match(r.error, /a test that was already failing/)
})

test('baseline passes on a green suite and reports what it saw', () => {
  const deps = fakeDeps({}, () => ({ stdout: '# tests 616\n# pass 616\n# fail 0\n', code: 0 }))
  const r = baseline(deps)
  assert.equal(r.ok, true)
  assert.equal(r.tests, 616)
})

test('baseline refuses when the suite output cannot be read at all', () => {
  // No `# fail` line means the run did not produce a result this tool understands.
  // Starting a battery against that would attribute nonsense to every mutation.
  const deps = fakeDeps({}, () => ({ stdout: 'total nonsense', code: 0 }))
  assert.equal(baseline(deps).ok, false)
})

test('baseline reports a timeout rather than calling it green', () => {
  const deps = fakeDeps({}, () => ({ stdout: '', code: null, timedOut: true }))
  const r = baseline(deps)
  assert.equal(r.ok, false)
  assert.match(r.error, /finish/i)
})

// --- the lock names a dead holder --------------------------------------------

test('acquireLock reports a stale lock whose holder is gone', () => {
  withTempDir((dir) => {
    const fs = makeFs(dir)
    fs.exclusiveCreate(LOCK, '999999\n')
    const r = acquireLock(fs, LOCK, () => false)   // that pid is not running
    assert.equal(r.ok, false)
    assert.equal(r.stale, true)
    assert.match(r.error, /999999/)
    // The urgent fact must travel with it: a dead battery may have left a file
    // mutated, and that matters more than the lock does.
    assert.match(r.error, /mutated|swap back/i)
  })
})

test('acquireLock does not call a live holder stale', () => {
  withTempDir((dir) => {
    const fs = makeFs(dir)
    fs.exclusiveCreate(LOCK, '4242\n')
    const r = acquireLock(fs, LOCK, () => true)
    assert.equal(r.ok, false)
    assert.equal(r.stale, false)
    assert.match(r.error, /already running/)
  })
})

// --- the summary must not hide an error --------------------------------------

test('summarise counts a declared survivor that ERRORed', () => {
  // count() filtered out every expectSurvive result, so a declared survivor that
  // errored or hung landed in no bucket at all and the summary line read
  // "1 killed" while a developer's file sat modified on disk.
  const s = summarise([
    { outcome: OUTCOME.KILLED },
    { outcome: OUTCOME.ERROR, expectSurvive: 'known gap' },
  ])
  assert.equal(s.errors, 1)
  assert.equal(s.ok, false)
})

test('summarise counts a declared survivor that TIMED OUT', () => {
  const s = summarise([
    { outcome: OUTCOME.KILLED },
    { outcome: OUTCOME.TIMEOUT, expectSurvive: 'known gap' },
  ])
  assert.equal(s.timeouts, 1)
  assert.equal(s.ok, false)
})

test('isMainPath recognises the script through a symlinked path', () => {
  // `resolve()` does not resolve symlinks but `import.meta.url` is already
  // realpath'd, so the CLI guard silently failed when invoked via a symlink —
  // the whole battery skipped, no output, exit 0. A battery that never ran
  // reporting success is the exact false-GREEN this tool exists to prevent, and
  // on macOS /tmp is itself a symlink.
  withTempDir((dir) => {
    const realFile = join(dir, 'mutate.mjs')
    writeFileSync(realFile, '// script')
    const link = join(dir, 'link.mjs')
    symlinkSync(realFile, link)

    assert.equal(isMainPath(link, pathToFileURL(realFile).href), true)
    assert.equal(isMainPath(realFile, pathToFileURL(realFile).href), true)
    assert.equal(isMainPath(join(dir, 'other.mjs'), pathToFileURL(realFile).href), false)
    assert.equal(isMainPath(undefined, pathToFileURL(realFile).href), false)
  })
})

test('acquireLock leaves no lock file behind after release', () => {
  withTempDir((dir) => {
    const fs = makeFs(dir)
    const lock = acquireLock(fs, LOCK)
    lock.release()
    assert.throws(() => fs.readFile(LOCK))
  })
})
