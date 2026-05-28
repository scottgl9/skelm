import type { TuiFrontend, TuiFrontendFactory, TuiFrontendIo } from '@skelm/integrations'
import { Box, Text, render } from 'ink'
import TextInput from 'ink-text-input'
import { type ReactElement, createElement, useEffect, useState } from 'react'

/**
 * The terminal-UI frontend for the tui-assistant, built on Ink
 * (https://github.com/vadimdemedes/ink) — a React renderer for the terminal.
 * The `tui` integration knows nothing about this: it just calls `render` /
 * `renderPartial` on the {@link TuiFrontend} we return, and we call `io.submit`
 * when the user enters a line. Swapping this for any other terminal-UI library
 * (or the plain `readline` version) needs no change to skelm.
 *
 * Written with `createElement` rather than JSX so the example needs no JSX build
 * step — it loads through the same TypeScript loader the gateway uses for the
 * rest of the config.
 */

interface InkFrontendOptions {
  banner?: string
  promptLabel?: string
}

interface ChatMessage {
  role: 'you' | 'agent'
  text: string
}

export function createTerminalFrontend(options: InkFrontendOptions = {}): TuiFrontendFactory {
  const promptLabel = options.promptLabel ?? 'you'
  const banner = options.banner

  return (io: TuiFrontendIo): TuiFrontend => {
    // The chat transcript and the in-flight streaming reply live here; the Ink
    // component reads them and re-renders whenever `notify()` bumps a tick.
    const messages: ChatMessage[] = []
    let partial = ''
    let thinking = false
    const listeners = new Set<() => void>()
    const notify = (): void => {
      for (const l of listeners) l()
    }

    function App(): ReactElement {
      const [, setTick] = useState(0)
      const [value, setValue] = useState('')
      useEffect(() => {
        const onChange = (): void => setTick((n) => n + 1)
        listeners.add(onChange)
        return () => {
          listeners.delete(onChange)
        }
      }, [])

      const lines: ReactElement[] = []
      if (banner !== undefined && banner !== '') {
        lines.push(createElement(Text, { key: 'banner', bold: true, color: 'cyan' }, banner))
      }
      for (const [i, m] of messages.entries()) {
        lines.push(
          createElement(
            Text,
            { key: `m${i}`, color: m.role === 'you' ? 'green' : 'cyan' },
            `${m.role} › ${m.text}`,
          ),
        )
      }
      if (partial !== '') {
        lines.push(createElement(Text, { key: 'partial', color: 'cyan' }, `agent › ${partial}`))
      } else if (thinking) {
        lines.push(createElement(Text, { key: 'thinking', dimColor: true }, '· thinking…'))
      }

      const input = createElement(
        Box,
        { key: 'input' },
        createElement(Text, { color: 'green' }, `${promptLabel} › `),
        createElement(TextInput, {
          value,
          onChange: setValue,
          onSubmit: (text: string) => {
            const trimmed = text.trim()
            if (trimmed === '') return
            messages.push({ role: 'you', text: trimmed })
            thinking = true
            setValue('')
            io.submit(trimmed)
            notify()
          },
        }),
      )

      return createElement(Box, { flexDirection: 'column' }, ...lines, input)
    }

    const instance = render(createElement(App))

    return {
      // `step.partial` events carry the cumulative reply, so each one replaces
      // the in-flight line; render() commits it to the transcript.
      renderPartial(text: string): void {
        partial = text
        thinking = false
        notify()
      },
      render(reply: string): void {
        partial = ''
        thinking = false
        messages.push({ role: 'agent', text: reply })
        notify()
      },
      async close(): Promise<void> {
        instance.unmount()
        await instance.waitUntilExit().catch(() => {})
      },
    }
  }
}
