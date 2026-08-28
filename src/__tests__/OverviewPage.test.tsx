import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import { BLOCK_WIDTH_PX } from '../overviewLayout'
import { blockKey, useOverviewStore } from '../store/overview'
import { useSessions } from '../store/sessions'

// OverviewPage 渲染 SessionBlock（Task 6），后者内部会调 useThreadStatus，其所在模块
// store/status.ts 在 import 时就会触发一次真实的模块级注册（listen('session-status', ...)
// + getSessionStatuses()）。测试环境没有真实的 Tauri IPC 桥，必须换成不触碰真实桥的空
// 实现——与 SessionBlock.test.tsx 同一套 mock 边界。
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../ipc', () => ({ getSessionStatuses: vi.fn(async () => []) }))
// 只测「双击到底有没有打开会话」这一件事，不牵扯 actions.ts 内部真实调用的
// useTabs.openTerminal/ptySpawn 这条重链路——那条链路有自己的测试覆盖
// （tabs.test.ts/actions 相关用例），这里换成一个可断言调用参数的 spy。
vi.mock('../actions', () => ({ resumeThread: vi.fn() }))

import { OverviewPage } from '../components/OverviewPage'
import { resumeThread } from '../actions'

const DIR = 'proj'

function thread(rootKey: string, title: string, lastActivityMs: number): ThreadInfo {
  return {
    rootKey, resumeSessionId: `s-${rootKey}`, title, cwd: '/tmp/demo', lastActivityMs, fileCount: 1,
  }
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

    // 没有产生第二次持久化：上一次拖拽早已在 pointerup 时正常收尾（dragRef 已清空、
    // window 监听器已摘除），这次无按键的悬停不会被当成拖拽的延续。
    const savedAfterHover = JSON.parse(localStorage.getItem('aterm.overview.positions')!)
    expect(savedAfterHover[key]).toEqual({ x: 290, y: 0 })
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
