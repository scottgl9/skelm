import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractText,
  imagePart,
  imagePartFromFile,
  isMultimodal,
  messageHasImage,
  textPart,
} from '../src/content.js'

describe('content helpers', () => {
  it('textPart and imagePart build the expected shapes', () => {
    expect(textPart('hi')).toEqual({ type: 'text', text: 'hi' })
    expect(imagePart({ mimeType: 'image/png', data: 'AAAA' })).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'AAAA',
    })
  })

  it('isMultimodal narrows string vs array content', () => {
    expect(isMultimodal('plain')).toBe(false)
    expect(isMultimodal([textPart('hi')])).toBe(true)
  })

  it('extractText flattens text parts and ignores images', () => {
    expect(extractText('plain')).toBe('plain')
    expect(
      extractText([
        textPart('hello '),
        imagePart({ mimeType: 'image/png', data: 'AAAA' }),
        textPart('world'),
      ]),
    ).toBe('hello world')
  })

  it('messageHasImage detects image parts', () => {
    expect(messageHasImage({ role: 'user', content: 'plain' })).toBe(false)
    expect(messageHasImage({ role: 'user', content: [textPart('hi')] })).toBe(false)
    expect(
      messageHasImage({
        role: 'user',
        content: [imagePart({ mimeType: 'image/png', data: 'AAAA' })],
      }),
    ).toBe(true)
  })

  it('imagePartFromFile reads bytes and infers the mime type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-content-'))
    const png = join(dir, 'pixel.png')
    // 1x1 transparent PNG — minimum valid bytes are not needed; helper only
    // base64-encodes whatever it reads.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFileSync(png, bytes)
    const part = await imagePartFromFile(png)
    expect(part.type).toBe('image')
    if (part.type !== 'image') throw new Error('unreachable')
    expect(part.mimeType).toBe('image/png')
    expect(Buffer.from(part.data, 'base64').equals(bytes)).toBe(true)
  })

  it('imagePartFromFile rejects unknown extensions', async () => {
    await expect(imagePartFromFile('/tmp/something.bmp')).rejects.toThrow(/unsupported/)
  })
})
