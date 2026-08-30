import { describe, expect, it } from 'vitest'
import { planPanelCollapse, planPanelExpand, WINDOW_MIN_WIDTH_CSS } from './panelWindow'

describe('WINDOW_MIN_WIDTH_CSS', () => {
  it('与 src-tauri/tauri.conf.json 的 windows[0].minWidth 保持一致', () => {
    expect(WINDOW_MIN_WIDTH_CSS).toBe(800)
  })
})

describe('planPanelExpand：展开面板时窗口怎么挪、怎么变宽', () => {
  it('右边空间够：只变宽，x 不动（"先尽量向右展开"）', () => {
    const win = { x: 100, width: 500 }
    const workArea = { x: 0, width: 1920 }
    expect(planPanelExpand(win, workArea, 400)).toEqual({ x: 100, width: 900 })
  })

  it('右边不够：把窗口向左挪，让新宽度刚好贴住工作区右边界', () => {
    const win = { x: 1500, width: 500 } // 右边界 2000，超出下面的工作区右边界 1920
    const workArea = { x: 0, width: 1920 }
    // target = 900；1500+900=2400 > 1920，向左挪：x = 0+1920-900 = 1020
    expect(planPanelExpand(win, workArea, 400)).toEqual({ x: 1020, width: 900 })
  })

  it('整个工作区都放不下：铺满工作区（最后的退路，差额留给 flex 布局压缩终端区）', () => {
    const win = { x: 100, width: 1800 }
    const workArea = { x: 0, width: 1920 }
    // target = 2100 > workArea.width(1920)
    expect(planPanelExpand(win, workArea, 300)).toEqual({ x: 0, width: 1920 })
  })

  it('边界恰好放得下：新宽度的右边界正好等于工作区右边界，走"只变宽"分支而非"左移"分支', () => {
    const win = { x: 1020, width: 500 }
    const workArea = { x: 0, width: 1920 }
    // target = 900；1020+900 = 1920，恰好等于 workArea.x+workArea.width，不触发左移
    expect(planPanelExpand(win, workArea, 400)).toEqual({ x: 1020, width: 900 })
  })
})

describe('planPanelCollapse：收起面板时窗口怎么缩', () => {
  it('正常缩：只改 width，x 原样保留', () => {
    const win = { x: 100, width: 900 }
    expect(planPanelCollapse(win, 400, 100)).toEqual({ x: 100, width: 500 })
  })

  it('撞到 minWidth：被钳住，不会缩到比 minWidth 还窄', () => {
    const win = { x: 100, width: 900 }
    expect(planPanelCollapse(win, 700, 500)).toEqual({ x: 100, width: 500 })
  })

  it('x 不变：即便反复收起，也不会让窗口跟着挪位置（避免多次开合来回漂移）', () => {
    const win = { x: 777, width: 900 }
    const result = planPanelCollapse(win, 100, 0)
    expect(result.x).toBe(777)
  })
})
