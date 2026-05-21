// Fixture module for code-module.test.ts — named export form.
export async function handler(_ctx: unknown): Promise<{ value: string }> {
  return { value: 'from-named' }
}
