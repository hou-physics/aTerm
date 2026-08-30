import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  revealInFinder: vi.fn(async () => {}),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
vi.mock('../store/status', () => ({
  statusEventsReady: Promise.resolve(),
  useThreadStatus: () => undefined,
  useProjectStatus: () => 'unknown' as const,
  useStatusStore: (selector: (s: { statuses: Map<string, unknown> }) => unknown) => selector({ statuses: new Map() }),
  threadStatusKey: (dirName: string, rootKey: string) => `${dirName}::${rootKey}`,
}))
// 这个 mock 的形状必须与 App.test.tsx 里那份逐字一致——Sidebar 会渲染 <HooksControl/>，
// 它同时 import 了 hooksPhase 与 useHooksInstall，而 store 模块在加载时还会发起一次
// hooksStatus() 的 IPC（`hooksInstallReady`）。三个导出缺任何一个都会在 import 期就抛错，
// 表现为"整个测试文件跑不起来"，而不是某条断言失败。
vi.mock('../store/hooksInstall', () => ({
  hooksInstallReady: Promise.resolve(),
  hooksPhase: () => null,
  useHooksInstall: Object.assign(() => null, {
    getState: () => ({ dismiss: () => {}, install: async () => {}, uninstall: async () => {} }),
  }),
}))

import * as ipc from '../ipc'
import { Sidebar } from '../components/Sidebar'
import { useLibrary } from '../store/library'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { makeThread } from './factories'

function seed(n: number) {
  useSessions.setState({
    projects: [{
      dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: Date.now(),
      threads: Array.from({ length: n }, (_, i) =>
        makeThread({ rootKey: `r${i}`, title: `会话${i}`, lastActivityMs: Date.now() - i * 1000 })),
    }],
    loading: false,
  })
}

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  useLibrary.setState({ aliases: {}, hiddenProjects: {}, removedSessions: {} })
  vi.clearAllMocks()
})

describe('侧栏右键菜单', () => {
  it('右键弹出三项', () => {
    seed(2)
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByText('会话0'))
    expect(screen.queryByText('重命名')).toBeTruthy()
    expect(screen.queryByText('在访达中显示')).toBeTruthy()
    expect(screen.queryByText('从列表移除')).toBeTruthy()
  })

  it('「在访达中显示」用项目 cwd 调后端', () => {
    seed(2)
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByText('会话0'))
    fireEvent.click(screen.getByText('在访达中显示'))
    expect(ipc.revealInFinder).toHaveBeenCalledWith('/tmp/a')
  })

  it('「从列表移除」后该条从列表消失', async () => {
    seed(2)
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByText('会话0'))
    fireEvent.click(screen.getByText('从列表移除'))
    await waitFor(() => expect(screen.queryByText('会话0')).toBeNull())
    expect(screen.queryByText('会话1')).toBeTruthy()   // 只移除被点的那一条
  })

  it('重命名：回车提交后显示新名字', async () => {
    seed(2)
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByText('会话0'))
    fireEvent.click(screen.getByText('重命名'))
    const input = screen.getByDisplayValue('会话0') as HTMLInputElement
    fireEvent.change(input, { target: { value: '我的任务' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByText('我的任务')).toBeTruthy())
  })

  it('重命名：Esc 取消，名字不变', async () => {
    seed(2)
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByText('会话0'))
    fireEvent.click(screen.getByText('重命名'))
    const input = screen.getByDisplayValue('会话0') as HTMLInputElement
    fireEvent.change(input, { target: { value: '不该生效' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('会话0')).toBeTruthy())
    expect(screen.queryByText('不该生效')).toBeNull()
  })
})
