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
    const got = resolvePaneIdentity(projects, 's-old', {})
    expect(got?.rootKey).toBe('u-root')
    expect(got?.dirName).toBe('-tmp-a')
    expect(got?.threadKey).toBe('-tmp-a:u-root')
    expect(got?.title).toBe('修登录')

    // 用例名宣称"命中链上任意一个文件的 session id"，但上面只查了 sessionIds 数组的
    // 首元素——如果实现退化成 `sessionIds[0] === sessionId`（而不是
    // `sessionIds.includes(sessionId)`），上面几条断言依然全绿，宣称的性质根本没被
    // 锁住。这里额外用数组第二个元素去查，断言解析到同一条链的同一个 rootKey。
    const gotByLaterId = resolvePaneIdentity(projects, 's-new', {})
    expect(gotByLaterId?.rootKey).toBe('u-root')
    expect(gotByLaterId?.dirName).toBe('-tmp-a')
    expect(gotByLaterId?.threadKey).toBe('-tmp-a:u-root')
    expect(gotByLaterId?.title).toBe('修登录')
  })

  // 原用例名"titled 为 false 时不给 title"已不成立——resolvePaneIdentity 现在通过
  // displayTitle（见 sessionList.ts）恒给出一个有意义的字符串（别名 > 真实标题 >
  // 「新对话」），title 字段从可缺省变成恒有值。titled 为 false 且没有别名时给的是
  // 「新对话」，不再是 undefined；采纳 session_id 前 8 位回退值这件事仍然不该发生，
  // 这里改成断言这一点没有变。
  it('titled 为 false 且无别名时给「新对话」，不是 session_id 前 8 位的回退值', () => {
    const projects = [project('-tmp-a', [
      makeThread({ rootKey: 's-fresh', sessionIds: ['s-fresh'], titled: false, title: 's-fresh'.slice(0, 8) }),
    ])]
    const got = resolvePaneIdentity(projects, 's-fresh', {})
    expect(got).not.toBeNull()
    expect(got!.rootKey).toBe('s-fresh')
    expect(got!.title).toBe('新对话')
  })

  it('转录尚未落盘时返回 null，调用方据此保留窗格原样', () => {
    const projects = [project('-tmp-a', [makeThread({ sessionIds: ['s-other'] })])]
    expect(resolvePaneIdentity(projects, 's-mine', {})).toBeNull()
  })

  it('跨项目出现相同 rootKey 时不误配——threadKey 必须带项目前缀', () => {
    const projects = [
      project('-tmp-a', [makeThread({ rootKey: 'same', sessionIds: ['s-a'], titled: true, title: 'A' })]),
      project('-tmp-b', [makeThread({ rootKey: 'same', sessionIds: ['s-b'], titled: true, title: 'B' })]),
    ]
    expect(resolvePaneIdentity(projects, 's-b', {})!.threadKey).toBe('-tmp-b:same')
    expect(resolvePaneIdentity(projects, 's-a', {})!.threadKey).toBe('-tmp-a:same')
  })

  it('projects 为空时返回 null，不抛异常', () => {
    expect(resolvePaneIdentity([], 's-mine', {})).toBeNull()
  })

  // 本次要修的 bug 本身：标签标题此前完全没接别名这条线（见 paneReconcile.ts 顶部
  // 注释）。用户报告的现象是"侧栏/主页改了名字，标签标题不跟着变"——这里锁住
  // resolvePaneIdentity 现在与 displayTitle 同一优先级：别名 > 真实标题 > 「新对话」。
  describe('别名（本次新增：接入 displayTitle）', () => {
    it('给了别名就返回别名，即使真实标题也存在', () => {
      const projects = [project('-tmp-a', [
        makeThread({ rootKey: 'u-root', sessionIds: ['s-mine'], titled: true, title: '真实标题' }),
      ])]
      const got = resolvePaneIdentity(projects, 's-mine', { '-tmp-a::u-root': '我的别名' })
      expect(got?.title).toBe('我的别名')
    })

    it('没给别名时按 titled 走真实标题', () => {
      const projects = [project('-tmp-a', [
        makeThread({ rootKey: 'u-root', sessionIds: ['s-mine'], titled: true, title: '真实标题' }),
      ])]
      const got = resolvePaneIdentity(projects, 's-mine', {})
      expect(got?.title).toBe('真实标题')
    })

    it('没给别名且 titled 为 false 时按 titled 走「新对话」', () => {
      const projects = [project('-tmp-a', [
        makeThread({ rootKey: 'u-root', sessionIds: ['s-mine'], titled: false, title: 'u-root12' }),
      ])]
      const got = resolvePaneIdentity(projects, 's-mine', {})
      expect(got?.title).toBe('新对话')
    })

    it('别名键必须精确匹配 dirName::rootKey——别的项目/别的会话的别名不会串号', () => {
      const projects = [project('-tmp-a', [
        makeThread({ rootKey: 'u-root', sessionIds: ['s-mine'], titled: true, title: '真实标题' }),
      ])]
      const got = resolvePaneIdentity(projects, 's-mine', {
        '-tmp-b::u-root': '别的项目的别名',
        '-tmp-a::other-root': '别的会话的别名',
      })
      expect(got?.title).toBe('真实标题')
    })
  })
})
