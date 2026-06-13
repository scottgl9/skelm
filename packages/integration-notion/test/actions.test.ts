import { describe, expect, it } from 'vitest'
import {
  NOTION_ACTIONS,
  NOTION_VERSION,
  appendBlockChildren,
  createNotionClient,
  createPage,
  getPage,
  queryDatabase,
  search,
  updatePage,
} from '../src/index.js'
import { allowAll, fakeFetch } from './helpers.js'

const TOKEN = 'secret_ntn_token'

function client(f: ReturnType<typeof fakeFetch>) {
  return createNotionClient({ token: TOKEN }, { egress: allowAll, fetchImpl: f.fetchImpl })
}

describe('NOTION_ACTIONS', () => {
  it('declares the six documented actions, each requiring network', () => {
    const ids = NOTION_ACTIONS.map((a) => a.id)
    expect(ids).toEqual([
      'notion.queryDatabase',
      'notion.createPage',
      'notion.updatePage',
      'notion.getPage',
      'notion.appendBlockChildren',
      'notion.search',
    ])
    for (const action of NOTION_ACTIONS) {
      expect(action.requiredPermissions).toContain('network')
    }
  })
})

describe('queryDatabase', () => {
  it('shapes the query body and paginates across cursors to exhaustion', async () => {
    const f = fakeFetch([
      {
        body: {
          object: 'list',
          results: [{ object: 'page', id: 'p1', properties: {} }],
          next_cursor: 'cursor-2',
          has_more: true,
        },
      },
      {
        body: {
          object: 'list',
          results: [{ object: 'page', id: 'p2', properties: {} }],
          next_cursor: null,
          has_more: false,
        },
      },
    ])

    const pages = await queryDatabase(client(f), {
      databaseId: 'db-1',
      filter: { property: 'Status', select: { equals: 'Done' } },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      pageSize: 50,
    })

    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(f.requests).toHaveLength(2)

    const first = f.bodyAt(0)
    expect(first).toEqual({
      filter: { property: 'Status', select: { equals: 'Done' } },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      page_size: 50,
    })
    expect(f.requestAt(0).url).toBe('https://api.notion.com/v1/databases/db-1/query')
    expect(f.requestAt(0).headers['notion-version']).toBe(NOTION_VERSION)

    const second = f.bodyAt(1)
    expect(second.start_cursor).toBe('cursor-2')
  })

  it('respects maxPages', async () => {
    const f = fakeFetch([
      {
        body: {
          object: 'list',
          results: [{ object: 'page', id: 'p1', properties: {} }],
          next_cursor: 'cursor-2',
          has_more: true,
        },
      },
    ])

    const pages = await queryDatabase(client(f), { databaseId: 'db-1', maxPages: 1 })
    expect(pages.map((p) => p.id)).toEqual(['p1'])
    expect(f.requests).toHaveLength(1)
  })

  it('sends an empty body when no filter/sort/pageSize given', async () => {
    const f = fakeFetch([
      { body: { object: 'list', results: [], next_cursor: null, has_more: false } },
    ])
    await queryDatabase(client(f), { databaseId: 'db-1' })
    expect(f.bodyAt(0)).toEqual({})
  })
})

describe('createPage', () => {
  it('shapes parent/properties/children and maps the page response', async () => {
    const f = fakeFetch([
      {
        body: { object: 'page', id: 'new-page', url: 'https://notion.so/new-page', properties: {} },
      },
    ])

    const page = await createPage(client(f), {
      parent: { database_id: 'db-1' },
      properties: { Name: { title: [{ text: { content: 'Hi' } }] } },
      children: [{ object: 'block', type: 'paragraph' }],
    })

    expect(page.id).toBe('new-page')
    expect(f.requestAt(0).url).toBe('https://api.notion.com/v1/pages')
    expect(f.requestAt(0).method).toBe('POST')
    const body = f.bodyAt(0)
    expect(body.parent).toEqual({ database_id: 'db-1' })
    expect(body.properties).toEqual({ Name: { title: [{ text: { content: 'Hi' } }] } })
    expect(body.children).toHaveLength(1)
  })
})

describe('updatePage', () => {
  it('shapes a PATCH with properties and archived', async () => {
    const f = fakeFetch([{ body: { object: 'page', id: 'p1', archived: true, properties: {} } }])

    const page = await updatePage(client(f), {
      pageId: 'p1',
      properties: { Status: { select: { name: 'Done' } } },
      archived: true,
    })

    expect(page.id).toBe('p1')
    expect(f.requestAt(0).method).toBe('PATCH')
    expect(f.requestAt(0).url).toBe('https://api.notion.com/v1/pages/p1')
    const body = f.bodyAt(0)
    expect(body.properties).toEqual({ Status: { select: { name: 'Done' } } })
    expect(body.archived).toBe(true)
  })

  it('omits archived when not provided', async () => {
    const f = fakeFetch([{ body: { object: 'page', id: 'p1', properties: {} } }])
    await updatePage(client(f), { pageId: 'p1', properties: { A: 1 } })
    const body = f.bodyAt(0)
    expect('archived' in body).toBe(false)
  })
})

describe('getPage', () => {
  it('issues a GET to the page path', async () => {
    const f = fakeFetch([{ body: { object: 'page', id: 'p1', properties: {} } }])
    const page = await getPage(client(f), 'p1')
    expect(page.id).toBe('p1')
    expect(f.requestAt(0).method).toBe('GET')
    expect(f.requestAt(0).url).toBe('https://api.notion.com/v1/pages/p1')
  })
})

describe('appendBlockChildren', () => {
  it('shapes a PATCH with children and maps the returned blocks', async () => {
    const f = fakeFetch([
      {
        body: {
          object: 'list',
          results: [{ object: 'block', id: 'b-new', type: 'paragraph' }],
          next_cursor: null,
          has_more: false,
        },
      },
    ])

    const blocks = await appendBlockChildren(client(f), {
      blockId: 'b1',
      children: [{ object: 'block', type: 'paragraph' }],
    })

    expect(blocks.map((b) => b.id)).toEqual(['b-new'])
    expect(f.requestAt(0).method).toBe('PATCH')
    expect(f.requestAt(0).url).toBe('https://api.notion.com/v1/blocks/b1/children')
    expect(f.bodyAt(0).children).toHaveLength(1)
  })
})

describe('search', () => {
  it('shapes the search body and paginates', async () => {
    const f = fakeFetch([
      {
        body: {
          object: 'list',
          results: [{ object: 'page', id: 'p1' }],
          next_cursor: 'c2',
          has_more: true,
        },
      },
      {
        body: {
          object: 'list',
          results: [{ object: 'database', id: 'd1' }],
          next_cursor: null,
          has_more: false,
        },
      },
    ])

    const results = await search(client(f), {
      query: 'roadmap',
      filter: { value: 'page', property: 'object' },
    })

    expect(results.map((r) => r.id)).toEqual(['p1', 'd1'])
    expect(f.requestAt(0).url).toBe('https://api.notion.com/v1/search')
    const body = f.bodyAt(0)
    expect(body.query).toBe('roadmap')
    expect(body.filter).toEqual({ value: 'page', property: 'object' })
    expect(f.bodyAt(1).start_cursor).toBe('c2')
  })

  it('accepts no arguments and sends an empty body', async () => {
    const f = fakeFetch([
      { body: { object: 'list', results: [], next_cursor: null, has_more: false } },
    ])
    await search(client(f))
    expect(f.bodyAt(0)).toEqual({})
  })
})
