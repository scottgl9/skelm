import { code, pipeline } from '@skelm/core'

export default pipeline({
  id: 'clean',
  steps: [code({ id: 'pure', run: () => ({ ok: true }) })],
})
