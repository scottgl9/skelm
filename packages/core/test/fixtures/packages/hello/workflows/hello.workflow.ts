// Fixture workflow entry for the @skelm/hello fixture package. Never
// executed by the substrate tests — copied and hashed as package content.
import { code, pipeline } from '@skelm/core'

export default pipeline({
  id: 'hello',
  steps: [code({ id: 'greet', run: () => ({ greeting: 'hello' }) })],
})
