import type { ChatUiFrontend, ChatUiFrontendFactory, ChatUiFrontendIo } from '@skelm/integrations'
import { Box, Text, render, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { type ReactElement, createElement, useEffect, useState } from 'react'

/**
 * Terminal-UI frontend for the builder, built on Ink (a React renderer for the
 * terminal). This is the `tui` transport of the `chatui` integration: the
 * integration just calls `render` / `renderPartial` on the frontend we return,
 * and we call `io.submit` when the user enters a line. Written with
 * `createElement` rather than JSX so no JSX build step is needed.
 */

interface InkFrontendOptions {
  banner?: string
  promptLabel?: string
}

interface ChatLine {
  role: 'you' | 'builder'
  text: string
}

export function createTerminalFrontend(options: InkFrontendOptions = {}): ChatUiFrontendFactory {
  const promptLabel = options.promptLabel ?? 'you'
  const banner = options.banner

  return (io: ChatUiFrontendIo): ChatUiFrontend => {
    const messages: ChatLine[] = []
    let partial = ''
    let thinking = false
    const listeners = new Set<() => void>()
    const notify = (): void => {
      for (const l of listeners) l()
    }

    function App(): ReactElement {
      const { exit } = useApp()
      const [, setTick] = useState(0)
      const [value, setValue] = useState('')
      useEffect(() => {
        const onChange = (): void => setTick((n) => n + 1)
        listeners.add(onChange)
        return () => {
          listeners.delete(onChange)
        }
      }, [])
      useInput((input, key) => {
        if (key.ctrl && input === 'c') {
          io.close?.()
          exit()
        }
      })

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
        lines.push(createElement(Text, { key: 'partial', color: 'cyan' }, `builder › ${partial}`))
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

    const instance = render(createElement(App), { exitOnCtrlC: false })

    return {
      renderPartial(text: string): void {
        partial = text
        thinking = false
        notify()
      },
      render(reply: string): void {
        partial = ''
        thinking = false
        messages.push({ role: 'builder', text: reply })
        notify()
      },
      async close(): Promise<void> {
        instance.unmount()
        await instance.waitUntilExit().catch(() => {})
      },
    }
  }
}
