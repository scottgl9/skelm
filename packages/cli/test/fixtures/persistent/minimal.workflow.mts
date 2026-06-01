import { persistentWorkflow } from '@skelm/core'

// A MINIMAL persistent workflow: no preamble `steps`, just the terminal agent.
// This is the shape that exposed the loader bug — it is not pipeline-shaped
// (no `steps` array), so the old `loadWorkflowFromFile` rejected it.
interface Msg {
  sessionId: string
  text: string
}

export default persistentWorkflow<Msg>({
  id: 'fixture-persistent',
  triggers: [{ kind: 'queue', sourceId: 'q' }],
  agent: {
    backend: 'echo',
    sessionKey: (m) => m.sessionId,
    reply: (t) => ({ reply: t }),
  },
})
