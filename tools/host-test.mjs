/**
 * Host-half test: exercises the `delete-session` command against a temporary
 * session directory and fake services, without a running DeepSeek Harness.
 *
 * Run with `npm test` (or `node tools/host-test.mjs`).
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
let failures = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name} ${detail}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Create a directory shaped like one persisted Session. */
async function makeSession(id, { lock = false, temp = false } = {}) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'session.jsonl')
  await writeFile(log, '{"seq":1}\n', 'utf8')
  if (lock) await writeFile(join(dir, 'session.lock'), '', 'utf8')
  if (temp) await writeFile(join(dir, 'session.tmp'), '', 'utf8')
  return { dir, log }
}

/** Build the smallest context the Host half needs and capture its command. */
function harness({ live = {}, stored = {}, archived = [], workspaces = [] } = {}) {
  const defs = []
  const events = []
  const warns = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    commands: {
      register(definition) {
        defs.push(definition)
        return () => {}
      },
    },
    sessions: { get: (id) => live[id] },
    sessionPersistence: { stat: async (id) => stored[id] },
    workspaceRegistry: {
      archivedSessionIds: archived,
      archiveSession: async (id) => {
        archived.push(id)
      },
      unarchiveSession: async (id) => {
        const index = archived.indexOf(id)
        if (index >= 0) archived.splice(index, 1)
      },
      list: () => workspaces,
    },
    logger: { warn: (message) => warns.push(message) },
    emit: (name, id) => events.push([name, id]),
  }
  apply(ctx)
  return { command: defs[0], events, warns, archived }
}

/** Execute one command run against a harness. */
async function run(command, id, input = id, whenIdle = async () => {}) {
  return command.handler({ agent: { id, whenIdle }, rawInput: input })
}

// 1. Cold session: the directory is gone shortly after success, then announced.
{
  const { dir, log } = await makeSession('cold1')
  const { command, events } = harness({ stored: { cold1: { location: { kind: 'jsonl', path: log } } } })
  const result = await run(command, 'cold1')
  check('cold: command succeeds', result.kind === 'success', JSON.stringify(result))
  check('cold: directory still present during the delay', (await stat(dir).catch(() => null)) !== null)
  await sleep(900)
  check('cold: directory removed', (await stat(dir).catch(() => null)) === null)
  check(
    'cold: removal announced once',
    events.filter(([name, id]) => name === 'api-session/removed' && id === 'cold1').length === 1,
    JSON.stringify(events),
  )
}

// 2. Live session: archived first, idle awaited, then removed.
{
  const { log } = await makeSession('live1')
  let idleWaited = false
  const { command, archived } = harness({
    live: {
      live1: {
        whenIdle: async () => {
          idleWaited = true
        },
      },
    },
    stored: { live1: { location: { kind: 'jsonl', path: log } } },
  })
  const result = await run(command, 'live1')
  check('live: command succeeds', result.kind === 'success', JSON.stringify(result))
  check('live: archived before delete', archived.includes('live1'), JSON.stringify(archived))
  check('live: idle awaited', idleWaited === true)
  await sleep(900)
  check('live: log removed', (await stat(log).catch(() => null)) === null)
}

// 3. A foreign id is refused and the session is kept.
{
  const { log } = await makeSession('guard1')
  const { command } = harness({ stored: { guard1: { location: { kind: 'jsonl', path: log } } } })
  const result = await run(command, 'guard1', 'someone-else')
  check('guard: mismatched id is an error', result.kind === 'error', JSON.stringify(result))
  await sleep(700)
  check('guard: log kept', (await stat(log).catch(() => null)) !== null)
}

// 4. An unknown session is refused.
{
  const { command } = harness()
  const result = await run(command, 'missing1')
  check('unknown: error result', result.kind === 'error' && /not found/iu.test(result.text), JSON.stringify(result))
}

// 5. Unexpected entries refuse deletion and keep the archive undone.
{
  const { dir, log } = await makeSession('unsafe1')
  await writeFile(join(dir, 'notes.txt'), 'keep me', 'utf8')
  const { command, archived } = harness({
    live: { unsafe1: { whenIdle: async () => {} } },
    stored: { unsafe1: { location: { kind: 'jsonl', path: log } } },
  })
  const result = await run(command, 'unsafe1')
  check('unsafe: error result', result.kind === 'error' && /unexpected entry/iu.test(result.text), JSON.stringify(result))
  check('unsafe: archive rolled back', !archived.includes('unsafe1'), JSON.stringify(archived))
  await sleep(700)
  const names = await readdir(dir)
  check('unsafe: directory intact', names.includes('notes.txt') && names.includes('session.jsonl'), JSON.stringify(names))
}

// 6. A memory-only session is announced immediately, with no timer needed.
{
  const { command, events } = harness({ live: { mem1: { whenIdle: async () => {} } } })
  const result = await run(command, 'mem1')
  check('memory-only: success', result.kind === 'success', JSON.stringify(result))
  check(
    'memory-only: announced immediately',
    events.some(([name, id]) => name === 'api-session/removed' && id === 'mem1'),
    JSON.stringify(events),
  )
}

// 7. Lock files and crash-left temporary files are session artifacts too.
{
  const { dir, log } = await makeSession('aux1', { lock: true, temp: true })
  const { command } = harness({ stored: { aux1: { location: { kind: 'jsonl', path: log } } } })
  const result = await run(command, 'aux1')
  check('aux: command succeeds', result.kind === 'success', JSON.stringify(result))
  await sleep(900)
  check('aux: directory removed', (await stat(dir).catch(() => null)) === null)
}

// 8. A non-jsonl session store is refused instead of guessed.
{
  const { command } = harness({ stored: { sql1: { location: { kind: 'sqlite', path: join(root, 'sql1') } } } })
  const result = await run(command, 'sql1')
  check('store: non-jsonl is an error', result.kind === 'error' && /no deletable file/iu.test(result.text), JSON.stringify(result))
}

await sleep(300)
await rm(root, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
