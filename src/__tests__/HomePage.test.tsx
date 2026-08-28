import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
// 与上面 store/status 同一理由：这批测试不关心 hooks 安装状态，整个模块换成不触碰真实
// ipc 调用的空实现（真实行为由 HooksInstall.test.tsx / hooksInstall.test.ts 单独覆盖）。
vi.mock('../store/hooksInstall', () => ({
  hooksInstallReady: Promise.resolve(),
  hooksPhase: () => null,
  useHooksInstall: Object.assign(() => null, { getState: () => ({ dismiss: () => {}, install: async () => {}, uninstall: async () => {} }) }),
}))
import * as ipc from '../ipc'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { HomePage } from '../components/HomePage'

const PROJECTS = [
  {
    dirName: '-Users-x-phineuro', cwd: '/Users/x/phineuro', lastActivityMs: Date.now() - 60_000,
    threads: [
      { rootKey: 'u1', resumeSessionId: 'sid-1', title: '修复登录流程', cwd: '/Users/x/phineuro', lastActivityMs: Date.now() - 60_000, fileCount: 2 },
      { rootKey: 'u2', resumeSessionId: 'sid-2', title: '写测试', cwd: '/Users/x/phineuro', lastActivityMs: Date.now() - 3600_000, fileCount: 1 },
    ],
  },
  {
    dirName: '-Users-x-aterm', cwd: '/Users/x/aterm', lastActivityMs: Date.now() - 120_000,
    threads: [
      { rootKey: 'a1', resumeSessionId: 'sid-a1', title: '重构分屏布局', cwd: '/Users/x/aterm', lastActivityMs: Date.now() - 120_000, fileCount: 3 },
    ],
  },
]

beforeEach(() => {
  useSessions.setState({ projects: PROJECTS as never, loading: false })
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  vi.clearAllMocks()
})

describe('HomePage — 输入框为空时：今天已有的内容不变', () => {
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

  it('展开卡片里的「＋ 新对话」注入 claude', async () => {
    render(<HomePage />)
    fireEvent.click(screen.getByText(/phineuro/))
    fireEvent.click(await screen.findByText('＋ 新对话'))
    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/Users/x/phineuro', inject: 'claude' }))
    })
  })

  it('占位符文案已改为「搜索过往对话」相关文案（不再是旧的"输入命令"）', () => {
    render(<HomePage />)
    expect(screen.getByPlaceholderText(/搜索过往对话/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/输入命令/)).toBeNull()
  })
})

// 本次改动：主页输入框从"命令运行器"改为"过往对话搜索框"——与 PanePicker.tsx 共用
// 同一份匹配规则（../sessionSearch.ts）：大小写不敏感子串，命中会话标题或项目名。
describe('HomePage — 搜索过往对话', () => {
  it('按会话标题过滤：只显示命中的会话，按项目分组，「最近项目」卡片视图被替换掉', () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.change(input, { target: { value: '登录' } })

    expect(screen.getByText('修复登录流程')).toBeTruthy()
    expect(screen.queryByText('写测试')).toBeNull()
    expect(screen.queryByText('重构分屏布局')).toBeNull()
    expect(screen.queryByText('最近项目')).toBeNull() // 默认视图的分组标题不再显示
  })

  it('按项目名过滤：命中项目名时，该项目下全部会话都显示', () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.change(input, { target: { value: 'aterm' } })

    expect(screen.getByText('重构分屏布局')).toBeTruthy()
    expect(screen.queryByText('修复登录流程')).toBeNull()
    expect(screen.queryByText('写测试')).toBeNull()
  })

  it('大小写不敏感：大写输入同样命中小写/混合大小写的候选文本', () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.change(input, { target: { value: 'ATERM' } })

    expect(screen.getByText('重构分屏布局')).toBeTruthy()
  })

  it('搜索结果里每一行都显示所属项目名与相对时间（状态点由 store/status 提供，已在别处单独测试）', () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.change(input, { target: { value: '登录' } })

    const row = screen.getByText('修复登录流程').closest('.thread-row') as HTMLElement
    expect(row.textContent).toContain('phineuro')
  })

  it('无匹配：不显示任何会话，也不显示「运行命令」以外的兜底内容', () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.change(input, { target: { value: '完全不存在的东西xyz' } })

    expect(screen.queryByText('修复登录流程')).toBeNull()
    expect(screen.queryByText('写测试')).toBeNull()
    expect(screen.queryByText('重构分屏布局')).toBeNull()
  })

  it('清空输入框：恢复今天已有的默认内容（「最近项目」卡片视图）', () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.change(input, { target: { value: '登录' } })
    expect(screen.queryByText('最近项目')).toBeNull()

    fireEvent.change(input, { target: { value: '' } })

    expect(screen.getByText('最近项目')).toBeTruthy()
    expect(screen.getByText(/phineuro/)).toBeTruthy()
  })

  it('点击搜索结果里的一行：resume 对应的会话（与默认视图点击 ThreadRow 是同一条路径）', async () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)
    fireEvent.change(input, { target: { value: '登录' } })

    fireEvent.click(screen.getByText('修复登录流程'))

    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/Users/x/phineuro', inject: 'claude --resume sid-1' }),
      )
    })
  })

  it('回车键：有结果时打开第一条结果', async () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)
    fireEvent.change(input, { target: { value: '登录' } })

    fireEvent.keyDown(input, { key: 'Enter' })

    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/Users/x/phineuro', inject: 'claude --resume sid-1' }),
      )
    })
  })
})

// 不能悄悄拿掉"运行命令"这个能力：无匹配时末尾出现一行兜底，点击/回车都能走到与
// 旧版 Enter 键完全相同的 runCommand 路径。
describe('HomePage — 搜索无匹配时的「运行命令」兜底行（不悄悄拿掉旧的命令执行能力）', () => {
  it('有匹配结果时：不显示「运行命令」这一行', () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.change(input, { target: { value: '登录' } })

    expect(screen.queryByText(/在新标签中运行/)).toBeNull()
  })

  it('无匹配时：显示「在新标签中运行 "<输入内容>"」这一行，点击它按旧的 runCommand 行为开新标签', async () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.change(input, { target: { value: 'htop' } })
    const row = document.querySelector('.thread-row.new-conv') as HTMLElement
    expect(row.textContent).toBe('在新标签中运行 “htop”')

    fireEvent.click(row)

    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ inject: 'htop' }))
    })
  })

  it('无匹配时按回车：等同点击兜底行，同样触发 runCommand（旧版 Enter 键行为的延续）', async () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)
    fireEvent.change(input, { target: { value: 'htop' } })

    fireEvent.keyDown(input, { key: 'Enter' })

    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ inject: 'htop' }))
    })
  })

  it('输入框留空按回车：沿用旧行为，开一个空白终端标签', async () => {
    render(<HomePage />)
    const input = screen.getByPlaceholderText(/搜索过往对话/)

    fireEvent.keyDown(input, { key: 'Enter' })

    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ inject: undefined }))
    })
  })
})

// Task 12：总览页在 Task 1–11 里已经建好全部能力，但没有任何一处 UI 调用
// openOverview——功能存在却无法抵达。这里在项目卡片头部补一个「总览」入口。
describe('HomePage — 项目卡片上的「总览」入口（Task 12）', () => {
  it('点击「总览」按钮：打开该项目的总览标签（聚焦/新建，dirName 对应被点的那张卡片）', async () => {
    render(<HomePage />)
    const card = screen.getByText(/phineuro/).closest('.card') as HTMLElement
    const btn = within(card).getByRole('button', { name: /总览/ })

    await userEvent.click(btn)

    const ov = useTabs.getState().tabs.find((t) => t.kind === 'overview')
    expect(ov).toBeTruthy()
    expect(ov?.dirName).toBe('-Users-x-phineuro')
  })

  it('点击「总览」按钮不会同时触发展开卡片（事件不冒泡到卡片头）', async () => {
    render(<HomePage />)
    const card = screen.getByText(/phineuro/).closest('.card') as HTMLElement
    const btn = within(card).getByRole('button', { name: /总览/ })

    await userEvent.click(btn)

    // 卡片仍处于收起状态：其会话列表未出现（若事件冒泡到 .card 的 onToggle，
    // 这张卡片会展开，'修复登录流程' 就会出现）。
    expect(screen.queryByText('修复登录流程')).toBeNull()
  })

  it('两张卡片各自有一个「总览」按钮，且不同卡片点出的 dirName 各不相同', async () => {
    render(<HomePage />)
    const buttons = screen.getAllByRole('button', { name: /总览/ })
    expect(buttons.length).toBe(2)

    await userEvent.click(buttons[1])
    const ov = useTabs.getState().tabs.find((t) => t.kind === 'overview')
    expect(ov?.dirName).toBe('-Users-x-aterm')
  })
})
