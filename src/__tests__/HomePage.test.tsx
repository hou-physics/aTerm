import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
// 与 ptyBuffer 同一理由：这批测试不关心会话状态，整个模块换成不触碰真实 Tauri 事件桥的
// 空实现（真实的合并/聚合行为由 status.test.ts / StatusDot 相关测试单独覆盖）。
vi.mock('../store/status', () => ({ statusEventsReady: Promise.resolve(), useThreadStatus: () => undefined, useProjectStatus: () => 'unknown' as const }))
import * as ipc from '../ipc'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { HomePage } from '../components/HomePage'

const PROJECTS = [{
  dirName: '-Users-x-phineuro', cwd: '/Users/x/phineuro', lastActivityMs: Date.now() - 60_000,
  threads: [
    { rootKey: 'u1', resumeSessionId: 'sid-1', title: '修复登录流程', cwd: '/Users/x/phineuro', lastActivityMs: Date.now() - 60_000, fileCount: 2 },
    { rootKey: 'u2', resumeSessionId: 'sid-2', title: '写测试', cwd: '/Users/x/phineuro', lastActivityMs: Date.now() - 3600_000, fileCount: 1 },
  ],
}]

beforeEach(() => {
  useSessions.setState({ projects: PROJECTS as never, loading: false })
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  vi.clearAllMocks()
})

describe('HomePage', () => {
  it('渲染项目卡片，点击展开会话，点会话触发 resume', async () => {
    render(<HomePage />)
    const card = screen.getByText(/phineuro/)  // 卡片文本为「📁 phineuro」，须用正则部分匹配
    fireEvent.click(card)
    const row = await screen.findByText('修复登录流程')
    fireEvent.click(row)
    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/Users/x/phineuro', inject: 'claude --resume sid-1' }),
      )
    })
  })
  it('命令输入框回车开新标签执行命令', async () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/输入命令/)
    fireEvent.change(input, { target: { value: 'htop' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ inject: 'htop' }))
    })
  })
  it('展开卡片里的「＋ 新对话」注入 claude', async () => {
    render(<HomePage />)
    fireEvent.click(screen.getByText(/phineuro/))
    fireEvent.click(await screen.findByText('＋ 新对话'))
    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/Users/x/phineuro', inject: 'claude' }))
    })
  })
})
