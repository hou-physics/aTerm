import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionBlock } from '../components/SessionBlock'
import { blockKey } from '../store/overview'
import { useLibrary } from '../store/library'
import { threadStatusKey, useStatusStore } from '../store/status'
import { makeThread } from './factories'

// SessionBlock 内部会调 useThreadStatus，其所在模块 store/status.ts 在 import 时就会
// 触发一次真实的模块级注册（listen('session-status', ...) + getSessionStatuses()，见
// 该文件底部 statusEventsReady 的 IIFE 注释）。测试环境没有真实的 Tauri IPC 桥
// （window.__TAURI_INTERNALS__ 不存在），必须换成不触碰真实桥的空实现——与
// status.test.ts / statusUI.test.tsx 同一套 mock 边界，只是这批用例不需要控制 handler
// （只测「直接 setState 之后 DOM 是否跟着变」，不测事件到达）。
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../ipc', () => ({ getSessionStatuses: vi.fn(async () => []) }))

const thread = makeThread({
  rootKey: 'r1', title: '重构解析器',
  lastActivityMs: Date.now() - 5 * 60_000,
  model: 'claude-opus-5', contextTokens: 106_797, preview: '正在核查解析器字段',
})

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

describe('方块重命名（spec §5.2 右键菜单的「重命名」，本期以双击标题实现）', () => {
  beforeEach(() => {
    useLibrary.setState({ aliases: {}, hiddenProjects: {}, removedSessions: {} })
  })

  it('双击标题进入编辑态', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('重构解析器')
  })

  it('Enter 提交重命名并持久化', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '我的重构任务{Enter}')
    expect(screen.getByText('我的重构任务')).toBeTruthy()
    expect(useLibrary.getState().aliases[blockKey('proj', 'r1')]).toBe('我的重构任务')
  })

  it('Esc 取消，保留原标题且不写入 store', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    await userEvent.type(screen.getByRole('textbox'), '不该被保存{Escape}')
    expect(screen.getByText('重构解析器')).toBeTruthy()
    expect(useLibrary.getState().aliases[blockKey('proj', 'r1')]).toBeUndefined()
  })

  it('失焦视为提交', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '失焦提交')
    await userEvent.tab()
    expect(useLibrary.getState().aliases[blockKey('proj', 'r1')]).toBe('失焦提交')
  })

  it('输入全空白视为清除自定义名，回退到默认标题', async () => {
    useLibrary.getState().rename(blockKey('proj', 'r1'), '旧名字')
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('旧名字'))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '   {Enter}')
    expect(screen.getByText('重构解析器')).toBeTruthy()
    expect(useLibrary.getState().aliases[blockKey('proj', 'r1')]).toBeUndefined()
  })

  it('重命名后徽章与状态点仍在，不因进出编辑态而丢失', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={3} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    await userEvent.type(screen.getByRole('textbox'), '{Enter}')
    expect(screen.getByText('⑂ 3')).toBeTruthy()
    expect(screen.getByText('Opus 5')).toBeTruthy()
  })
})

// 拖拽手柄风险（本任务说明书专项要求）：OverviewPage.tsx 的 DraggableBlock 把
// SessionBlock 整个包在一个装了 onPointerDown 的 div 里（真实拖拽手柄，见
// OverviewPage.tsx 顶部注释——阈值前不 setPointerCapture，但 pointerdown 本身仍会
// 冒泡到手柄）。这里在测试里搭一个同构的最小包装（外层 div + onPointerDown 探针），
// 模拟 OverviewPage.tsx 的真实结构，而不是直接断言组件内部实现细节。编辑态下在
// input 上点按（放置光标）或拖选文字都会先触发一次 pointerdown——如果这次
// pointerdown 冒泡到外层手柄，手柄会记录起始坐标、后续的 pointermove 一旦超过 4px
// 阈值就会误判成"开始拖拽方块"。断言：input 上的 pointerdown 不应该冒泡到外层手柄。
describe('SessionBlock —— 编辑态下 input 的 pointerdown 不冒泡到拖拽手柄', () => {
  it('点击/拖选 input 内文字不会触发外层拖拽手柄的 pointerdown', async () => {
    const handlePointerDown = vi.fn()
    render(
      <div onPointerDown={handlePointerDown}>
        <SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />
      </div>
    )
    // 进入编辑态本身就要靠双击标题触发（title 视图态仍是拖拽手柄的一部分，双击本身
    // 冒泡到手柄是预期行为，不是本用例要断言的对象），所以先清空这两次调用记录，只
    // 断言"进入编辑态之后、在 input 上按下"这一次不会冒泡。
    await userEvent.dblClick(screen.getByText('重构解析器'))
    handlePointerDown.mockClear()
    const input = screen.getByRole('textbox')
    fireEvent.pointerDown(input)
    expect(handlePointerDown).not.toHaveBeenCalled()
  })
})
