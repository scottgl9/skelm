import fg from 'fast-glob'

const SKIP_DIRS = ['node_modules', 'dist', 'coverage', '.git', '.skelm', '.next']

export async function walkGlob(rootDir: string, pattern: string): Promise<string[]> {
  const entries = await fg(pattern, {
    cwd: rootDir,
    absolute: true,
    onlyFiles: true,
    ignore: SKIP_DIRS.map((dir) => `**/${dir}/**`),
  })
  return entries.sort()
}
