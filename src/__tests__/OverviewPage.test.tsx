import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import { BLOCK_WIDTH_PX } from '../overviewLayout'
import { blockKey, useOverviewStore } from '../store/overview'
import { useSessions } from '../store/sessions'
import { makeThread } from './factories'

// OverviewPage 渲染 SessionBlock（Task 6），后者内部会调 useThreadStatus，其所在模块
// store/status.ts 在 import 时就会触发一次真实的模块级注册（listen('session-status', ...)
// + getSessionStatuses()）。测试环境没有真实的 Tauri IPC 桥，必须换成不触碰真实桥的空
// 实现——与 SessionBlock.test.tsx 同一套 mock 边界。
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
// countSubagents：Task 11 新增。真正的默认实现在下面的 beforeEach 里钉（不依赖
// afterEach 的 vi.restoreAllMocks() 对 vi.fn()〔非 vi.spyOn〕到底会不会保留它），各
// 测试按需用 mockReturnValue/mockRejectedValue/mockImplementation 覆盖。
vi.mock('../ipc', () => ({ getSessionStatuses: vi.fn(async () => []), countSubagents: vi.fn() }))
// 只测「双击到底有没有打开会话」这一件事，不牵扯 actions.ts 内部真实调用的
// useTabs.openTerminal/ptySpawn 这条重链路——那条链路有自己的测试覆盖
// （tabs.test.ts/actions 相关用例），这里换成一个可断言调用参数的 spy。
vi.mock('../actions', () => ({ resumeThread: vi.fn() }))

import { OverviewPage } from '../components/OverviewPage'
import { resumeThread } from '../actions'
import * as ipc from '../ipc'

const DIR = 'proj'

function thread(rootKey: string, title: string, lastActivityMs: number): ThreadInfo {
  return makeThread({ rootKey, resumeSessionId: `s-${rootKey}`, title, cwd: '/tmp/demo', lastActivityMs, fileCount: 1 })
}

function setProject(threads: ThreadInfo[]) {
  const project: ProjectInfo = { dirName: DIR, cwd: '/tmp/demo', lastActivityMs: Date.now(), threads }
  useSessions.setState({ projects: [project], loading: false })
}

// 与 PaneDetach.test.tsx 的 mockRects 同一手法：jsdom 没有布局引擎，
// getBoundingClientRect 恒为全零矩形，靠 spy 让 .overview-canvas 量出指定宽度。
function mockCanvasWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const w = this.classList.contains('overview-canvas') ? width : 0
    return {
      top: 0, left: 0, width: w, height: 0, right: w, bottom: 0, x: 0, y: 0,
      toJSON() { return {} },
    } as DOMRect
  })
}

beforeEach(() => {
  localStorage.clear()
  useOverviewStore.setState({ order: {}, positions: {}, names: {} })
  useSessions.setState({ projects: [], loading: false })
  // 见上面 vi.mock('../ipc', ...) 处的注释：显式钉一次默认实现，不依赖 afterEach 的
  // vi.restoreAllMocks() 对纯 vi.fn() 到底会不会保留上一次设的返回值。默认给一个永不
  // resolve 的 promise，而不是 mockResolvedValue(0)——本文件里绝大多数用例根本不关心
  // 徽章、渲染后也不会去 await 任何东西，如果默认值是一个会 resolve 的 promise，它在
  // 测试同步的断言体跑完之后才落地的那次 setState 就会落在 act() 范围之外，冒出一堆
  // 无谓的 "not wrapped in act" 警告，污染这些用例的测试输出。新加的
  // describe('sub-agent 徽章异步补齐…') 里每条用例都会自己用 mockReturnValue/
  // mockRejectedValue/mockImplementation 覆盖这个默认值。
  vi.mocked(ipc.countSubagents).mockReset().mockImplementation(() => new Promise(() => {}))
  // resumeThread 同样是模块级 vi.fn()（不是 vi.spyOn），afterEach 的 restoreAllMocks()
  // 不会清它的调用记录。下面「未拖拽、直接双击方块」那条断言的是
  // toHaveBeenCalledTimes(1)——它现在能过，只是因为本文件恰好只有这一条会打开会话的
  // 用例；再加第二条（哪怕在它前面）就会因为记录累积而失败。显式清一次，把这条断言
  // 的正确性钉在 beforeEach 上，而不是钉在"文件里碰巧只有一条"这个偶然事实上。
  vi.mocked(resumeThread).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OverviewPage', () => {
  it('按快照顺序渲染方块（新→旧）', () => {
    setProject([thread('a', 'A', 100), thread('b', 'B', 300), thread('c', 'C', 200)])

    const { container } = render(<OverviewPage dirName={DIR} />)

    const titles = Array.from(container.querySelectorAll('.session-block-title')).map((el) => el.textContent)
    expect(titles).toEqual(['B', 'C', 'A']) // 300 > 200 > 100，新→旧
  })

  it('拖拽过程中不写 localStorage，落手才写', async () => {
    mockCanvasWidth(1000)
    setProject([thread('a', 'A', 100)])
    const { container } = render(<OverviewPage dirName={DIR} />)
    const wrap = container.querySelector('.overview-block-wrap') as HTMLElement
    const key = blockKey(DIR, 'a')

    await act(async () => {
      fireEvent.pointerDown(wrap, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 })
      // buttons: 1——真实拖拽全程按住主键；实现里 handleMove 会在 e.buttons === 0 时
      // 提前退出（防御"指针捕获丢失后收到一次没有按键的补发 move"），必须显式带上
      // 才是在测真实拖拽路径，而不是误触发那条防御分支。
      fireEvent.pointerMove(wrap, { clientX: 60, clientY: 10, pointerId: 1, buttons: 1 }) // 超过 4px 阈值
    })

    // 内存中的位置已经跟手更新（否则拖拽视觉上不会动），但落盘的 localStorage 必须
    // 仍是空的——两动作范式的核心断言。
    expect(useOverviewStore.getState().positions[key]).toEqual({ x: 50, y: 0 })
    expect(localStorage.getItem('aterm.overview.positions')).toBeNull()

    await act(async () => {
      fireEvent.pointerUp(wrap, { clientX: 60, clientY: 10, pointerId: 1 })
    })

    const saved = JSON.parse(localStorage.getItem('aterm.overview.positions')!)
    expect(saved[key]).toEqual({ x: 50, y: 0 })
  })

  it('超过 4px 阈值才算拖拽，轻点不移动方块', async () => {
    mockCanvasWidth(1000)
    setProject([thread('a', 'A', 100)])
    const { container } = render(<OverviewPage dirName={DIR} />)
    const wrap = container.querySelector('.overview-block-wrap') as HTMLElement
    const key = blockKey(DIR, 'a')

    await act(async () => {
      fireEvent.pointerDown(wrap, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 })
      // buttons: 1，理由同上一个测试——要测的是"距离没过阈值"这条真实分支，不是
      // e.buttons === 0 的防御分支。
      fireEvent.pointerMove(wrap, { clientX: 12, clientY: 11, pointerId: 1, buttons: 1 }) // ~2.24px，低于阈值
      fireEvent.pointerUp(wrap, { clientX: 12, clientY: 11, pointerId: 1 })
    })

    expect(useOverviewStore.getState().positions[key]).toBeUndefined() // 从未越过阈值，setPosition 从未被调用
    expect(localStorage.getItem('aterm.overview.positions')).toBeNull()
  })

  it('容器变窄后，持久化的越界位置被钳制回可见区', () => {
    const key = blockKey(DIR, 'a')
    // 模拟「之前在宽屏下把方块拖到很右边、已经落盘」——重新打开时窗口变窄了。
    useOverviewStore.setState({
      order: { [DIR]: [key] },
      positions: { [key]: { x: 5000, y: 40 } },
      names: {},
    })
    mockCanvasWidth(600)
    setProject([thread('a', 'A', 100)])

    const { container } = render(<OverviewPage dirName={DIR} />)
    const wrap = container.querySelector('.overview-block-wrap') as HTMLElement

    expect(wrap.style.left).toBe(`${600 - BLOCK_WIDTH_PX}px`)
    expect(wrap.style.top).toBe('40px') // y 方向不设上限，原样保留
  })
})

// 回归覆盖（复审 Important 1）：越过阈值前既没有 setPointerCapture、鼠标也没有触屏
// 那种隐式捕获——如果 move/up 恰好第一下就已经落在包装 div 之外（浏览器按帧节奏
// 派发 pointermove，靠近边缘起手的快速拖拽很容易一步跨过一个 260×116 的方块），
// 旧实现（React 的 onPointerMove/onPointerUp 直接挂在 wrap 上）完全收不到这两个
// 事件：dragging 永远不会置 true，pointerup 也收不到，dragRef.current 就此变成一条
// 不会被清理的陈旧记录；鼠标的 pointerId 在整个会话期间不变，之后哪怕只是把光标
// 悬停回同一个方块（完全没有按键），也会用这条陈旧记录算出一次"越过阈值"的假拖拽。
// 新实现在 pointerdown 里用原生 window 级监听器接管整个手势，不依赖事件目标是否
// 落在 wrap 上，下面直接验证这条路径修好了。
describe('OverviewPage —— pointermove/pointerup 落在包装 div 之外时仍能正确收尾（回归）', () => {
  it('拖拽途中 move/up 都落在方块之外：照常落盘；之后一次没有按键的悬停不会被误判成拖拽的延续', () => {
    mockCanvasWidth(1000)
    setProject([thread('a', 'A', 100)])
    const { container } = render(<OverviewPage dirName={DIR} />)
    const wrap = container.querySelector('.overview-block-wrap') as HTMLElement
    const key = blockKey(DIR, 'a')

    fireEvent.pointerDown(wrap, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 })
    // 第一次 pointermove 本身就已经跑出方块边界——直接派发在 document.body 上，
    // 模拟真实浏览器一步就越过一个小方块的场景。旧实现里这个事件永远到不了 wrap 上
    // 的 onPointerMove；新实现靠挂在 window 上的原生监听器接住，不关心事件目标。
    fireEvent.pointerMove(document.body, { clientX: 300, clientY: 10, pointerId: 1, buttons: 1 })
    // pointerup 同样落在方块之外。
    fireEvent.pointerUp(document.body, { clientX: 300, clientY: 10, pointerId: 1 })

    // 越过了 4px 阈值，仍然是一次合法的拖拽（只是起手那一刻指针已经不在 wrap 上），
    // 应当照常落盘。
    const savedAfterDrag = JSON.parse(localStorage.getItem('aterm.overview.positions')!)
    expect(savedAfterDrag[key]).toEqual({ x: 290, y: 0 })

    // 现在把光标悬停回这个方块，但完全没有按键——这正是旧 bug 的触发条件：如果
    // dragRef 残留成陈旧记录，这次悬停会被误判成一次新拖拽的继续。
    fireEvent.pointerMove(wrap, { clientX: 305, clientY: 10, pointerId: 1, buttons: 0 })

    // 复审纠正：这一步原来断言的是 localStorage 不变，但被劫持的悬停只会调
    // setPosition（只改内存，从不 commitPosition），localStorage 在 bug 版本下同样
    // 不会变——那个断言两种实现都能通过，证明不了任何东西。真正会被这次悬停悄悄
    // 改写的是内存中的 positions，必须断言它。
    expect(useOverviewStore.getState().positions[key]).toEqual({ x: 290, y: 0 })
  })
})

// 回归覆盖（复审新发现的 Important）：pointerdown 时无条件调用的 blockSelect() 会给
// body 加上屏蔽文本选择的 class（dragGhost.ts 的 DRAG_NO_SELECT_CLASS），这个 class
// 只有 useDragGhost 的 end() 会移除。上一轮修复漏了在 endDrag() 里调用它——单纯点一下
// 方块（从未越过阈值）就会让这个 class 永久卡在 body 上，直到某个不相关的标签/侧边栏/
// 窗格拖拽碰巧调用了它自己的 end() 才会被带走。
describe('OverviewPage —— pointerdown 屏蔽的文本选择必须在手势结束时解除（回归）', () => {
  it('单纯点一下方块（未越过阈值）：body 上不残留 dragging-no-select class', () => {
    setProject([thread('a', 'A', 100)])
    const { container } = render(<OverviewPage dirName={DIR} />)
    const wrap = container.querySelector('.overview-block-wrap') as HTMLElement

    fireEvent.pointerDown(wrap, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 })
    fireEvent.pointerUp(wrap, { clientX: 10, clientY: 10, pointerId: 1 }) // 没有移动，纯点击

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
  })

  it('真正越过阈值拖拽一次后落手：同样不残留 class', () => {
    mockCanvasWidth(1000)
    setProject([thread('a', 'A', 100)])
    const { container } = render(<OverviewPage dirName={DIR} />)
    const wrap = container.querySelector('.overview-block-wrap') as HTMLElement

    fireEvent.pointerDown(wrap, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 })
    fireEvent.pointerMove(wrap, { clientX: 60, clientY: 10, pointerId: 1, buttons: 1 })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true) // 拖拽期间应该是加上的

    fireEvent.pointerUp(wrap, { clientX: 60, clientY: 10, pointerId: 1 })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
  })
})

// 复审发现：这两条测试原先被合并成一条、且注释声称它"验证了捕获时机"——这站不住
// 脚，拆成两条，各自诚实地说明自己的证明力边界。
//
// 第一条只验证"SessionBlock 的 onDoubleClick 确实接到了 onOpen"这一件事：
// fireEvent.doubleClick 直接派发一次裸 dblclick，不经过任何 pointerdown/move/up
// 序列，因此它在"pointerdown 就捕获"与"越过阈值才捕获"两种设计下都会通过——不能
// 用它证明捕获时机本身。何况 jsdom 根本没有实现指针捕获（HTMLElement.prototype 上
// setPointerCapture/hasPointerCapture 都是 undefined），这个仓库里任何一条 jsdom
// 测试单靠默认环境都无法从行为上区分这两种设计。这条测试留着是因为"双击能穿过这层
// 拖拽包装送达 onOpen"本身值得回归覆盖；捕获时机该在哪一刻发生，依据是下面
// DraggableBlock 组件顶部注释引用的 TabPanes.tsx/ContextMenu.tsx 历史教训，不是
// 这条测试。
//
// 第二条才是真正给"越过阈值前从不捕获指针"这句话找证据：手动在
// HTMLElement.prototype 上打一个 setPointerCapture 桩（jsdom 原生没有这个方法，
// 不打桩的话实现里的可选链 `?.()` 会直接短路成空操作，无法区分"没调用"和"方法
// 不存在"），走一次低于 4px 阈值的完整 pointerdown→pointermove→pointerup 序列
// 再双击，断言桩全程未被调用过。
describe('OverviewPage —— 拖拽手柄不吞掉 SessionBlock 自己的双击', () => {
  it('未拖拽、直接双击方块：仍然打开会话（只验证 onOpen 接线，不涉及捕获时机）', () => {
    setProject([thread('a', 'A', 100)])
    const { container } = render(<OverviewPage dirName={DIR} />)
    const block = container.querySelector('.session-block') as HTMLElement

    fireEvent.doubleClick(block)

    expect(vi.mocked(resumeThread)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resumeThread)).toHaveBeenCalledWith(
      DIR, '/tmp/demo', expect.objectContaining({ rootKey: 'a' }),
    )
  })

  describe('setPointerCapture 桩', () => {
    afterEach(() => {
      // jsdom 本来就没有这个方法（下面的赋值是测试自己加的桩）——无条件 delete，
      // 就算某个用例断言失败提前抛出也不会漏清理，不污染同文件后面的测试。
      delete (HTMLElement.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture
    })

    it('未越过阈值的完整指针序列 + 双击：setPointerCapture 全程未被调用', () => {
      const captureSpy = vi.fn()
      ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = captureSpy

      setProject([thread('a', 'A', 100)])
      const { container } = render(<OverviewPage dirName={DIR} />)
      const wrap = container.querySelector('.overview-block-wrap') as HTMLElement
      const block = container.querySelector('.session-block') as HTMLElement

      fireEvent.pointerDown(wrap, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 })
      fireEvent.pointerMove(wrap, { clientX: 12, clientY: 11, pointerId: 1, buttons: 1 }) // ~2.24px，低于阈值
      fireEvent.pointerUp(wrap, { clientX: 12, clientY: 11, pointerId: 1 })
      fireEvent.doubleClick(block)

      expect(captureSpy).not.toHaveBeenCalled()
    })
  })
})

// Task 11：sub-agent 徽章异步补齐。方块必须先用 Task 2 的 bounded 数据画出来，
// count_subagents 是全仓库唯一的整读大文件操作（Rust 侧 cache，仍可能是冷启动的大
// 开销），因此这枚徽章必须在渲染之后异步补——首屏绝不等它。
describe('sub-agent 徽章异步补齐（不阻塞首屏）', () => {
  beforeEach(() => {
    setProject([thread('a', '重构解析器', 100)])
  })

  it('方块先渲染，⑂ 徽章随后出现', async () => {
    let resolveCount: (n: number) => void = () => {}
    vi.mocked(ipc.countSubagents).mockReturnValue(new Promise((r) => { resolveCount = r }))
    render(<OverviewPage dirName="proj" />)
    // 首屏：方块已在，徽章未到
    expect(await screen.findByText('重构解析器')).toBeTruthy()
    expect(screen.queryByText(/⑂/)).toBeNull()
    // 计数返回后徽章出现
    resolveCount(7)
    expect(await screen.findByText('⑂ 7')).toBeTruthy()
  })

  // 终审 Important 1：Rust 侧不再从 rootKey 反推该数哪个文件（那要把整个项目目录
  // 重扫一遍——每个 .jsonl 读头 40 行/256KB + 尾 64KB 再各跑一次 parse_meta，代价
  // N×F），改由前端把手里现成的 ThreadInfo.resumeSessionId 传进去。传错的后果是静默
  // 的：Rust 侧会拼出一个不存在的文件名，按既有约定返回 Ok(0)，所有徽章一起消失，
  // 没有任何报错。这条测试钉住传的确实是 sessionId。
  it('传给 Rust 的是 resumeSessionId，不是 rootKey', () => {
    // 沿用 beforeEach 钉的默认实现（永不 resolve）：本例只关心用什么参数调，不关心
    // 返回值。worker 在 await 之前就同步打出这一通调用，render 返回时已经发生。
    render(<OverviewPage dirName="proj" />)
    expect(vi.mocked(ipc.countSubagents)).toHaveBeenCalledWith('proj', 's-a')
    expect(vi.mocked(ipc.countSubagents)).not.toHaveBeenCalledWith('proj', 'a')
  })

  // 复审纠正：原版只种了一个 thread，标题却叫"其它方块不受影响"——场上压根没有
  // 别的方块，这句话没有被验证到（行为本身是对的，per-item try/catch 靠读代码
  // 确认，不是靠这条测试）。改成两个 thread：一个失败、一个成功，断言失败的那个
  // 不出徽章，成功的那个正常出，且只出这一个——这样"没受牵连"才是真的被断言到。
  it('计数失败时静默略过该徽章，其它方块不受影响', async () => {
    setProject([
      thread('a', '重构解析器', 100),
      thread('b', '正常会话', 90),
    ])
    // 第二个参数是 sessionId（= ThreadInfo.resumeSessionId），不是 rootKey——
    // 上面的 thread() 工厂把它造成 `s-${rootKey}`。
    vi.mocked(ipc.countSubagents).mockImplementation((_dirName, sessionId) =>
      sessionId === 's-a' ? Promise.reject(new Error('读文件失败')) : Promise.resolve(5),
    )
    render(<OverviewPage dirName="proj" />)
    expect(await screen.findByText('重构解析器')).toBeTruthy()
    expect(await screen.findByText('正常会话')).toBeTruthy()
    // 成功的那个（rootKey 'b'）徽章正常出现……
    expect(await screen.findByText('⑂ 5')).toBeTruthy()
    // ……而且场上只有这一个 ⑂ 徽章——失败的那个（rootKey 'a'）没有被拖累出一个
    // 假徽章，也没有任何徽章泄漏到不该出现的地方。
    const badges = screen.queryAllByText(/⑂/)
    expect(badges.length).toBe(1)
    expect(badges[0].textContent).toBe('⑂ 5')
  })

  // 终审删除：这里原本还有一条「组件卸载后到达的响应不写 state」。它自己的注释就
  // 写明了它在有守卫和没守卫两种实现下都会通过（React 19 的 createRoot 路径下，卸载
  // 后的 setState 只是静默 no-op，不打 console.error），也就是说它证明不了任何事，
  // 却在文件列表里占着一行"覆盖率"。守卫（OverviewPage.tsx 的 subagentEpochRef）
  // 保留，理由已经写进那里的代码注释。

  // 下面这条的正文由实现者自己写实（简报只给了一句注释：「构造 20 个 thread；断言
  // 首轮同时在飞的调用数不超过 4」）。
  //
  // 证明力设计：mock 实现让 countSubagents 调用时同步记一次调用、但返回一个直到测试
  // 手动放行才 resolve 的 promise——worker 池里每个 worker 在 await 之前都会同步打这一
  // 通调用，所以"首轮到底发了几个请求"精确等于 render() 刚返回那一刻的调用次数，不需要
  // 猜测事件循环时序。
  //   - 如果实现根本没做并发上限（一次性 for 循环发全部 20 个），这里会是 20，第一个
  //     断言就会失败。
  //   - 如果实现把「并发上限」错当成「只发前 4 个，不再补位」（例如 slice(0,4) 而不是
  //     真正的工作队列），第一个断言能过，但放行一个之后调用数不会补到 5，第二个断言
  //     会失败——单看"首轮是不是 4"这一件事无法把这两种实现区分开，所以两个断言缺一
  //     不可。
  it('并发受限：会话很多时不一次性发起全部请求', async () => {
    const resolvers: Array<(n: number) => void> = []
    vi.mocked(ipc.countSubagents).mockImplementation(
      () => new Promise<number>((resolve) => { resolvers.push(resolve) }),
    )
    const threads = Array.from({ length: 20 }, (_, i) => thread(`t${i}`, `T${i}`, 1000 - i))
    setProject(threads)

    render(<OverviewPage dirName="proj" />)

    expect(vi.mocked(ipc.countSubagents).mock.calls.length).toBe(4)

    resolvers[0](0)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(vi.mocked(ipc.countSubagents).mock.calls.length).toBe(5)
  })

  // 复审 Important：上面那条测试只覆盖"一次性发现一大批目标"这一种调度轮次，
  // 抓不住"两轮调度时间窗重叠"这个真实场景（App.tsx:35 窗口聚焦触发的周期性
  // refresh，在终端复用场景下会很频繁；一个超过 4 个会话的项目，上一轮的池子
  // 大概率还没 drain 完就等来了下一轮）。如果并发上限是按"这一轮 effect 各起一个
  // 独立的、上限为 4 的 worker 池"实现的（而不是按"这个组件当前总共有多少个请求
  // 在飞"），第一轮 4 个仍在飞时，第二轮只要发现哪怕一个新目标，也会在原有 4 个
  // 之上再起一个新 worker——总在飞数摸到 5，就已经越过了"上限是 4"这句话。
  it('并发受限（重叠调度轮次）：第二轮新目标只是排队，不在原有 4 个之上再起新 worker', async () => {
    const resolvers: Array<(n: number) => void> = []
    vi.mocked(ipc.countSubagents).mockImplementation(
      () => new Promise<number>((resolve) => { resolvers.push(resolve) }),
    )
    // 首批 5 个候选：并发上限 4，第 5 个理应还在队列里排队，不属于"在飞"。
    const initialThreads = Array.from({ length: 5 }, (_, i) => thread(`t${i}`, `T${i}`, 1000 - i))
    setProject(initialThreads)

    render(<OverviewPage dirName="proj" />)
    expect(vi.mocked(ipc.countSubagents).mock.calls.length).toBe(4)

    // 首批 4 个全部仍在飞（mock 从不 resolve，故意不放行任何一个），此时触发第二轮
    // 调度：一个新会话到达——同一个组件实例、dirName 不变，只是 threads 换了新引用
    // （与 App.tsx 周期性 refresh 换出新 projects 数组同一种触发方式），会经
    // captureOrder 把这个新 key 追加进 order，进而让下面调度 effect 的依赖数组
    // （[dirName, order, byKey]）变化、重新跑一轮。
    const newThread = thread('t-new', 'NEW', 2000)
    act(() => {
      setProject([...initialThreads, newThread])
    })

    // 关键断言：总在飞数必须原地不动，仍是 4——4 个位置早已占满，这个新目标只能
    // 排进共享队列，不能在原有 4 个之上再单独起一个新 worker（那样会变成 5）。
    expect(vi.mocked(ipc.countSubagents).mock.calls.length).toBe(4)

    // 放行一个旧的，腾出的位置应该立刻被队列里排队的下一个（不论是首批第 5 个、
    // 还是这次新到的）补上——证明这确实是一个跨轮次共享的队列，而不是"新目标被
    // 发现了、却因为上限已经用完就再也没人来处理"。
    resolvers[0](0)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(vi.mocked(ipc.countSubagents).mock.calls.length).toBe(5)
  })
})

describe('OverviewPage —— 状态色图例', () => {
  it('三种状态的中文标签都列出来（此前只存在于状态点的悬停提示里）', () => {
    setProject([thread('a', 'A', 100)])

    const { container } = render(<OverviewPage dirName={DIR} />)
    const legend = container.querySelector('.overview-legend')!

    expect(legend.textContent).toContain('运行中')
    expect(legend.textContent).toContain('等你回答')
    expect(legend.textContent).toContain('已完成')
  })

  it('图例的色块是 StatusDot 组件本身，不是另画的一套', () => {
    setProject([thread('a', 'A', 100)])

    const { container } = render(<OverviewPage dirName={DIR} />)
    const legend = container.querySelector('.overview-legend')!

    // 这三条断言是"防脱节"守卫：若有人把图例改成自己写的色块 <span>，
    // 状态配色再调整时图例就会和方块上的实际颜色对不上，而这里会先失败。
    expect(legend.querySelector('.status-dot-running')).toBeTruthy()
    expect(legend.querySelector('.status-dot-awaitingInput')).toBeTruthy()
    expect(legend.querySelector('.status-dot-done')).toBeTruthy()
  })

  it('没有任何会话时图例依然显示（否则空项目里用户更无从得知颜色含义）', () => {
    setProject([])

    const { container } = render(<OverviewPage dirName={DIR} />)
    expect(container.querySelector('.overview-legend')).toBeTruthy()
  })
})
