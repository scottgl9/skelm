import { defineConfig } from '@skelm/core'

export default defineConfig({
  storage: {
    runs: { driver: 'sqlite', path: './.skelm/test.db' },
    state: { driver: 'sqlite', path: './.skelm/test.db' },
    workspaces: {
      base: './.skelm/workspaces',
      ephemeralBase: './.skelm/tmp',
    },
  },
})
