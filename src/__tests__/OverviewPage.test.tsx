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
      fireEvent.pointerDown(wrap, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(wrap, { clientX: 60, clientY: 10, pointerId: 1 }) // 超过 4px 阈值
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
      fireEvent.pointerDown(wrap, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(wrap, { clientX: 12, clientY: 11, pointerId: 1 }) // ~2.24px，低于阈值
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

// 直接对应本任务的核心告诫（不能重演"手柄 setPointerCapture 接管指针、后代节点
// 自己的 click 再也发不出来"这个 bug 类，见 ContextMenu.tsx/TabPanes.tsx 的历史
// 教训）：拖拽手柄 .overview-block-wrap 包着 SessionBlock，后者双击空白区域要触发
// onOpen。这里不越过阈值地双击，验证 onOpen 能穿过这层包装正常送达。
describe('OverviewPage —— 拖拽手柄不吞掉 SessionBlock 自己的双击（未越过阈值时从不捕获指针）', () => {
  it('未拖拽、直接双击方块：仍然打开会话（resumeThread 收到正确参数）', () => {
    setProject([thread('a', 'A', 100)])
    const { container } = render(<OverviewPage dirName={DIR} />)
    const block = container.querySelector('.session-block') as HTMLElement

    fireEvent.doubleClick(block)

    expect(vi.mocked(resumeThread)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resumeThread)).toHaveBeenCalledWith(
      DIR, '/tmp/demo', expect.objectContaining({ rootKey: 'a' }),
    )
  })
})
