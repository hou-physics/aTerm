import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import type { SessionStatusPayload } from '../ipc'

// 集成测试：HomePage/Sidebar 真正接到 store/status 上（不 mock store/status 本身），
// 只 mock Tauri 事件桥（listen）与 ipc 的 invoke 调用边界——与 status.test.ts 同一套
// hoisted handler 手法，验证的是"事件真的到达后，真实渲染出的 DOM 会变"，不是"某个
// 函数被调用过"。
const { handlers, listenMock, getSessionStatusesMock } = vi.hoisted(() => {
  const handlers: Record<string, (e: { payload: SessionStatusPayload[] }) => void> = {}
  const listenMock = vi.fn(async (event: string, handler: (e: { payload: SessionStatusPayload[] }) => void) => {
    handlers[event] = handler
    return () => {}
  })
  const getSessionStatusesMock = vi.fn(async (): Promise<SessionStatusPayload[]> => [])
  return { handlers, listenMock, getSessionStatusesMock }
})

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('../ipc', () => ({
  listProjects: vi.fn(async () => []),
  ptySpawn: vi.fn(async () => 'pty-x'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  getSessionStatuses: getSessionStatusesMock,
}))
// 与其它组件测试同一理由：这个文件不测终端/PTY 生命周期，换成不触碰真实 Tauri 事件桥
// 的空实现（真实的 session-status 合并行为由上面的 listenMock/getSessionStatusesMock
// 覆盖，二者是两条独立的事件流）。
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))

function entry(over: Partial<SessionStatusPayload> = {}): SessionStatusPayload {
  return {
    dirName: 'proj-a', rootKey: 'root-1', sessionId: 'sess-1',
    status: 'running', lastActivityMs: 1, updatedAtMs: 10,
    ...over,
  }
}

const PROJECTS = [{
  dirName: 'proj-a', cwd: '/home/proj-a', lastActivityMs: 100,
  threads: [
    { rootKey: 'root-1', resumeSessionId: 'sid-1', title: '修复登录', cwd: '/home/proj-a', lastActivityMs: 100, fileCount: 1 },
    { rootKey: 'root-2', resumeSessionId: 'sid-2', title: '写测试', cwd: '/home/proj-a', lastActivityMs: 90, fileCount: 1 },
  ],
}]

async function freshModules() {
  vi.resetModules()
  getSessionStatusesMock.mockClear()
  Object.keys(handlers).forEach((k) => delete handlers[k])
  const statusMod = await import('../store/status')
  await statusMod.statusEventsReady
  const sessionsMod = await import('../store/sessions')
  const tabsMod = await import('../store/tabs')
  sessionsMod.useSessions.setState({ projects: PROJECTS as never, loading: false })
  tabsMod.useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  return statusMod
}

describe('HomePage — 项目卡片聚合点 + 展开会话行各自的点（真实 store，不 mock 合并逻辑）', () => {
  it('root-1 running：卡片聚合点显示 running，展开后 root-1 行显示 running、root-2 行不显示（尚无数据）', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([entry({ status: 'running' })])
    await freshModules()
    const { HomePage } = await import('../components/HomePage')
    render(<HomePage />)

    const card = screen.getByText(/proj-a/)
    const cardDot = card.closest('.card')!.querySelector('.status-dot')
    expect(cardDot?.classList.contains('status-dot-running')).toBe(true)

    fireEvent.click(card)
    const row1 = (await screen.findByText('修复登录')).closest('.thread-row')!
    const row2 = screen.getByText('写测试').closest('.thread-row')!
    expect(row1.querySelector('.status-dot')?.classList.contains('status-dot-running')).toBe(true)
    expect(row2.querySelector('.status-dot')).toBeNull() // root-2 没有已知状态：不画点
  })

  it('两条会话都 done：卡片聚合点显示 done（全部已知且都是 done）', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([
      entry({ rootKey: 'root-1', status: 'done' }),
      entry({ rootKey: 'root-2', status: 'done' }),
    ])
    await freshModules()
    const { HomePage } = await import('../components/HomePage')
    render(<HomePage />)

    const card = screen.getByText(/proj-a/).closest('.card')!
    expect(card.querySelector('.status-dot')?.classList.contains('status-dot-done')).toBe(true)
  })

  it('真实 session-status 事件到达后，卡片聚合点跟着变化（running → awaitingInput）', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([entry({ status: 'running', updatedAtMs: 10 })])
    await freshModules()
    const { HomePage } = await import('../components/HomePage')
    render(<HomePage />)

    const card = screen.getByText(/proj-a/).closest('.card')!
    expect(card.querySelector('.status-dot')?.classList.contains('status-dot-running')).toBe(true)

    act(() => {
      handlers['session-status']({ payload: [entry({ status: 'awaitingInput', updatedAtMs: 20 })] })
    })

    expect(card.querySelector('.status-dot')?.classList.contains('status-dot-awaitingInput')).toBe(true)
  })
})

describe('Sidebar — 每条「最近会话」前的状态点（真实 store）', () => {
  it('对应会话 awaitingInput：侧边栏该行显示橙色状态点，title 为中文「等你回答」', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([entry({ rootKey: 'root-1', status: 'awaitingInput' })])
    await freshModules()
    const { Sidebar } = await import('../components/Sidebar')
    render(<Sidebar />)

    const item = screen.getByText('修复登录').closest('.side-item')!
    const dot = item.querySelector('.status-dot')!
    expect(dot.classList.contains('status-dot-awaitingInput')).toBe(true)
    expect(dot.getAttribute('title')).toBe('等你回答')
  })
})

describe('HomePage — 尚无任何状态数据时（后端初始扫描是异步的，见 rust 报告）：不渲染任何颜色', () => {
  beforeEach(() => {
    getSessionStatusesMock.mockResolvedValueOnce([])
  })

  it('聊天点位置仍占位，但没有圆点', async () => {
    await freshModules()
    const { HomePage } = await import('../components/HomePage')
    render(<HomePage />)

    const card = screen.getByText(/proj-a/).closest('.card')!
    expect(card.querySelector('.status-dot-slot')).toBeTruthy()
    expect(card.querySelector('.status-dot')).toBeNull()
  })
})
