import { describe, expect, it } from 'vitest'
import type { ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'
import { mapHeadResponse } from '../src/github/graphql.js'

const queried: ForgeRepository = { forge: 'github', host: 'github.com', owner: 'zhming0', name: 'dsh-workbench' }

function headBody(nameWithOwner: string) {
  return {
    data: {
      repository: {
        nameWithOwner,
        defaultBranchRef: { name: 'main' },
        pullRequests: { nodes: [
          { number: 185, isCrossRepository: false },
          { number: 186, isCrossRepository: true },
        ] },
      },
    },
  }
}

describe('mapHeadResponse', () => {
  it('uses the canonical repository name, not the queried remote name', () => {
    expect(mapHeadResponse(headBody('renamed-owner/dsh-yawn'), queried, 'refactor/feature-folders')).toEqual([
      { repository: { ...queried, owner: 'renamed-owner', name: 'dsh-yawn' }, number: 185 },
    ])
  })

  it('rejects a repository name that is not owner/name', () => {
    expect(() => mapHeadResponse(headBody('zhming0'), queried, 'refactor/feature-folders'))
      .toThrow('unexpected repository name')
  })
})
