import { pipeline } from '@skelm/core'
import { check, summarizeChecks } from '@skelm/core/testing'
import { migrateN8nWorkflow } from '@skelm/migration-n8n'

const SIMPLE = JSON.stringify({
  name: 'http set if',
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', position: [0, 0] },
    { name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', position: [200, 0] },
    { name: 'Set', type: 'n8n-nodes-base.set', position: [400, 0] },
    { name: 'IF', type: 'n8n-nodes-base.if', position: [600, 0] },
  ],
  connections: {},
})

const CHECK_IDS = ['mapsCleanly', 'flagsUnsupported', 'rejectsMalformed'] as const

export default pipeline({
  id: 'self-test',
  description: 'Self-test for @skelm/migration-n8n.',
  steps: [
    check({
      id: 'mapsCleanly',
      run: () => {
        const result = migrateN8nWorkflow(SIMPLE)
        if (result.requiredIntegrations[0] !== '@skelm/integration-http') {
          throw new Error(`missing http integration: ${result.requiredIntegrations.join(',')}`)
        }
        if (!result.source.includes('triggers:')) throw new Error('webhook trigger not emitted')
        if (!result.source.includes('branch(')) throw new Error('IF not mapped to branch')
        if (result.unsupported.length !== 0) {
          throw new Error(`unexpected unsupported: ${result.unsupported.join(',')}`)
        }
        return result.pipelineId
      },
    }),
    check({
      id: 'flagsUnsupported',
      run: () => {
        const result = migrateN8nWorkflow(
          JSON.stringify({
            name: 'has mystery',
            nodes: [{ name: 'Mystery', type: 'n8n-nodes-base.mysteryThing' }],
            connections: {},
          }),
        )
        if (!result.unsupported.includes('Mystery')) throw new Error('node not flagged')
        if (!result.source.includes('UNSUPPORTED')) throw new Error('TODO not emitted')
        return result.unsupported
      },
    }),
    check({
      id: 'rejectsMalformed',
      run: () => {
        try {
          migrateN8nWorkflow('{ not json')
          throw new Error('expected N8nImportError')
        } catch (err) {
          if (err instanceof Error && err.name === 'N8nImportError') return 'rejected'
          throw err
        }
      },
    }),
  ],
  finalize: (ctx) => summarizeChecks('migration-n8n', [...CHECK_IDS], ctx, Date.now()),
})
