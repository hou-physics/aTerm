import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, SessionStatusPayload, ThreadInfo } from '../ipc'

// StatusBar 走真实的 useTabs/useSessions/useStatusStore（不 mock store 本身），只 mock
// Tauri 事件桥与 ipc 边界——与 SessionBlock.test.tsx / OverviewPage.test.tsx 同一套
// mock 边界：store/status.ts 在 import 时就会触发模块级 listen('session-status', ...)
// + getSessionStatuses()，store/tabs.ts 顶层则解构了 ptySpawn/ptyIsAlive/ptyKill——
// 测试环境没有真实的 Tauri IPC 桥，必须换成不触碰它的空实现。
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../ipc', () => ({
  getSessionStatuses: vi.fn(async () => []),
  ptySpawn: vi.fn(async () => 'pty-x'),
  ptyIsAlive: vi.fn(async () => true),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
}))

import { buildOverviewStatusText, buildSessionStatusText, StatusBar } from '../components/StatusBar'
import { threadStatusKey, useStatusStore } from '../store/status'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { HOME_TAB, makePane, makeTermTab } from './factories'

describe('buildSessionStatusText（spec §5.2：会话标签显示模型 · effort · 权限模式）', () => {
  it('三项齐全时以 · 连接', () => {
    expect(buildSessionStatusText({ model: 'claude-opus-5', effort: 'xhigh', permissionMode: 'acceptEdits' }))
      .toBe('Opus 5 · xhigh · acceptEdits')
  })

  it('缺失的段直接略去，不留下「· ·」这样的空段', () => {
    expect(buildSessionStatusText({ model: 'claude-opus-5', effort: null, permissionMode: 'plan' }))
      .toBe('Opus 5 · plan')
  })

  it('三项全缺时返回空串，由调用方决定不渲染', () => {
    expect(buildSessionStatusText({})).toBe('')
  })
})

describe('buildOverviewStatusText（总览/主页显示会话统计）', () => {
  it('统计三个数字', () => {
    expect(buildOverviewStatusText({ total: 12, running: 2, awaiting: 1 }))
      .toBe('12 个会话 · 2 运行中 · 1 等待回答')
  })

  it('运行中与等待均为 0 时只显示总数，不堆砌 0', () => {
    expect(buildOverviewStatusText({ total: 5, running: 0, awaiting: 0 })).toBe('5 个会话')
  })
})

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return { rootKey: 'r1', resumeSessionId: 's1', title: 'T', cwd: '/tmp/p', lastActivityMs: 1, fileCount: 1, ...over }
}

function setProjects(projects: ProjectInfo[]) {
  useSessions.setState({ projects, loading: false })
}

beforeEach(() => {
  useTabs.setState({ tabs: [HOME_TAB], activeId: 'home' })
  useSessions.setState({ projects: [], loading: false })
  useStatusStore.setState({ statuses: new Map() })
})

describe('StatusBar 随标签切换而变化', () => {
  it('活动标签是会话时显示该会话的模型与 effort', () => {
    const pane = makePane({ dirName: 'proj', rootKey: 'r1' })
    const tab = makeTermTab({ panes: [pane], activePaneId: pane.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })
    setProjects([
      {
        dirName: 'proj',
        cwd: '/tmp/p',
        lastActivityMs: 1,
        threads: [thread({ rootKey: 'r1', model: 'claude-sonnet-4-5', effort: 'high', permissionMode: 'default' })],
      },
    ])

    render(<StatusBar />)
    expect(screen.getByText('Sonnet 4.5 · high · default')).toBeTruthy()
  })

  it('term 标签的窗格缺 dirName/rootKey（例如 PanePicker 还没选定会话）时不渲染任何文字，只留固定高度容器', () => {
    const pane = makePane({ dirName: undefined, rootKey: undefined })
    const tab = makeTermTab({ panes: [pane], activePaneId: pane.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    const { container } = render(<StatusBar />)
    expect(container.querySelector('.status-bar')).toBeTruthy()
    expect(container.querySelector('.status-bar-text')).toBeNull()
  })

  it('活动标签是总览页时显示会话统计', () => {
    setProjects([
      {
        dirName: 'proj',
        cwd: '/tmp/p',
        lastActivityMs: 1,
        threads: [thread({ rootKey: 'a' }), thread({ rootKey: 'b' }), thread({ rootKey: 'c' })],
      },
    ])
    useStatusStore.setState({
      statuses: new Map<string, SessionStatusPayload>([
        [threadStatusKey('proj', 'a'), { dirName: 'proj', rootKey: 'a', sessionId: 's', status: 'running', lastActivityMs: 1, updatedAtMs: 1 }],
        [threadStatusKey('proj', 'b'), { dirName: 'proj', rootKey: 'b', sessionId: 's', status: 'awaitingInput', lastActivityMs: 1, updatedAtMs: 1 }],
      ]),
    })
    useTabs.setState({
      tabs: [HOME_TAB, { id: 'ov-1', kind: 'overview', title: '▦ demo', panes: [], dirName: 'proj' }],
      activeId: 'ov-1',
    })

    render(<StatusBar />)
    expect(screen.getByText('3 个会话 · 1 运行中 · 1 等待回答')).toBeTruthy()
  })

  it('总览页的统计只算该标签自己 dirName 对应的项目，不混入其它项目（controller ruling：总览渲染的是单个项目的方块，混入别的项目会让数字与屏幕上的方块对不上）', () => {
    setProjects([
      {
        dirName: 'proj-a',
        cwd: '/tmp/a',
        lastActivityMs: 1,
        threads: [thread({ rootKey: 'a1' }), thread({ rootKey: 'a2' }), thread({ rootKey: 'a3' })],
      },
      {
        // proj-b 会话数、运行中数都比 proj-a 多，若统计口径误取全局，两个数字会
        // 明显偏大——用这个差异让测试在"改回全局统计"时必然失败，而不是巧合地
        // 凑巧数值相同。
        dirName: 'proj-b',
        cwd: '/tmp/b',
        lastActivityMs: 1,
        threads: [
          thread({ rootKey: 'b1' }),
          thread({ rootKey: 'b2' }),
          thread({ rootKey: 'b3' }),
          thread({ rootKey: 'b4' }),
          thread({ rootKey: 'b5' }),
        ],
      },
    ])
    useStatusStore.setState({
      statuses: new Map<string, SessionStatusPayload>([
        [threadStatusKey('proj-a', 'a1'), { dirName: 'proj-a', rootKey: 'a1', sessionId: 's', status: 'running', lastActivityMs: 1, updatedAtMs: 1 }],
        [threadStatusKey('proj-b', 'b1'), { dirName: 'proj-b', rootKey: 'b1', sessionId: 's', status: 'running', lastActivityMs: 1, updatedAtMs: 1 }],
        [threadStatusKey('proj-b', 'b2'), { dirName: 'proj-b', rootKey: 'b2', sessionId: 's', status: 'running', lastActivityMs: 1, updatedAtMs: 1 }],
        [threadStatusKey('proj-b', 'b3'), { dirName: 'proj-b', rootKey: 'b3', sessionId: 's', status: 'awaitingInput', lastActivityMs: 1, updatedAtMs: 1 }],
      ]),
    })
    // 激活标签是 proj-a 的总览页；proj-a 只有 3 个会话、1 个运行中，全局（含 proj-b）
    // 则是 8 个会话、3 个运行中、1 个等待回答——两组数字互不相同，断言必须精确匹配
    // "只属于 proj-a" 那一组，才能确认没有意外读到全局口径。
    useTabs.setState({
      tabs: [HOME_TAB, { id: 'ov-a', kind: 'overview', title: '▦ proj-a', panes: [], dirName: 'proj-a' }],
      activeId: 'ov-a',
    })

    render(<StatusBar />)
    expect(screen.getByText('3 个会话 · 1 运行中')).toBeTruthy()
    expect(screen.queryByText(/8 个会话/)).toBeNull()
  })

  it('活动标签是主页时同样显示会话统计', () => {
    setProjects([
      { dirName: 'proj', cwd: '/tmp/p', lastActivityMs: 1, threads: [thread({ rootKey: 'a' }), thread({ rootKey: 'b' })] },
    ])
    useTabs.setState({ tabs: [HOME_TAB], activeId: 'home' })

    render(<StatusBar />)
    expect(screen.getByText('2 个会话')).toBeTruthy()
  })
})
