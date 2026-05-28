import { describe, expect, it } from 'vitest'
import { formatDelegatedStartMessage } from '../src/gateway.js'

// s28/systemd-delegation-start regression: when `skelm gateway start` (no
// --foreground) delegates to systemctl --user because a managed unit is
// installed, the CLI's stdout MUST surface the delegated command (mirroring
// stopGateway's "stopped (systemctl --user stop skelm-gateway)" message).
// Otherwise operators — and the live self-test harness — cannot distinguish
// the systemd-delegated path from the ad-hoc background detach path.
describe('formatDelegatedStartMessage', () => {
  it('surfaces the systemctl command on systemd delegation', () => {
    const msg = formatDelegatedStartMessage({
      manager: 'systemd',
      url: 'http://127.0.0.1:14738',
      logCmd: 'journalctl --user -u skelm-gateway -f',
    })
    // The s28 self-test regex: /systemctl --user start skelm-gateway|already.*active/i
    expect(msg).toMatch(/systemctl --user start skelm-gateway/)
    expect(msg).toContain('url: http://127.0.0.1:14738')
    expect(msg).toContain('journalctl --user -u skelm-gateway -f')
  })

  it('does NOT use the ambiguous "(background service)" wording the bug surfaced', () => {
    const msg = formatDelegatedStartMessage({
      manager: 'systemd',
      url: null,
      logCmd: 'journalctl --user -u skelm-gateway -f',
    })
    expect(msg).not.toMatch(/\(background service\)/)
    // null url falls back to (pending) (same as the pre-fix code did).
    expect(msg).toContain('url: (pending)')
  })

  it('surfaces the launchctl command on launchd delegation', () => {
    const msg = formatDelegatedStartMessage({
      manager: 'launchd',
      url: 'http://127.0.0.1:14738',
      logCmd: 'tail -f /tmp/gateway.log',
    })
    expect(msg).toMatch(/launchctl kickstart gui\/\d+\/[^\s)]+/)
  })
})
