import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listenTargets, listenMock } = vi.hoisted(() => {
  const handlers: Record<string, (e: { payload: unknown }) => void> = {}
  // 每个事件注册时传的 options.target。V3.3 起这不是无关紧要的细节：Rust 侧
  // emit_close_requested 改成了 emit_to("main", …)，而不传 target 的 listen 会落成
  // `{ kind: 'Any' }`、对 emit_to 的 label 过滤无条件命中——少了 target，每个拖出来的
  // term-* 窗口都会各弹一个"确定关闭 aTerm？"。
  const listenTargets: Record<string, unknown> = {}
  const listenMock = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void, options?: unknown) => {
    handlers[event] = handler
    listenTargets[event] = options
    return () => {}
  })
  return { handlers, listenTargets, listenMock }
})

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }))

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: confirmMock }))
vi.mock('../ipc', () => ({
  ptyAliveCount: vi.fn(async () => 0),
  confirmExit: vi.fn(async () => {}),
}))
// 当前窗口 label：closeRequest 只用它决定监听的 target。
//
// **刻意不用 'main'**（R1/I1）。用 'main' 时初始值恰好等于目标值——windowLabel 在 jsdom
// 里的兜底值也是 'main'，而 Rust 侧 emit_to 的目标同样是 "main"——于是"target 取的是本
// 窗口 label"这条断言变成恒真：把实现改成写死 `{ target: 'main' }`，976 条测试照样全绿，
// 而那正是"多窗口下每个拖出窗口各弹一个退出确认框"这个已修缺陷的原样回归。换成一个
// 拖出来的窗口 label，这条断言才真的在问"你是不是读了本窗口的 label"。
const TEST_WINDOW_LABEL = 'term-9'
vi.mock('../windowLabel', () => ({ currentWindowLabel: vi.fn(async () => 'term-9') }))

import * as ipc from '../ipc'
import { buildExitConfirmMessage, closeRequestReady, handleCloseRequested } from '../closeRequest'
import { useTabs } from '../store/tabs'

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  vi.clearAllMocks()
})

describe('buildExitConfirmMessage（纯函数，不依赖 Tauri）', () => {
  it('没有存活会话时给出简单文案', () => {
    expect(buildExitConfirmMessage(0)).toBe('确定关闭 aTerm？')
  })

  it('有存活会话时文案里报出具体数量', () => {
    expect(buildExitConfirmMessage(3)).toBe('还有 3 个会话在运行，关闭 aTerm 会终止它们。确定关闭？')
  })

  // R1/M5：只剩一个会话时"会终止它们"是病句，与 store/tabs.ts 的
  // buildTabCloseConfirmMessage 一样按数量分档。
  it('只剩一个会话时用单数措辞', () => {
    expect(buildExitConfirmMessage(1)).toBe('还有 1 个会话在运行，关闭 aTerm 会终止它。确定关闭？')
  })
})

describe('closeRequest：收到 app-close-requested 后统计存活会话并弹确认', () => {
  it('模块加载时已向 app-close-requested 注册监听（在任何用户交互之前）', async () => {
    // listenMock 的调用记录会被上面 beforeEach 里的 vi.clearAllMocks() 清空，但注册这件事
    // 本身发生在模块顶层导入时（早于任何一个 beforeEach）——所以这里看的是 handlers 里
    // 挂没挂上东西，而不是 listenMock 的调用历史（后者在模块只导入一次、多个用例共享同
    // 一次注册的前提下并不可靠）。回调此后是一层包装闭包（要把载荷传给
    // handleCloseRequested），不能再断言引用相等；"包装闭包确实把载荷透传了"由下面两条
    // 用例正反各验一次。
    await closeRequestReady
    expect(typeof handlers['app-close-requested']).toBe('function')
  })

  // 终审 I3 的第一半：注册的那个包装闭包必须把**事件载荷**交给 handleCloseRequested，
  // 而不是自己编一个（例如直接 currentWindowLabel()——那样比对恒真，整条校验白做）。
  // 正反两条一起才有区分力：只有正向那条时，一个"什么都不做"的回调也能让反向那条绿。
  it('注册的回调把载荷透传下去：载荷是本窗口 label 时走完整流程', async () => {
    await closeRequestReady
    vi.mocked(ipc.ptyAliveCount).mockResolvedValue(0)
    confirmMock.mockResolvedValue(true)

    handlers['app-close-requested']({ payload: TEST_WINDOW_LABEL })
    await vi.waitFor(() => expect(ipc.confirmExit).toHaveBeenCalled())
  })

  it('注册的回调把载荷透传下去：载荷是别的窗口 label 时连统计都不做', async () => {
    await closeRequestReady
    vi.mocked(ipc.ptyAliveCount).mockResolvedValue(0)
    confirmMock.mockResolvedValue(true)

    handlers['app-close-requested']({ payload: 'main' }) // 本窗口是 term-9
    // 一个宏任务边界足以冲干净这条 async 链上的全部微任务（currentWindowLabel 的替身
    // 是立即 resolve 的），此后仍然没有统计发生才说明它真的早退了。
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ipc.ptyAliveCount).not.toHaveBeenCalled()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(ipc.confirmExit).not.toHaveBeenCalled()
  })

  // 终审 I3 的第二半：handler 自己的载荷校验。注册侧的 target option 是第一层防线，但
  // 在此之前它是**唯一**一层——emit_to 不是私有信道（Ruling 8），Any 监听对 emit_to 的
  // label 过滤无条件命中。少了这一层，一旦那个 option 掉了，每个 term-* 窗口都会各弹一
  // 个"确定关闭 aTerm？"，随便点哪个都退出整个应用、杀光所有窗口的会话。
  //
  // 替身的窗口 label 刻意不是 'main'（见文件上方 TEST_WINDOW_LABEL 处的说明）：否则
  // 载荷 'main' 与本窗口 label 恒相等，这条用例就永远走不到早退分支、变成恒真。
  it('载荷里的 label 不是本窗口时整条流程早退（target option 不是唯一防线）', async () => {
    await closeRequestReady

    await handleCloseRequested('main') // 这条是发给主窗口的，而本窗口是 term-9

    expect(ipc.ptyAliveCount).not.toHaveBeenCalled()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(ipc.confirmExit).not.toHaveBeenCalled()
  })

  // V3.3：定向投递只在**两侧都配合**时才成立。Rust 那半边是 emit_to("main", …)，这半边
  // 就是这个 target。少了它，本窗口的监听器是 `{ kind: 'Any' }`，对任何 emit_to 都无条件
  // 命中——多窗口下同一次 ⌘Q 会在每个窗口各弹一个确认框。
  it('监听限定 target 为本窗口 label（否则每个拖出来的窗口都会各弹一个退出确认框）', async () => {
    await closeRequestReady
    expect(listenTargets['app-close-requested']).toEqual({ target: TEST_WINDOW_LABEL })
  })

  it('统计的是**全应用**存活 PTY 数（Rust 的 pty_alive_count），不再遍历本窗口标签', async () => {
    await closeRequestReady
    // 本窗口只有一个终端标签（1 个 PTY），而全应用有 3 个存活会话——另外两个在别的窗口
    // 里。⌘Q 会把它们一起终止，所以确认框必须报 3。初始 store 与目标数字刻意不同：
    // 如果实现退回"遍历本窗口标签"，这里会报 1 而不是 3。
    useTabs.setState({
      tabs: [
        { id: 'home', kind: 'home', title: '主页', panes: [] },
        { id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-tab-a' },
      ],
      activeId: 'tab-a',
    })
    vi.mocked(ipc.ptyAliveCount).mockResolvedValue(3)
    confirmMock.mockResolvedValue(true)

    await handleCloseRequested(TEST_WINDOW_LABEL)

    expect(confirmMock).toHaveBeenCalledWith(
      '还有 3 个会话在运行，关闭 aTerm 会终止它们。确定关闭？',
      { title: 'aTerm' },
    )
    expect(ipc.confirmExit).toHaveBeenCalled()
  })

  it('本窗口一个终端标签都没有、别的窗口却有会话时，依然报出那些会话（跨窗口的关键分支）', async () => {
    await closeRequestReady
    // store 里只有主页标签——改之前的实现会数出 0、给出不含任何警告的文案，用户点"确定"
    // 就在不知情的情况下杀掉了另一个窗口里正在跑的 claude。
    vi.mocked(ipc.ptyAliveCount).mockResolvedValue(2)
    confirmMock.mockResolvedValue(true)

    await handleCloseRequested(TEST_WINDOW_LABEL)

    expect(confirmMock).toHaveBeenCalledWith(
      '还有 2 个会话在运行，关闭 aTerm 会终止它们。确定关闭？',
      { title: 'aTerm' },
    )
  })

  it('没有任何存活会话时使用简单文案', async () => {
    await closeRequestReady
    vi.mocked(ipc.ptyAliveCount).mockResolvedValue(0)
    confirmMock.mockResolvedValue(true)

    await handleCloseRequested(TEST_WINDOW_LABEL)

    expect(confirmMock).toHaveBeenCalledWith('确定关闭 aTerm？', { title: 'aTerm' })
  })

  it('用户取消确认时不调用 confirm_exit', async () => {
    await closeRequestReady
    vi.mocked(ipc.ptyAliveCount).mockResolvedValue(1)
    confirmMock.mockResolvedValue(false)

    await handleCloseRequested(TEST_WINDOW_LABEL)

    expect(confirmMock).toHaveBeenCalled()
    expect(ipc.confirmExit).not.toHaveBeenCalled()
  })

  it('确认对话框仍在等待用户操作时，重复的关闭请求被丢弃（不堆叠出第二个对话框）', async () => {
    await closeRequestReady
    // Rust 侧在 prevent_close/prevent_exit 之后每次都会重新 emit 同一个事件，所以
    // "确认框还开着的时候用户又按了一次 ⌘Q / 又点了一次标题栏关闭按钮"完全可能发生。
    //
    // 主断言是"第二次请求连**统计**都没做"（ptyAliveCount 没有被多调一次），而不是
    // "confirm 只被调了一次"：后者的区分力靠的是"第二轮并发的 `await
    // import('@tauri-apps/plugin-dialog')` 在 vitest 里有一次会拿到真实模块并抛异常"这个
    // 巧合（同 windowClose.test.ts 里那条注释），不该依赖。
    let releaseCount!: () => void
    let countCalls = 0
    vi.mocked(ipc.ptyAliveCount).mockImplementation(() => {
      countCalls += 1
      return countCalls === 1
        ? new Promise<number>((res) => { releaseCount = () => res(1) })
        : Promise.resolve(1)
    })
    confirmMock.mockResolvedValue(true)

    const first = handleCloseRequested(TEST_WINDOW_LABEL)
    await vi.waitFor(() => expect(ipc.ptyAliveCount).toHaveBeenCalled())

    await handleCloseRequested(TEST_WINDOW_LABEL) // 第二次请求：应当被整个丢弃
    expect(countCalls).toBe(1)
    expect(confirmMock).not.toHaveBeenCalled()

    releaseCount()
    await first
    expect(confirmMock).toHaveBeenCalledTimes(1) // 没有堆出第二个对话框
    expect(ipc.confirmExit).toHaveBeenCalledTimes(1)

    // 这一轮确认已经跑完，guard 必须复位——下一次关闭请求要能重新触发一轮全新确认，
    // 而不是被永久锁死。
    await handleCloseRequested(TEST_WINDOW_LABEL)
    expect(confirmMock).toHaveBeenCalledTimes(2)
  })

  it('存活计数命令失败时保守按 0 处理，确认框照常弹出（数不出来不等于不让用户退出）', async () => {
    await closeRequestReady
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ipc.ptyAliveCount).mockRejectedValue(new Error('PtyManager 锁中毒'))
    confirmMock.mockResolvedValue(true)

    await handleCloseRequested(TEST_WINDOW_LABEL)

    expect(confirmMock).toHaveBeenCalledWith('确定关闭 aTerm？', { title: 'aTerm' })
    expect(ipc.confirmExit).toHaveBeenCalled()
    // 降级不许静默：打包后 stderr 不可见，运行期零信号正是本仓库出过事故的那类形状。
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
