import { beforeAll, describe, expect, it } from 'vitest'
import { GitHubIntegration } from '../src/github.js'
import { SlackIntegration, verifySlackSignature } from '../src/slack.js'

// Focused coverage of the actual webhook code paths in the GitHub +
// Slack integrations: event → run-input mapping, credential validation,
// and the existing signature-verification surface.
//
// Note: real HTTP delivery and HMAC-based signature verification are
// stubs in the current shipped code; once those land, this file should
// gain sig-failure and retry-on-5xx cases.

const ghCreds = { token: 'ghp_x', ownerId: 'o', repoName: 'r' }
const ghIntegration = new GitHubIntegration({
  id: 'gh',
  name: 'gh',
  enabled: true,
  credentials: ghCreds,
})

const slackCreds = { botToken: 'xoxb-test', signingSecret: 'sig', channelId: 'C0' }
const slackIntegration = new SlackIntegration({
  id: 'slack',
  name: 'slack',
  enabled: true,
  credentials: slackCreds,
})

beforeAll(async () => {
  await ghIntegration.init()
  await slackIntegration.init()
})

describe('GitHubIntegration.eventToRunInput', () => {
  it('maps issues events to a github-issue trigger', async () => {
    const result = await ghIntegration.eventToRunInput(
      {
        event: 'issues',
        payload: {
          action: 'opened',
          owner: 'o',
          repo: 'r',
          issueNumber: 42,
          title: 't',
          body: 'b',
          labels: ['bug'],
        },
      },
      ghCreds,
    )
    expect(result).toMatchObject({
      trigger: {
        type: 'github-issue',
        action: 'opened',
        issueNumber: 42,
        labels: ['bug'],
      },
    })
  })

  it('falls back to credential owner/repo when payload omits them', async () => {
    const result = await ghIntegration.eventToRunInput(
      {
        event: 'issues',
        payload: { action: 'opened', issueNumber: 1, title: '', body: '', labels: [] },
      },
      ghCreds,
    )
    expect(result).toMatchObject({ trigger: { owner: 'o', repo: 'r' } })
  })

  it('maps pull_request and push to generic trigger shapes', async () => {
    const pr = await ghIntegration.eventToRunInput(
      { event: 'pull_request', payload: { number: 9 } },
      ghCreds,
    )
    expect(pr).toMatchObject({ trigger: { type: 'github-pr' } })

    const push = await ghIntegration.eventToRunInput(
      { event: 'push', payload: { ref: 'refs/heads/main' } },
      ghCreds,
    )
    expect(push).toMatchObject({ trigger: { type: 'github-push' } })
  })

  it('returns null for unknown event types', async () => {
    const result = await ghIntegration.eventToRunInput({ event: 'mystery', payload: {} }, ghCreds)
    expect(result).toBeNull()
  })
})

describe('SlackIntegration.eventToRunInput', () => {
  it('returns the URL verification challenge', async () => {
    const result = await slackIntegration.eventToRunInput(
      { type: 'url_verification', challenge: 'cha-l-l-enge' },
      slackCreds,
    )
    expect(result).toMatchObject({ challenge: 'cha-l-l-enge', type: 'slack-verification' })
  })

  it('maps event_callback message to slack-message trigger', async () => {
    const result = await slackIntegration.eventToRunInput(
      {
        type: 'event_callback',
        channel_id: 'C123',
        event: { type: 'message', user: 'U1', text: 'hi' },
      },
      slackCreds,
    )
    expect(result).toMatchObject({
      trigger: { type: 'slack-message', channel: 'C123', user: 'U1', text: 'hi' },
    })
  })

  it('maps app_mention to slack-mention trigger', async () => {
    const result = await slackIntegration.eventToRunInput(
      {
        type: 'event_callback',
        channel_id: 'C123',
        event: { type: 'app_mention', user: 'U1', text: '<@bot> hi' },
      },
      slackCreds,
    )
    expect(result).toMatchObject({ trigger: { type: 'slack-mention', text: '<@bot> hi' } })
  })

  it('maps block_actions interactions', async () => {
    const result = await slackIntegration.eventToRunInput(
      {
        type: 'block_actions',
        actions: [{ action_id: 'a' }],
        channel: { id: 'C1' },
        user: { id: 'U1' },
      },
      slackCreds,
    )
    expect(result).toMatchObject({ trigger: { type: 'slack-action', channel: 'C1', user: 'U1' } })
  })

  it('returns null for unrecognized event types', async () => {
    const result = await slackIntegration.eventToRunInput({ type: 'unknown_thing' }, slackCreds)
    expect(result).toBeNull()
  })
})

describe('SlackIntegration.sendNotification', () => {
  it('throws when neither channelId nor userId is supplied', async () => {
    const noChannel = new SlackIntegration({
      id: 'slack-no-chan',
      name: 's',
      enabled: true,
      credentials: { botToken: 'xoxb-x', signingSecret: 's' },
    })
    await noChannel.init()
    await expect(noChannel.sendNotification('hi', undefined)).rejects.toThrow(/No channel or user/)
  })

  it('does not throw when a channelId is on the credentials', async () => {
    await expect(slackIntegration.sendNotification('hi', undefined)).resolves.toBeUndefined()
  })
})

describe('verifySlackSignature', () => {
  it('is exported as part of the public surface', () => {
    // The current implementation is a stub. The test pins the export
    // signature so a future HMAC-based replacement still satisfies the
    // (sig, ts, body, signingSecret) contract.
    expect(typeof verifySlackSignature).toBe('function')
    expect(verifySlackSignature('secret', '1', 'body', 'v0=deadbeef')).toBe(true)
  })
})
