import { describe, expect, it } from 'vitest'
import { type TurnFn, createFrontendHost } from '../src/tui.js'

// Exercises the frontend-driving logic without a TTY: a fake frontend captures
// the bridge io and records render/renderPartial; a fake turn returns canned
// replies. The real Ink frontend + SIGINT lifecycle are glue exercised by the
// example, not here.

describe('createFrontendHost', () => {
  it('runs a turn per submitted line, streaming partials then committing the reply', async () => {
    const partials: string[] = []
    const rendered: string[] = []
    const turn: TurnFn = async (text, onPartial) => {
      onPartial('hel')
      onPartial('hello')
      return `reply:${text}`
    }
    let submit: ((t: string) => void) | undefined
    const host = createFrontendHost(
      (io) => {
        submit = io.submit
        return {
          render: (reply) => rendered.push(reply),
          renderPartial: (t) => partials.push(t),
        }
      },
      'sess',
      turn,
    )
    submit?.('hi')
    await host.idle()
    expect(partials).toEqual(['hel', 'hello'])
    expect(rendered).toEqual(['reply:hi'])
  })

  it('ignores blank lines', async () => {
    const rendered: string[] = []
    let submit: ((t: string) => void) | undefined
    const host = createFrontendHost(
      (io) => {
        submit = io.submit
        return { render: (r) => rendered.push(r) }
      },
      'sess',
      async (text) => text,
    )
    submit?.('   ')
    await host.idle()
    expect(rendered).toEqual([])
  })

  it('serializes turns submitted while one is in flight', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    const turn: TurnFn = async (text) => {
      order.push(`start:${text}`)
      if (first) {
        first = false
        await gate
      }
      order.push(`done:${text}`)
      return text
    }
    let submit: ((t: string) => void) | undefined
    const host = createFrontendHost(
      (io) => {
        submit = io.submit
        return { render: () => {} }
      },
      'sess',
      turn,
    )
    submit?.('a')
    submit?.('b') // queues behind 'a'
    expect(order).toEqual(['start:a'])
    release()
    await host.idle()
    expect(order).toEqual(['start:a', 'done:a', 'start:b', 'done:b'])
  })
})
