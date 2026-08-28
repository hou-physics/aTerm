import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionBlock } from '../components/SessionBlock'
import { threadStatusKey, useStatusStore } from '../store/status'

// SessionBlock 内部会调 useThreadStatus，其所在模块 store/status.ts 在 import 时就会
// 触发一次真实的模块级注册（listen('session-status', ...) + getSessionStatuses()，见
// 该文件底部 statusEventsReady 的 IIFE 注释）。测试环境没有真实的 Tauri IPC 桥
// （window.__TAURI_INTERNALS__ 不存在），必须换成不触碰真实桥的空实现——与
// status.test.ts / statusUI.test.tsx 同一套 mock 边界，只是这批用例不需要控制 handler
// （只测「直接 setState 之后 DOM 是否跟着变」，不测事件到达）。
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../ipc', () => ({ getSessionStatuses: vi.fn(async () => []) }))

const thread = {
  rootKey: 'r1', resumeSessionId: 's1', title: '重构解析器', cwd: '/tmp/demo',
  lastActivityMs: Date.now() - 5 * 60_000, fileCount: 1,
  model: 'claude-opus-5', contextTokens: 106_797, preview: '正在核查解析器字段',
  effort: 'xhigh', permissionMode: 'acceptEdits',
}

beforeEach(() => {
  useStatusStore.setState({ statuses: new Map() })
})

describe('SessionBlock（spec §5.3）', () => {
  it('渲染标题、预览行与三枚常驻徽章', () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    expect(screen.getByText('重构解析器')).toBeTruthy()
    expect(screen.getByText('正在核查解析器字段')).toBeTruthy()
    expect(screen.getByText('Opus 5')).toBeTruthy()
    expect(screen.getByText('5 分钟前')).toBeTruthy()
    expect(screen.getByText('上下文 107k')).toBeTruthy()
  })

  it('sub-agent 数为 0 时不显示 ⑂ 徽章（spec：有才显示）', () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    expect(screen.queryByText(/⑂/)).toBeNull()
  })

  it('sub-agent 数大于 0 时显示 ⑂n', () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={86} onOpen={() => {}} />)
    expect(screen.getByText('⑂ 86')).toBeTruthy()
  })

  it('缺失的字段不渲染空徽章', () => {
    const bare = { ...thread, model: null, contextTokens: null, preview: null }
    render(<SessionBlock thread={bare} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    expect(screen.queryByText(/上下文/)).toBeNull()
  })

  it('整块带上状态类名，供 CSS 着色（spec §5.3：底色与边框随状态）', () => {
    // 状态由组件自己经 useThreadStatus 求得，不作为 prop 传入：SessionBlock 本身
    // 就是「每项一个组件」，正是 Sidebar.tsx:246 那条 Rules of Hooks 注释的解法。
    useStatusStore.setState({
      statuses: new Map([[threadStatusKey('proj', 'r1'), {
        dirName: 'proj', rootKey: 'r1', sessionId: 's1', status: 'running',
        lastActivityMs: Date.now(), updatedAtMs: Date.now(),
      }]]),
    })
    const { container } = render(
      <SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />
    )
    expect(container.querySelector('.session-block')?.classList.contains('session-block-running')).toBe(true)
  })
})

// 双击的分工：Task 9 会让双击*标题*进入改名模式，因此本任务必须先把这两者分开——
// 双击方块空白区域触发 onOpen；双击标题绝不能触发 onOpen（否则 Task 9 落地时会跟这里
// 打架）。标题元素已经单独接了一个 onDoubleClick（目前只 stopPropagation），Task 9
// 只需替换这个 handler 的函数体，不需要改动本组件的布局或事件结构。
describe('SessionBlock —— 双击分工（标题 vs 空白区，为 Task 9 的改名让路）', () => {
  it('双击方块空白区域触发 onOpen', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={onOpen} />
    )
    fireEvent.doubleClick(container.querySelector('.session-block')!)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('双击标题不触发 onOpen（留给 Task 9 的改名交互接管）', () => {
    const onOpen = vi.fn()
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={onOpen} />)
    fireEvent.doubleClick(screen.getByText('重构解析器'))
    expect(onOpen).not.toHaveBeenCalled()
  })
})
