import { pipeline, wait } from '@skelm/core'
import { z } from 'zod'

export default pipeline<unknown, { approved: boolean }>({
  id: 'wait-fixture',
  steps: [
    wait({
      id: 'approval',
      message: 'approval required',
      output: z.object({ approved: z.boolean() }),
    }),
  ],
})
