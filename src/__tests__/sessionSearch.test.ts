import { describe, expect, it } from 'vitest'
import { filterProjectsByQuery, matchesQuery } from '../sessionSearch'
import type { ProjectInfo } from '../ipc'

describe('matchesQuery：大小写不敏感子串匹配', () => {
  it('空 query 视为全部匹配', () => {
    expect(matchesQuery('', '任意文本')).toBe(true)
    expect(matchesQuery('')).toBe(true) // 没有候选文本也一样
  })
  it('命中任一候选文本即算匹配（不要求逐个都命中）', () => {
    expect(matchesQuery('login', '修复登录', 'MyLoginFix')).toBe(true)
  })
  // 只对候选文本做 toLowerCase()，query 本身是否已转小写由调用方负责（与既有调用惯例
  // 一致：PanePicker.tsx/filterProjectsByQuery 都在调用前先 `query.toLowerCase()`）——
  // 这里验证的是"候选文本大小写不影响匹配"，不是"query 大小写不影响匹配"。
  it('候选文本的大小写不影响匹配（query 本身按惯例已由调用方转小写）', () => {
    expect(matchesQuery('login', 'LOGIN-FIX')).toBe(true)
    expect(matchesQuery('login', 'My-Login-Fix')).toBe(true)
  })
  it('一个都没命中时返回 false', () => {
    expect(matchesQuery('xyz', 'abc', 'def')).toBe(false)
  })
})

const PROJECTS: ProjectInfo[] = [
  {
    dirName: 'p1', cwd: '/Users/x/phineuro', lastActivityMs: 0,
    threads: [
      { rootKey: 'u1', resumeSessionId: 's1', title: '修复登录流程', cwd: '/Users/x/phineuro', lastActivityMs: 2, fileCount: 1 },
      { rootKey: 'u2', resumeSessionId: 's2', title: '写测试', cwd: '/Users/x/phineuro', lastActivityMs: 1, fileCount: 1 },
    ],
  },
  {
    dirName: 'p2', cwd: '/Users/x/aterm', lastActivityMs: 0,
    threads: [
      { rootKey: 'a1', resumeSessionId: 's3', title: '重构分屏布局', cwd: '/Users/x/aterm', lastActivityMs: 3, fileCount: 1 },
    ],
  },
]

describe('filterProjectsByQuery：按项目分组过滤（PanePicker.tsx 与 HomePage.tsx 共用）', () => {
  it('空 query：原样返回全部项目、全部会话', () => {
    const result = filterProjectsByQuery(PROJECTS, '')
    expect(result.map((p) => p.dirName)).toEqual(['p1', 'p2'])
    expect(result[0].threads).toHaveLength(2)
  })

  it('命中会话标题：只保留该项目下命中的会话，不命中的项目整个隐去', () => {
    const result = filterProjectsByQuery(PROJECTS, '登录')
    expect(result).toHaveLength(1)
    expect(result[0].dirName).toBe('p1')
    expect(result[0].threads.map((t) => t.title)).toEqual(['修复登录流程'])
    expect(result[0].projectMatches).toBe(false)
  })

  it('命中项目名（basename(cwd)）：保留该项目下全部会话，不只是标题命中的那些', () => {
    const result = filterProjectsByQuery(PROJECTS, 'aterm')
    expect(result).toHaveLength(1)
    expect(result[0].dirName).toBe('p2')
    expect(result[0].threads).toHaveLength(1)
    expect(result[0].projectMatches).toBe(true)
  })

  it('大小写不敏感、前后空白被 trim', () => {
    const result = filterProjectsByQuery(PROJECTS, '  ATERM  ')
    expect(result.map((p) => p.dirName)).toEqual(['p2'])
  })

  it('一个都不命中：返回空数组', () => {
    expect(filterProjectsByQuery(PROJECTS, '完全不存在的东西xyz')).toEqual([])
  })
})
