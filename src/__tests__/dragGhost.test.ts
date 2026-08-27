import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useDragGhost } from '../store/dragGhost'

// store/dragGhost.ts 是三个拖拽源（TabBar.tsx/Sidebar.tsx/TabPanes.tsx）共用的
// "屏蔽文本选择 + 跟随光标指示"状态机，本身不依赖 React/DOM 之外的东西（只摸
// document.body.classList），可以脱离组件树单独测试。交互层面的集成（拖拽手势驱动
// start/move/end）在 TabBar.test.tsx/Sidebar.test.tsx/PaneDetach.test.tsx 里覆盖。
describe('useDragGhost：屏蔽文本选择的 body class + 跟随光标的指示状态', () => {
  beforeEach(() => {
    useDragGhost.setState({ visible: false, label: '', x: 0, y: 0 })
    document.body.classList.remove('dragging-no-select')
    document.body.classList.remove('dragging-grab')
  })
  afterEach(() => {
    document.body.classList.remove('dragging-no-select')
    document.body.classList.remove('dragging-grab')
  })

  it('start：body 加上屏蔽选择 + 抓取光标两个 class，visible/label/初始坐标写入 state', () => {
    useDragGhost.getState().start('会话 A', 10, 20)

    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.body.classList.contains('dragging-grab')).toBe(true)
    const s = useDragGhost.getState()
    expect(s.visible).toBe(true)
    expect(s.label).toBe('会话 A')
    expect(s.x).toBe(10)
    expect(s.y).toBe(20)
  })

  it('end：移除两个 body class，visible 变回 false', () => {
    useDragGhost.getState().start('会话 A', 10, 20)

    useDragGhost.getState().end()

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDragGhost.getState().visible).toBe(false)
  })

  it('end 在从未 start 过的情况下是安全的空操作（调用方无条件调用它）', () => {
    expect(() => useDragGhost.getState().end()).not.toThrow()
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDragGhost.getState().visible).toBe(false)
  })

  it('blockSelect：只加屏蔽选择的 class，不加抓取光标的 class（按下但还没确认是拖拽时，光标不该变）', () => {
    useDragGhost.getState().blockSelect()

    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDragGhost.getState().visible).toBe(false) // 尚未确认是拖拽，指示也不出现
  })

  it('move：坐标最终经 requestAnimationFrame 合并写入 state（不立即同步写入）', async () => {
    useDragGhost.getState().start('会话 A', 0, 0)

    useDragGhost.getState().move(30, 40)
    // rAF 尚未触发前，坐标还是 start() 写入的初始值。
    expect(useDragGhost.getState().x).toBe(0)

    await new Promise((r) => requestAnimationFrame(r))
    expect(useDragGhost.getState().x).toBe(30)
    expect(useDragGhost.getState().y).toBe(40)
  })

  it('move：同一帧内多次调用只保留最后一次坐标（合并进同一个 requestAnimationFrame）', async () => {
    useDragGhost.getState().start('会话 A', 0, 0)

    useDragGhost.getState().move(10, 10)
    useDragGhost.getState().move(20, 20)
    useDragGhost.getState().move(99, 99)

    await new Promise((r) => requestAnimationFrame(r))
    expect(useDragGhost.getState()).toMatchObject({ x: 99, y: 99 })
  })

  it('end 会取消尚未触发的 rAF：随后不会再把 move() 排队的坐标写回', async () => {
    useDragGhost.getState().start('会话 A', 0, 0)
    useDragGhost.getState().move(50, 50)

    useDragGhost.getState().end()

    await new Promise((r) => requestAnimationFrame(r))
    expect(useDragGhost.getState().x).toBe(0) // 未被 move() 排队的坐标覆盖
  })
})
