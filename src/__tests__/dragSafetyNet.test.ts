import { afterEach, describe, expect, it } from 'vitest'
import { attachDragSafetyNet } from '../dragSafetyNet'

// 本轮修复的直接回归测试（见 .superpowers/drag-blur-fix-report.md）：上一轮 blur 兜底用
// capture:true 挂在 window 上。捕获阶段对不冒泡的事件同样会先经过 window——文档树里
// 任意元素的 blur（不只是窗口整体失焦）都会被这张网误判成"应当中止拖拽"，pointerdown
// 之后第一次 pointermove 之前，dragRef 就已经被清空，导致所有拖拽都失效（TabBar/
// Sidebar/TabPanes 三处拖拽源共用同一张网，症状是全局性的）。
//
// 这里直接测 attachDragSafetyNet 本身（不经过任何组件），隔离验证"谁触发了 trigger()"
// 这条判据，端到端的用户可见症状另在 TabBar.test.tsx 里单独覆盖一条。
describe('attachDragSafetyNet — blur 只应响应窗口整体失焦，不是文档树里任意元素失焦', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('target 是 DOM 元素（不是 window）的 blur：drag 保持存活，不触发 endDrag()', async () => {
    let active = true
    let endCalls = 0
    cleanup = attachDragSafetyNet(1, () => active, () => {
      endCalls++
      active = false
    })

    const el = document.createElement('input')
    document.body.appendChild(el)
    el.focus()
    // blur 本身不冒泡——这正是本次回归的关键：捕获阶段挂在 window 上的监听器曾经
    // 依然能看到它（问题所在），非捕获阶段的监听器则完全看不到（本次修复后的状态）。
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false, cancelable: false }))
    await Promise.resolve() // trigger() 内部用 queueMicrotask 延后判断，见 dragSafetyNet.ts

    expect(endCalls).toBe(0)
    expect(active).toBe(true)

    document.body.removeChild(el)
  })

  it('target 是 window 的 blur（窗口整体失焦，例如 ⌘Tab 切到另一个 App）：仍然结束 drag——这是这张网真正要捕获的场景', async () => {
    let active = true
    let endCalls = 0
    cleanup = attachDragSafetyNet(1, () => active, () => {
      endCalls++
      active = false
    })

    window.dispatchEvent(new Event('blur'))
    await Promise.resolve()

    expect(endCalls).toBe(1)
    expect(active).toBe(false)
  })

  it('pointerup/pointercancel 的 pointerId 过滤行为未受影响（本次修复只动 blur 那一路）', async () => {
    let active = true
    let endCalls = 0
    cleanup = attachDragSafetyNet(1, () => active, () => {
      endCalls++
      active = false
    })

    // 无关 pointerId 的 pointerup 不应打断
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true, cancelable: true }))
    await Promise.resolve()
    expect(endCalls).toBe(0)
    expect(active).toBe(true)

    // 匹配 pointerId 的 pointerup 才会打断
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
    await Promise.resolve()
    expect(endCalls).toBe(1)
    expect(active).toBe(false)
  })
})
