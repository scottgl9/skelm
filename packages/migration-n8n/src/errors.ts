/** Thrown when an n8n workflow export cannot be parsed or fails validation. */
export class N8nImportError extends Error {
  override readonly name = 'N8nImportError'
  /** Field path or token that explains where validation failed. */
  readonly field?: string
  constructor(message: string, field?: string) {
    super(message)
    if (field !== undefined) {
      this.field = field
    }
  }
}
