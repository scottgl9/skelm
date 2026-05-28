import { type Interface as ReadlineInterface, createInterface } from 'node:readline'
import type { TuiFrontend, TuiFrontendFactory, TuiFrontendIo } from '@skelm/integrations'

/**
 * The terminal-UI frontend for the tui-assistant — the actual UI implementation,
 * which the `tui` integration knows nothing about. It owns the terminal: a
 * scrolling message log, an input prompt, and a "thinking…" status line.
 *
 * This implementation uses Node's built-in `readline` so the example has no
 * extra dependency. The integration's `TuiFrontend` contract is library-
 * agnostic, though: swap this factory for one built on a richer terminal-UI
 * package (ink, blessed, @clack/prompts, …) and nothing else changes.
 */

interface TerminalFrontendOptions {
  banner?: string
  promptLabel?: string
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  output?: NodeJS.WritableStream & { isTTY?: boolean }
  color?: boolean
}

const paint =
  (code: string, on: boolean) =>
  (s: string): string =>
    on ? `\x1b[${code}m${s}\x1b[0m` : s

export function createTerminalFrontend(options: TerminalFrontendOptions = {}): TuiFrontendFactory {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const promptLabel = options.promptLabel ?? 'you'
  const color = options.color ?? Boolean(output.isTTY)
  const banner = options.banner

  const bold = paint('1;36', color)
  const dim = paint('2', color)
  const agent = paint('36', color)
  const prompt = paint('1;32', color)

  return (io: TuiFrontendIo): TuiFrontend => {
    const rl: ReadlineInterface = createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY),
    })
    const write = (s: string): void => void output.write(`${s}\n`)
    const showPrompt = (): void => {
      rl.setPrompt(prompt(`${promptLabel} › `))
      rl.prompt()
    }

    if (banner !== undefined && banner !== '') write(bold(banner))
    write(dim('Type a message and press Enter. Ctrl-C to exit.'))
    showPrompt()

    rl.on('line', (line) => {
      const text = line.trim()
      if (text === '') {
        showPrompt()
        return
      }
      write(dim('· thinking…'))
      io.submit(text)
    })

    return {
      render(reply: string): void {
        write(agent(`agent › ${reply}`))
        showPrompt()
      },
      close(): void {
        rl.close()
      },
    }
  }
}
