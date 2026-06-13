/**
 * Reusable browser workflow helpers built on a {@link PlaywrightBrowserDriver}.
 *
 * These compose the primitive driver actions into common tasks (navigate +
 * capture an artifact, extract a DOM table) while preserving the security
 * posture: navigation still routes through the driver's egress policy and
 * screenshots still land in the supplied artifact sink, never inline.
 */

import type { ArtifactSink, PlaywrightBrowserDriver } from './driver.js'

/** Navigate to a URL and persist a screenshot through the artifact sink. */
export async function capturePageArtifact(
  driver: PlaywrightBrowserDriver,
  sink: ArtifactSink,
  input: { url: string; name?: string; selector?: string },
): Promise<{ artifact: string; contentType: string; url?: string }> {
  const nav = await driver.navigate(input.url)
  const shot = await driver.captureScreenshotArtifact(sink, {
    ...(input.selector !== undefined ? { selector: input.selector } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
  })
  return { ...shot, ...(nav.url !== undefined ? { url: nav.url } : {}) }
}

/**
 * Extract a DOM table into rows of cells. The raw extracted text is split on
 * newlines and pipe/tab boundaries; this is a best-effort normalization for
 * tables already rendered as text. For structured HTML tables, scope `selector`
 * to the `<table>` element.
 */
export async function extractTable(
  driver: PlaywrightBrowserDriver,
  input: { selector?: string },
): Promise<{ rows: readonly (readonly string[])[]; url?: string }> {
  const r = await driver.extract(input.selector !== undefined ? { selector: input.selector } : {})
  const rows = r.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .split(/\t|\s\|\s|\|/)
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0),
    )
    .filter((cells) => cells.length > 0)
  return { rows, ...(r.url !== undefined ? { url: r.url } : {}) }
}
