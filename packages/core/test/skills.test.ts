import { describe, expect, it } from 'vitest'
import { type Skill, SkillParseError, parseSkill } from '../src/skills.js'

describe('parseSkill', () => {
  it('parses minimal frontmatter + body', () => {
    const s = parseSkill('memory://write-tests', '---\nid: write-tests\n---\nWrite the tests.')
    expect(s.id).toBe('write-tests')
    expect(s.body).toBe('Write the tests.')
    expect(s.description).toBeUndefined()
    expect(s.allowedWorkflows).toBeUndefined()
    expect(s.source).toBe('memory://write-tests')
  })

  it('parses description and allowedWorkflows arrays', () => {
    const s = parseSkill(
      'memory://x',
      '---\nid: x\ndescription: do a thing\nallowedWorkflows: [build-pr, sync-issues]\n---\nbody',
    )
    expect(s.description).toBe('do a thing')
    expect(s.allowedWorkflows).toEqual(['build-pr', 'sync-issues'])
  })

  it('handles quoted string values', () => {
    const s = parseSkill('memory://q', '---\nid: q\ndescription: "value with: colon"\n---\nbody')
    expect(s.description).toBe('value with: colon')
  })

  it('handles empty array', () => {
    const s = parseSkill('memory://e', '---\nid: e\nallowedWorkflows: []\n---\nbody')
    expect(s.allowedWorkflows).toEqual([])
  })

  it('preserves unknown frontmatter keys in metadata', () => {
    const s = parseSkill('memory://m', '---\nid: m\ncategory: review\nowner: alice\n---\nbody')
    expect(s.metadata.category).toBe('review')
    expect(s.metadata.owner).toBe('alice')
  })

  it('preserves structured YAML metadata', () => {
    const s = parseSkill(
      'memory://structured',
      [
        '---',
        'id: structured',
        'enabled: true',
        'limits:',
        '  maxFiles: 3',
        'tags:',
        '  - review',
        '  - tests',
        '---',
        'body',
      ].join('\n'),
    )
    expect(s.metadata.enabled).toBe(true)
    expect(s.metadata.limits).toEqual({ maxFiles: 3 })
    expect(s.metadata.tags).toEqual(['review', 'tests'])
  })

  it('skips blank lines and comment lines in frontmatter', () => {
    const s = parseSkill(
      'memory://c',
      '---\n# comment\nid: c\n\n# another\ndescription: ok\n---\nbody',
    )
    expect(s.id).toBe('c')
    expect(s.description).toBe('ok')
  })

  it('strips leading BOM', () => {
    const raw = '﻿---\nid: bom\n---\nbody'
    const s = parseSkill('memory://bom', raw)
    expect(s.id).toBe('bom')
  })

  it('handles CRLF line endings', () => {
    const raw = '---\r\nid: crlf\r\ndescription: yes\r\n---\r\nbody'
    const s = parseSkill('memory://crlf', raw)
    expect(s.id).toBe('crlf')
    expect(s.description).toBe('yes')
  })

  it('throws SkillParseError on missing frontmatter', () => {
    expect(() => parseSkill('memory://bad', 'no fence here')).toThrowError(SkillParseError)
  })

  it('throws on missing id', () => {
    expect(() => parseSkill('memory://bad', '---\ndescription: oops\n---\nbody')).toThrow(
      /must include `id/,
    )
  })

  it('throws on a frontmatter line missing colon', () => {
    expect(() => parseSkill('memory://bad', '---\nid: ok\nbroken line\n---\nbody')).toThrow(
      /malformed frontmatter/,
    )
  })

  it('SkillParseError carries the source path', () => {
    try {
      parseSkill('/abs/path/SKILL.md', 'no fence')
    } catch (err) {
      expect(err).toBeInstanceOf(SkillParseError)
      expect((err as SkillParseError).source).toBe('/abs/path/SKILL.md')
      expect((err as SkillParseError).message).toContain('/abs/path/SKILL.md')
      return
    }
    throw new Error('expected throw')
  })

  it('Skill metadata is frozen', () => {
    const s: Skill = parseSkill('memory://f', '---\nid: f\nfoo: bar\n---\nbody')
    expect(Object.isFrozen(s.metadata)).toBe(true)
  })
})
