/**
 * Host half of the dsh-session-delete plugin.
 *
 * The JSONL session-persistence seam owns no deletion API, so this plugin
 * deletes one session-owned directory after proving that it only contains
 * session artifacts. The sidebar's delete button reaches this code through the
 * global `delete-session` human command, which the plugin's own client half
 * runs against the session being deleted.
 *
 * @module @yornni/dsh-session-delete
 */
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** A canonical JSONL session generation file: `session[.vN].jsonl[.zstd]`. */
const SESSION_LOG_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u
/** Per-session bookkeeping beside a generation: the lock file and crash-left temporary files. */
const SESSION_AUX_FILE = /^(?:session\.lock|.+\.tmp)$/u
/** Upper bound on how long deletion waits for stopped work to quiesce. */
const IDLE_WAIT_MS = 2500
/**
 * Delay before the validated directory is removed. The command runner appends
 * its own `command/done`/result events to this session's log right after the
 * handler returns; waiting first lets those writes land in the log that is then
 * deleted, instead of re-creating the directory afterwards.
 */
const DELETION_DELAY_MS = 400

export const inject = ['commands', 'sessions', 'sessionPersistence', 'workspaceRegistry']

/**
 * Register the host command used by the plugin's sidebar action.
 * @param ctx - plugin context carrying the Session, persistence, Workspace, and command services.
 */
export function apply(ctx) {
  /** Deletions scheduled but not yet executed; cleared when the plugin unloads. */
  const pending = new Set()
  ctx.effect(
    () => () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    },
    'dsh-session-delete: pending deletions',
  )
  ctx.effect(
    () => {
      try {
        return ctx.commands.register({
          name: 'delete-session',
          description: 'Permanently delete this session and its saved history',
          input: { hint: '<this-session-id>' },
          handler: (invocation) => deleteSession(ctx, invocation, pending),
        })
      } catch (cause) {
        if (!isDuplicateCommand(cause)) throw cause
        // A previous generation of this plugin (for example the pre-rename
        // `@local/session-delete` instance) can still be mounted after a live
        // profile update. The command name is process-global, so keep the
        // existing handler and the rest of this plugin alive instead of
        // failing the whole load; restarting DSH drops the stale instance.
        ctx.logger?.warn?.(
          'dsh-session-delete: delete-session is already registered; keeping the existing handler (restart DSH to drop a stale plugin instance)',
        )
        return () => {}
      }
    },
    'dsh-session-delete: delete-session command',
  )
}

/**
 * Whether a registration failed only because another plugin instance already
 * owns this command name.
 * @param cause - thrown registration error.
 * @returns true for the command registry's duplicate-name error.
 */
function isDuplicateCommand(cause) {
  return cause instanceof Error && /^command "delete-session" is already registered\b/u.test(cause.message)
}

/**
 * Command handler: delete exactly the session the command runs in.
 * @param ctx - plugin context.
 * @param invocation - admitted command invocation.
 * @param pending - timers for deletions that are scheduled but not yet executed.
 * @returns the normalized command result; never throws for an expected failure.
 */
async function deleteSession(ctx, invocation, pending) {
  const sessionId = invocation.agent.id
  const requested = String(invocation.rawInput ?? '').trim()
  if (requested !== sessionId) {
    return failure(`Usage: /delete-session ${sessionId} — the id must name the session this command runs in.`)
  }
  try {
    return await removeSession(ctx, sessionId, pending)
  } catch (cause) {
    return failure(`Could not delete session "${sessionId}": ${messageOf(cause)}`)
  }
}

/**
 * Stop and hide a live session, remove its Workspace accounting, validate its
 * session-owned directory, and schedule the removal. The directory disappears a
 * moment later so the command runner's own writes do not re-create it; the
 * Client is told when the directory is actually gone.
 * @param ctx - plugin context.
 * @param sessionId - ordinary session identity.
 * @param pending - timers for deletions that are scheduled but not yet executed.
 * @returns the command result.
 */
async function removeSession(ctx, sessionId, pending) {
  const live = ctx.sessions.get(sessionId)
  const stored = await ctx.sessionPersistence.stat(sessionId)
  if (live === undefined && stored === undefined) return failure(`Session "${sessionId}" was not found.`)

  let archivedHere = false
  if (live !== undefined) {
    if (!ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      // Archiving is what keeps a live (in-memory) session hidden after a page
      // refresh: the list merges live sessions even when their log is gone.
      await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
      archivedHere = true
    }
    await waitForIdle(live)
  }

  const snapshot = (await ctx.sessionPersistence.stat(sessionId)) ?? stored
  const location = snapshot?.location
  detachFromWorkspaces(ctx, sessionId)
  if (location === undefined) {
    ctx.emit('api-session/removed', sessionId)
    return { kind: 'success', text: `Deleted session "${sessionId}".` }
  }

  let directory
  try {
    if (location.kind !== 'jsonl') throw new Error(`session store "${location.kind}" has no deletable file`)
    directory = await assertSessionDirectory(location.path)
  } catch (cause) {
    if (archivedHere) await rollbackArchive(ctx, sessionId)
    throw cause
  }

  const timer = setTimeout(() => {
    pending.delete(timer)
    void finishDeletion(ctx, sessionId, directory, archivedHere)
  }, DELETION_DELAY_MS)
  timer.unref?.()
  pending.add(timer)
  return { kind: 'success', text: `Deleting session "${sessionId}".` }
}

/**
 * Remove a validated session directory and announce the removal.
 * @param ctx - plugin context.
 * @param sessionId - session being deleted.
 * @param directory - validated session-owned directory.
 * @param archivedHere - whether this run archived the live session.
 */
async function finishDeletion(ctx, sessionId, directory, archivedHere) {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  } catch (cause) {
    ctx.logger?.warn?.(`dsh-session-delete: removing "${directory}" failed: ${messageOf(cause)}`)
    if (archivedHere) await rollbackArchive(ctx, sessionId)
    return
  }
  // Forwarded through the application event allowlist; the Client catalog drops
  // the row without waiting for another `session.list` refresh. A later
  // `session/disposed` (if the residency ends) repeats it harmlessly.
  ctx.emit('api-session/removed', sessionId)
}

/**
 * Undo the archive applied by a deletion that could not finish.
 * @param ctx - plugin context.
 * @param sessionId - session whose archive should be rolled back.
 */
async function rollbackArchive(ctx, sessionId) {
  try {
    await ctx.workspaceRegistry.unarchiveSession(sessionId)
  } catch {
    /* the archive marker is harmless when the rollback itself fails */
  }
}

/**
 * Drop the session's accounting slot from every Workspace. Detach failures are
 * non-fatal: the deleted log can no longer be listed, and the next registry
 * mutation prunes stale accounts.
 * @param ctx - plugin context.
 * @param sessionId - session being deleted.
 */
function detachFromWorkspaces(ctx, sessionId) {
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    workspace.detachSession(sessionId).catch((cause) => {
      ctx.logger?.warn?.(`dsh-session-delete: detaching "${sessionId}" from workspace "${workspace.id}" failed: ${messageOf(cause)}`)
    })
  }
}

/**
 * Wait, bounded, for a just-stopped Agent to reach quiescence so no append is
 * still in flight when its log directory disappears.
 * @param agent - the live agent for the session.
 */
async function waitForIdle(agent) {
  if (typeof agent.whenIdle !== 'function') return
  await Promise.race([
    Promise.resolve(agent.whenIdle()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, IDLE_WAIT_MS)),
  ])
}

/**
 * Prove that a persistence-reported log path names one session-owned directory
 * whose only entries are session artifacts, and return that directory.
 * @param logPath - absolute path of the selected physical generation.
 * @returns the session-owned directory to remove.
 */
async function assertSessionDirectory(logPath) {
  if (!SESSION_LOG_FILE.test(basename(logPath))) {
    throw new Error(`refusing to delete "${logPath}": not a session log file`)
  }
  const directory = dirname(logPath)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (cause) {
    if (cause?.code === 'ENOENT') return directory
    throw cause
  }
  if (entries.length === 0) return directory
  if (!entries.some((entry) => entry.isFile() && SESSION_LOG_FILE.test(entry.name))) {
    throw new Error(`refusing to delete "${directory}": no session log found`)
  }
  for (const entry of entries) {
    if (entry.isFile() && (SESSION_LOG_FILE.test(entry.name) || SESSION_AUX_FILE.test(entry.name))) continue
    throw new Error(`refusing to delete "${directory}": unexpected entry "${entry.name}"`)
  }
  return directory
}

/**
 * Build an error command result.
 * @param text - caller-facing failure text.
 * @returns the normalized error result.
 */
function failure(text) {
  return { kind: 'error', text }
}

/**
 * Render one failure reason.
 * @param cause - thrown value.
 * @returns its message or string form.
 */
function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}
