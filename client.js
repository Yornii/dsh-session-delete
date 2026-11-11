window.__ModuleLoader__.load({
  id: '@yornni/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useSyncExternalStore } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'sessionDelete'

    /** Simplified Chinese dictionary. */
    const zh = {
      'action.delete': '删除',
      'action.deleteWithTitle': '删除“{title}”',
      'confirm.title': '删除这个会话？',
      'confirm.desc': '“{title}”及其保存的会话记录将被永久删除，无法恢复。',
      'confirm.running': '该会话还有正在运行的工作，删除前会先停止它。',
      'confirm.delete': '永久删除',
      'confirm.deleting': '正在删除…',
      'confirm.cancel': '取消',
      'error.failed': '删除失败：{message}',
      'error.unavailable': '宿主没有返回结果，删除失败。',
    }

    /** English dictionary; mirrors the Chinese key set. */
    const en = {
      'action.delete': 'Delete',
      'action.deleteWithTitle': 'Delete "{title}"',
      'confirm.title': 'Delete this session?',
      'confirm.desc': '"{title}" and its saved conversation history will be permanently deleted. This cannot be undone.',
      'confirm.running': 'This session still has running work; deleting it stops that work first.',
      'confirm.delete': 'Delete permanently',
      'confirm.deleting': 'Deleting…',
      'confirm.cancel': 'Cancel',
      'error.failed': 'Delete failed: {message}',
      'error.unavailable': 'The host returned no result, so nothing was deleted.',
    }

    /** Minimal external store consumed with `useSyncExternalStore`. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          if (next === value) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /** Closed dialog / open dialog / in-flight deletion state. */
    const state = createStore({
      open: false,
      sessionId: '',
      displayTitle: '',
      running: false,
      busy: false,
      error: null,
    })

    /** The trash outline used by the row action (14px glyph, 16px viewBox). */
    function TrashGlyph() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M2.9 4.35h10.2' }),
        h('path', { d: 'M6.35 4.35V3.1a.85.85 0 0 1 .85-.85h1.6a.85.85 0 0 1 .85.85v1.25' }),
        h('path', { d: 'M4.15 4.35l.5 8.15a.95.95 0 0 0 .95.9h4.8a.95.95 0 0 0 .95-.9l.5-8.15' }),
        h('path', { d: 'M6.6 6.8v4.1M9.4 6.8v4.1' }),
      )
    }

    /** Plugin CSS; theme tokens only, with a literal scrim and danger-button ink. */
    const CSS = `
.sd-row-action{box-sizing:border-box;width:24px;height:24px;margin:-4px 0;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;flex:none;cursor:pointer;font:inherit}
.sd-row-action:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.sd-row-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sd-row-action:active{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent)}
.sd-row-action svg{display:block;pointer-events:none}
.sd-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / 0.34);pointer-events:auto}
.sd-dialog{box-sizing:border-box;width:min(420px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;padding:20px 20px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgb(0 0 0 / 0.28)}
.sd-title{margin:0 0 8px;font-size:15px;line-height:22px;font-weight:600}
.sd-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.sd-note{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
.sd-error{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.sd-buttons{margin-top:18px;display:flex;justify-content:flex-end;gap:8px}
.sd-button{box-sizing:border-box;min-width:72px;height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.sd-button:hover:enabled{background:var(--dsw-alias-bg-layer-1)}
.sd-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sd-button:disabled{opacity:.55;cursor:default}
.sd-button-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}
.sd-button-danger:hover:enabled{background:var(--dsw-alias-state-error-primary);filter:brightness(.94)}
`

    return {
      inject: ['slots', 'locale', 'sessions', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-session-delete: dictionaries')

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@yornni/dsh-session-delete'
          tag.dataset.pluginCss = '@yornni/dsh-session-delete/row+dialog'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'dsh-session-delete: styles')

        /** Open the confirmation for one row. */
        const open = (sessionId, displayTitle) => {
          const row = ctx.sessions.list.getSnapshot().byId[sessionId]
          state.set({
            open: true,
            sessionId,
            displayTitle: displayTitle || row?.displayTitle || sessionId,
            running: row?.running === true,
            busy: false,
            error: null,
          })
        }

        /** Close the confirmation unless a deletion is in flight. */
        const close = () => {
          const current = state.get()
          if (!current.open || current.busy) return
          state.set({ ...current, open: false })
        }

        /**
         * Replace the shipped archive hover button (same cell id and order) with
         * a delete action.
         */
        function DeleteRowButton({ sessionId, displayTitle, t }) {
          return h(
            'button',
            {
              type: 'button',
              className: 'sd-row-action',
              title: t('action.delete'),
              'aria-label': t('action.deleteWithTitle', { title: displayTitle || sessionId }),
              onPointerDown: (event) => {
                event.stopPropagation()
              },
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                open(sessionId, displayTitle)
              },
            },
            h(TrashGlyph),
          )
        }

        /**
         * Frame-wide confirmation surface. Deletion runs the global
         * `delete-session` command against the row's own session id, so the Host
         * removes exactly that session.
         */
        function DeleteDialog({ t }) {
          const view = useSyncExternalStore(state.subscribe, state.get, state.get)
          const cancelRef = useRef(null)
          const confirmRef = useRef(null)

          useEffect(() => {
            if (!view.open) return
            cancelRef.current?.focus()
          }, [view.open])

          useEffect(() => {
            if (!view.open) return
            const onKeyDown = (event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              close()
            }
            document.addEventListener('keydown', onKeyDown, true)
            return () => document.removeEventListener('keydown', onKeyDown, true)
          }, [view.open])

          const confirm = useCallback(async () => {
            const current = state.get()
            if (!current.open || current.busy) return
            state.set({ ...current, busy: true, error: null })
            try {
              const result = await ctx.remote.commands.execute(
                current.sessionId,
                `/delete-session ${current.sessionId}`,
                [],
              )
              if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
              const outcome = result.value?.result
              if (outcome === undefined) throw new Error(t('error.unavailable'))
              if (outcome.kind === 'error') throw new Error(outcome.text)
              state.set({ ...state.get(), open: false, busy: false, error: null })
            } catch (cause) {
              state.set({
                ...state.get(),
                busy: false,
                error: t('error.failed', {
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
              })
            }
          }, [t])

          if (!view.open) return null

          const onDialogKeyDown = (event) => {
            if (event.key !== 'Tab') return
            const buttons = [cancelRef.current, confirmRef.current].filter((node) => node != null)
            if (buttons.length < 2) return
            const index = buttons.indexOf(document.activeElement)
            if (event.shiftKey && index <= 0) {
              event.preventDefault()
              buttons[1].focus()
            } else if (!event.shiftKey && index === buttons.length - 1) {
              event.preventDefault()
              buttons[0].focus()
            }
          }

          return h(
            'div',
            {
              className: 'sd-backdrop',
              onMouseDown: (event) => {
                if (event.target === event.currentTarget) close()
              },
            },
            h(
              'div',
              {
                className: 'sd-dialog',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-labelledby': 'sd-delete-title',
                'aria-describedby': 'sd-delete-desc',
                onMouseDown: (event) => event.stopPropagation(),
                onKeyDown: onDialogKeyDown,
              },
              h('h2', { id: 'sd-delete-title', className: 'sd-title' }, t('confirm.title')),
              h(
                'p',
                { id: 'sd-delete-desc', className: 'sd-desc' },
                t('confirm.desc', { title: view.displayTitle }),
              ),
              view.running ? h('p', { className: 'sd-note' }, t('confirm.running')) : null,
              view.error !== null
                ? h('p', { className: 'sd-error', role: 'alert' }, view.error)
                : null,
              h(
                'div',
                { className: 'sd-buttons' },
                h(
                  'button',
                  {
                    ref: cancelRef,
                    type: 'button',
                    className: 'sd-button',
                    disabled: view.busy,
                    onClick: close,
                  },
                  t('confirm.cancel'),
                ),
                h(
                  'button',
                  {
                    ref: confirmRef,
                    type: 'button',
                    className: 'sd-button sd-button-danger',
                    disabled: view.busy,
                    onClick: confirm,
                  },
                  view.busy ? t('confirm.deleting') : t('confirm.delete'),
                ),
              ),
            ),
          )
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-session-delete.confirm',
              order: 20,
              locale: NS,
            },
            DeleteDialog,
          ),
        )
        ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.row.action',
              id: 'archive',
              order: 100,
              priority: -1,
              locale: NS,
            },
            DeleteRowButton,
          ),
        )
      },
    }
  },
})
