import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ContentPart, PromptMessage } from './backend.js'

export function textPart(text: string): ContentPart {
  return { type: 'text', text }
}

export function imagePart(opts: {
  mimeType: Extract<ContentPart, { type: 'image' }>['mimeType']
  data: string
}): ContentPart {
  return { type: 'image', mimeType: opts.mimeType, data: opts.data }
}

const EXT_TO_MIME: Record<string, Extract<ContentPart, { type: 'image' }>['mimeType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export async function imagePartFromFile(path: string): Promise<ContentPart> {
  const ext = extname(path).toLowerCase()
  const mimeType = EXT_TO_MIME[ext]
  if (mimeType === undefined) {
    throw new Error(
      `imagePartFromFile: unsupported image extension "${ext}". Supported: .png, .jpg, .jpeg, .webp, .gif`,
    )
  }
  const buffer = await readFile(path)
  return { type: 'image', mimeType, data: buffer.toString('base64') }
}

export function isMultimodal(content: PromptMessage['content']): content is readonly ContentPart[] {
  return Array.isArray(content)
}

export function messageHasImage(message: PromptMessage): boolean {
  if (!isMultimodal(message.content)) return false
  for (const part of message.content) {
    if (part.type === 'image') return true
  }
  return false
}

export function extractText(content: PromptMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}
