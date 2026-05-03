export function renderTable(rows: readonly string[][]): string {
  if (rows.length === 0) return ''
  const [header] = rows
  if (header === undefined) return ''
  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  )
  return rows
    .map((row, index) =>
      row
        .map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0))
        .join(index === 0 ? '  ' : '  ')
        .trimEnd(),
    )
    .join('\n')
}
