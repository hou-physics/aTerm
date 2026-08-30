import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../ipc'
import { useTabs } from '../store/tabs'
import { makeThread } from './factories'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(), ptyWrite: vi.fn(), ptyResize: vi.fn(),
  ptyKill: vi.fn(), ptyIsAlive: vi.fn().mockResolvedValue(false), listProjects: vi.fn(),
}))

const projects = (threads: ProjectInfo['threads']): ProjectInfo[] =>
  [{ dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: 1, threads }]

beforeEach(() => {
  useTabs.setState({
    tabs: [
      { id: 'home', kind: 'home', title: '主页', panes: [] },
      {
        id: 'tab-1', kind: 'term', title: '新对话', activePaneId: 'pane-1',
        panes: [{ id: 'pane-1', ptyId: 'pty-1', title: '新对话', sessionId: 's-mine' }],
      },
    ],
    activeId: 'tab-1',
  })
})

describe('reconcilePanes', () => {
  it('回填 dirName / rootKey / threadKey，使 focusThread 能命中', () => {
    useTabs.getState().reconcilePanes(projects([
      makeThread({ rootKey: 'u-root', sessionIds: ['s-mine'], titled: true, title: '修登录' }),
    ]))
    const pane = useTabs.getState().tabs[1].panes[0]
    expect(pane.dirName).toBe('-tmp-a')
    expect(pane.rootKey).toBe('u-root')
    expect(pane.threadKey).toBe('-tmp-a:u-root')
    // 这才是用户真正感知到的症状：从侧栏点同一条会话，应聚焦到已有窗格而不是再开一个
    expect(useTabs.getState().focusThread('-tmp-a:u-root')).toBe(true)
  })

  it('有真实标题时同步窗格标题与标签标题', () => {
    useTabs.getState().reconcilePanes(projects([
      makeThread({ rootKey: 'u-root', sessionIds: ['s-mine'], titled: true, title: '修登录' }),
    ]))
    expect(useTabs.getState().tabs[1].panes[0].title).toBe('修登录')
    expect(useTabs.getState().tabs[1].title).toBe('修登录')
  })

  it('titled 为 false 时保留「新对话」，不显示 uuid 前 8 位', () => {
    useTabs.getState().reconcilePanes(projects([
      makeThread({ rootKey: 's-mine', sessionIds: ['s-mine'], titled: false, title: 's-mine12' }),
    ]))
    expect(useTabs.getState().tabs[1].panes[0].title).toBe('新对话')
    expect(useTabs.getState().tabs[1].title).toBe('新对话')
    // 身份仍然要绑上——只是标题不采纳
    expect(useTabs.getState().tabs[1].panes[0].rootKey).toBe('s-mine')
  })

  it('身份未变时返回同一个 tabs 引用，不制造无谓的重渲染', () => {
    const p = projects([makeThread({ rootKey: 'u-root', sessionIds: ['s-mine'], titled: true, title: '修登录' })])
    useTabs.getState().reconcilePanes(p)
    const first = useTabs.getState().tabs
    useTabs.getState().reconcilePanes(p)
    expect(useTabs.getState().tabs).toBe(first)
  })

  it('转录尚未落盘时不动窗格，也不清空已有字段', () => {
    useTabs.getState().reconcilePanes(projects([makeThread({ sessionIds: ['s-other'] })]))
    const pane = useTabs.getState().tabs[1].panes[0]
    expect(pane.rootKey).toBe(undefined)
    expect(pane.title).toBe('新对话')
  })

  it('没有 sessionId 的窗格（--resume 起的）完全不受影响', () => {
    useTabs.setState({
      tabs: [
        { id: 'home', kind: 'home', title: '主页', panes: [] },
        {
          id: 'tab-1', kind: 'term', title: '旧会话', activePaneId: 'pane-1',
          panes: [{ id: 'pane-1', ptyId: 'pty-1', title: '旧会话', dirName: '-tmp-a', rootKey: 'u-old', threadKey: '-tmp-a:u-old' }],
        },
      ],
      activeId: 'tab-1',
    })
    const before = useTabs.getState().tabs
    useTabs.getState().reconcilePanes(projects([makeThread({ rootKey: 'u-root', sessionIds: ['s-mine'] })]))
    expect(useTabs.getState().tabs).toBe(before)
  })
})
