import { describe, expect, it } from 'vitest'
import type { ProjectInfo } from '../ipc'
import { resolvePaneIdentity } from '../paneReconcile'
import { makeThread } from './factories'

const project = (dirName: string, threads: ProjectInfo['threads']): ProjectInfo =>
  ({ dirName, cwd: `/tmp/${dirName}`, lastActivityMs: 1, threads })

describe('resolvePaneIdentity', () => {
  it('命中链上任意一个文件的 session id，都解析到该链当前的 rootKey', () => {
    const projects = [project('-tmp-a', [
      makeThread({ rootKey: 'u-root', sessionIds: ['s-old', 's-new'], titled: true, title: '修登录' }),
    ])]
    // 用链上较早的那个 id 去查——这正是新对话的真实处境：我们指定的 id 是链的起点，
    // 而 rootKey 在用户发出第一句话后已经翻成了那条消息的 uuid。
    const got = resolvePaneIdentity(projects, 's-old')
    expect(got?.rootKey).toBe('u-root')
    expect(got?.dirName).toBe('-tmp-a')
    expect(got?.threadKey).toBe('-tmp-a:u-root')
    expect(got?.title).toBe('修登录')

    // 用例名宣称"命中链上任意一个文件的 session id"，但上面只查了 sessionIds 数组的
    // 首元素——如果实现退化成 `sessionIds[0] === sessionId`（而不是
    // `sessionIds.includes(sessionId)`），上面几条断言依然全绿，宣称的性质根本没被
    // 锁住。这里额外用数组第二个元素去查，断言解析到同一条链的同一个 rootKey。
    const gotByLaterId = resolvePaneIdentity(projects, 's-new')
    expect(gotByLaterId?.rootKey).toBe('u-root')
    expect(gotByLaterId?.dirName).toBe('-tmp-a')
    expect(gotByLaterId?.threadKey).toBe('-tmp-a:u-root')
    expect(gotByLaterId?.title).toBe('修登录')
  })

  it('titled 为 false 时不给 title——采纳回退值会把标签标题变成一串 uuid', () => {
    const projects = [project('-tmp-a', [
      makeThread({ rootKey: 's-fresh', sessionIds: ['s-fresh'], titled: false, title: 's-fresh'.slice(0, 8) }),
    ])]
    const got = resolvePaneIdentity(projects, 's-fresh')
    expect(got).not.toBeNull()
    expect(got!.rootKey).toBe('s-fresh')
    expect(got!.title).toBe(undefined)
  })

  it('转录尚未落盘时返回 null，调用方据此保留窗格原样', () => {
    const projects = [project('-tmp-a', [makeThread({ sessionIds: ['s-other'] })])]
    expect(resolvePaneIdentity(projects, 's-mine')).toBeNull()
  })

  it('跨项目出现相同 rootKey 时不误配——threadKey 必须带项目前缀', () => {
    const projects = [
      project('-tmp-a', [makeThread({ rootKey: 'same', sessionIds: ['s-a'], titled: true, title: 'A' })]),
      project('-tmp-b', [makeThread({ rootKey: 'same', sessionIds: ['s-b'], titled: true, title: 'B' })]),
    ]
    expect(resolvePaneIdentity(projects, 's-b')!.threadKey).toBe('-tmp-b:same')
    expect(resolvePaneIdentity(projects, 's-a')!.threadKey).toBe('-tmp-a:same')
  })

  it('projects 为空时返回 null，不抛异常', () => {
    expect(resolvePaneIdentity([], 's-mine')).toBeNull()
  })
})
