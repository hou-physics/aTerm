import { describe, expect, it } from 'vitest'
import {
  clampDividerDrag,
  decidePaneFit,
  DIVIDER_TOTAL_WIDTH_PX,
  equalPaneWidths,
  fitsPanes,
  MAX_PANES,
  MIN_PANE_WIDTH_PX,
  neighborPaneId,
  paneFitShortfall,
  PANE_BORDER_TOTAL_WIDTH_PX,
  previewPaneDrop,
  TERM_WRAP_HORIZONTAL_PADDING_PX,
  usablePaneAreaWidth,
} from './paneLayout'

describe('equalPaneWidths', () => {
  it('1 个窗格占满', () => {
    expect(equalPaneWidths(1)).toEqual([1])
  })
  it('2 个窗格各占一半', () => {
    expect(equalPaneWidths(2)).toEqual([0.5, 0.5])
  })
  it('3 个窗格各占三分之一，和为 1', () => {
    const widths = equalPaneWidths(3)
    expect(widths).toHaveLength(3)
    widths.forEach((w) => expect(w).toBeCloseTo(1 / 3))
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
  it('0 个窗格返回空数组', () => {
    expect(equalPaneWidths(0)).toEqual([])
  })
})

describe('fitsPanes：容器宽度是否够每个窗格达到 320px 最小宽度', () => {
  it('恰好达到临界值时算装得下', () => {
    expect(fitsPanes(2, 640)).toBe(true)
    expect(fitsPanes(3, 960)).toBe(true)
  })
  it('差 1px 也算装不下', () => {
    expect(fitsPanes(2, 639)).toBe(false)
    expect(fitsPanes(3, 959)).toBe(false)
  })
  it('0 个窗格恒为装得下（没有要放的东西）', () => {
    expect(fitsPanes(0, 0)).toBe(true)
  })
})

describe('usablePaneAreaWidth：扣除分隔条/窗格边框/容器内边距后的真实可用宽度', () => {
  it('2 个窗格：扣除 12px 容器内边距 + 1 条分隔条 9px + 2 个窗格边框各 2px', () => {
    // 与 App.css 对应关系见 paneLayout.ts 顶部常量注释：.term-wrap padding 12px、
    // .pane-divider 9px、.pane border 2px。
    expect(usablePaneAreaWidth(640, 2)).toBe(640 - 12 - 9 - 4)
    expect(TERM_WRAP_HORIZONTAL_PADDING_PX).toBe(12)
    expect(DIVIDER_TOTAL_WIDTH_PX).toBe(9)
    expect(PANE_BORDER_TOTAL_WIDTH_PX).toBe(2)
  })

  it('3 个窗格：2 条分隔条 + 3 个窗格边框', () => {
    expect(usablePaneAreaWidth(996, 3)).toBe(996 - 12 - 9 * 2 - 2 * 3)
  })

  it('paneCount<=0 时没有意义，原样返回测量值', () => {
    expect(usablePaneAreaWidth(500, 0)).toBe(500)
    expect(usablePaneAreaWidth(500, -1)).toBe(500)
  })

  it('开销大于测量值时钳在 0，不产生负数', () => {
    expect(usablePaneAreaWidth(10, 3)).toBe(0)
  })
})

describe('fitsPanes 接上 usablePaneAreaWidth 之后的真实边界（修正此前"测量值直接当可用宽度"的漏洞）', () => {
  it('2 窗格：原先被误判"刚好装得下"的 640px 原始测量值，扣除开销后应正确拒绝', () => {
    // 修正前：fitsPanes(2, 640) 直接把 640 当成可分配给窗格内容的宽度，判定为装得下；
    // 但 640px 是 .term-wrap/.content 的原始 clientWidth，其中 12+9+4=25px 根本分不到
    // 窗格内容区，真实可用宽度只有 615px，两个窗格无论怎么分都凑不出各 320px。
    const usable = usablePaneAreaWidth(640, 2)
    expect(usable).toBe(615)
    expect(fitsPanes(2, usable)).toBe(false)
  })

  it('2 窗格：把开销加回边界后（665px 原始测量值）修正后仍然装得下', () => {
    const usable = usablePaneAreaWidth(640 + 12 + 9 + 4, 2) // 665
    expect(usable).toBe(640)
    expect(fitsPanes(2, usable)).toBe(true)
  })

  it('3 窗格：原先被误判"刚好装得下"的 960px 原始测量值，扣除开销后应正确拒绝', () => {
    const usable = usablePaneAreaWidth(960, 3)
    expect(usable).toBe(960 - 12 - 18 - 6) // 924
    expect(fitsPanes(3, usable)).toBe(false)
  })

  it('3 窗格：把开销加回边界后（996px 原始测量值）修正后仍然装得下', () => {
    const usable = usablePaneAreaWidth(960 + 12 + 18 + 6, 3) // 996
    expect(usable).toBe(960)
    expect(fitsPanes(3, usable)).toBe(true)
  })
})

describe('clampDividerDrag：分隔条拖拽的占比数学（纯函数，覆盖两端夹紧）', () => {
  it('两窗格：正常范围内的拖拽按像素精确转换为占比', () => {
    // 容器 800px，起始各占一半（400/400）；两侧之和 800px，未夹紧范围是 [320,480]，
    // 即最多能挪 ±80px——这里向右拖 50px（未触边），验证换算本身的精度。
    const next = clampDividerDrag([0.5, 0.5], 0, 50, 800)
    expect(next[0]).toBeCloseTo(450 / 800)
    expect(next[1]).toBeCloseTo(350 / 800)
    expect(next[0] + next[1]).toBeCloseTo(1)
  })

  it('两窗格：拖到远超右侧最小宽度时，左侧被夹到"容器宽度 - 320px"这个上限', () => {
    const next = clampDividerDrag([0.5, 0.5], 0, 1000, 800)
    expect(next[0] * 800).toBeCloseTo(800 - MIN_PANE_WIDTH_PX) // 480px
    expect(next[1] * 800).toBeCloseTo(MIN_PANE_WIDTH_PX) // 320px，右侧被夹到最小宽度
  })

  it('两窗格：向左拖到远超左侧最小宽度时，左侧被夹到 320px 下限', () => {
    const next = clampDividerDrag([0.5, 0.5], 0, -1000, 800)
    expect(next[0] * 800).toBeCloseTo(MIN_PANE_WIDTH_PX) // 320px，左侧被夹到最小宽度
    expect(next[1] * 800).toBeCloseTo(800 - MIN_PANE_WIDTH_PX) // 480px
  })

  it('三窗格：只调整被拖动分隔条两侧的窗格，第三个窗格占比不受影响', () => {
    const widths = equalPaneWidths(3) // [1/3, 1/3, 1/3]，容器 1200px（各 400px）
    const next = clampDividerDrag(widths, 0, -1000, 1200) // 拖 index 0（pane0/pane1 之间）
    expect(next[2]).toBeCloseTo(widths[2]) // 第三个窗格原样不变
    expect(next[0] * 1200).toBeCloseTo(MIN_PANE_WIDTH_PX) // pane0 被夹到 320px 下限
    expect(next[1] * 1200).toBeCloseTo(800 - MIN_PANE_WIDTH_PX) // pane0+pane1 的 800px 里剩下的都给 pane1
    expect(next[0] + next[1] + next[2]).toBeCloseTo(1)
  })

  it('三窗格：拖动 index 1（pane1/pane2 之间）不影响 pane0', () => {
    const widths = equalPaneWidths(3) // 容器 1200px，各 400px；pane1/pane2 这一对的和为 800px，
    // 未夹紧范围内的拖拽是 [320, 480]（相对各自 400px 的起点，最多能挪 ±80px）
    const next = clampDividerDrag(widths, 1, 50, 1200)
    expect(next[0]).toBeCloseTo(widths[0])
    expect(next[1] * 1200).toBeCloseTo(450)
    expect(next[2] * 1200).toBeCloseTo(350)
  })

  it('容器宽度为 0 或负数时原样返回，不产生 NaN/Infinity', () => {
    const widths = [0.5, 0.5]
    expect(clampDividerDrag(widths, 0, 100, 0)).toBe(widths)
    expect(clampDividerDrag(widths, 0, 100, -10)).toBe(widths)
  })

  it('index 越界（最后一个窗格右侧、或负数）时原样返回', () => {
    const widths = equalPaneWidths(3)
    expect(clampDividerDrag(widths, 2, 100, 1200)).toBe(widths)
    expect(clampDividerDrag(widths, -1, 100, 1200)).toBe(widths)
  })
})

describe('neighborPaneId：⌘⌥←/→ 焦点移动，边界不循环', () => {
  const ids = ['a', 'b', 'c']

  it('中间窗格向右移动到下一个', () => {
    expect(neighborPaneId(ids, 'b', 1)).toBe('c')
  })
  it('中间窗格向左移动到上一个', () => {
    expect(neighborPaneId(ids, 'b', -1)).toBe('a')
  })
  it('已在最右侧窗格时向右移动，不循环回第一个（返回 undefined）', () => {
    expect(neighborPaneId(ids, 'c', 1)).toBeUndefined()
  })
  it('已在最左侧窗格时向左移动，不循环回最后一个（返回 undefined）', () => {
    expect(neighborPaneId(ids, 'a', -1)).toBeUndefined()
  })
  it('没有窗格时返回 undefined', () => {
    expect(neighborPaneId([], 'a', 1)).toBeUndefined()
  })
  it('activePaneId 未知或缺省时落到第一个窗格', () => {
    expect(neighborPaneId(ids, undefined, 1)).toBe('a')
    expect(neighborPaneId(ids, 'not-found', -1)).toBe('a')
  })
})

describe('decidePaneFit：窄窗口降级判断（设计文档 §8），⌘D 与拖拽两个新建/移动窗格入口共用', () => {
  it('内容区本身就够宽：直接 fits，不管面板是否展开', () => {
    expect(decidePaneFit(2, 640, false, 400)).toBe('fits')
    expect(decidePaneFit(2, 640, true, 400)).toBe('fits')
  })
  it('内容区不够，但收起展开着的面板后腾出的宽度够：collapse-panel', () => {
    expect(decidePaneFit(2, 600, false, 400)).toBe('collapse-panel') // 600+400=1000 >= 640
  })
  it('内容区不够，面板已经收起（没有面板宽度可腾）：refuse', () => {
    expect(decidePaneFit(2, 600, true, 400)).toBe('refuse')
  })
  it('内容区不够，收起面板后仍然不够：refuse', () => {
    expect(decidePaneFit(2, 300, false, 200)).toBe('refuse') // 300+200=500 < 640
  })
})

describe('MAX_PANES', () => {
  it('上限为 3', () => {
    expect(MAX_PANES).toBe(3)
  })
})

describe('paneFitShortfall：装不下时具体差多少像素（拖拽过程中持续显示的提示用）', () => {
  it('差额为达到最小宽度所需与实际可用宽度之差', () => {
    expect(paneFitShortfall(2, 615)).toBe(640 - 615) // 25
    expect(paneFitShortfall(3, 924)).toBe(960 - 924) // 36
  })
  it('已经装得下时钳在 0，不产生负数', () => {
    expect(paneFitShortfall(2, 700)).toBe(0)
  })
  it('paneCount<=0 时没有意义，返回 0', () => {
    expect(paneFitShortfall(0, 100)).toBe(0)
    expect(paneFitShortfall(-1, 100)).toBe(0)
  })
})

// previewPaneDrop：本次修复（拖到空槽窗格应"填充"而不是"插入"）的核心判断，供
// TabBar.tsx/Sidebar.tsx 在 pointermove（实时预览）与 pointerup（真正执行）共用。
describe('previewPaneDrop：拖放是否会被接受，按落点语义（fill/insert）算出真正的结果窗格数', () => {
  it('fill：结果窗格数等于当前数（不变），哪怕原始测量值只够当前数量、不够 +1', () => {
    // 原始测量值 700px：够 2 个窗格（usable=675>=640）但不够 3 个（usable=664<960）——
    // fill 应该按"不变的 2"判断，装得下；如果被误当成 insert（当成 2+1=3）就会错误拒绝，
    // 这正是本次要修的设计间隙（诊断记录见 .superpowers/pane-fill-report.md）。
    const result = previewPaneDrop('fill', 2, 1, 700, true, 0)
    expect(result.resultingCount).toBe(2)
    expect(result.refused).toBe(false)
    expect(result.decision).toBe('fits')
  })

  it('insert：结果窗格数是 currentCount + draggedCount（既有行为不变）', () => {
    const result = previewPaneDrop('insert', 2, 1, 700, true, 0)
    expect(result.resultingCount).toBe(3)
    expect(result.refused).toBe(true) // 700px 不够 3 个窗格
    expect(result.refusalKind).toBe('too-narrow')
  })

  it('结果窗格数超过 MAX_PANES：拒绝，reason 是固定文案，不计算 shortfall', () => {
    const result = previewPaneDrop('insert', 3, 1, 100000, true, 0) // 宽度充裕也不行，数量硬上限优先
    expect(result.refused).toBe(true)
    expect(result.refusalKind).toBe('max-panes')
    expect(result.reason).toBe('最多支持 3 个窗格')
  })

  it('宽度不够、面板已收起：reason 携带具体差额（与 paneFitShortfall 对应同一份原始测量值 640px）', () => {
    const result = previewPaneDrop('insert', 1, 1, 640, true, 0)
    expect(result.refused).toBe(true)
    expect(result.refusalKind).toBe('too-narrow')
    expect(result.reason).toBe('窗口太窄，还差 25px')
  })

  it('宽度不够，但面板未收起、收起后就够：decision 是 collapse-panel，不算拒绝', () => {
    const result = previewPaneDrop('insert', 1, 1, 600, false, 400) // usable=575，575+400=975>=640
    expect(result.refused).toBe(false)
    expect(result.decision).toBe('collapse-panel')
  })

  it('宽度不够，面板未收起但收起后仍不够：拒绝，差额按"收起后能达到的最大可用宽度"计算', () => {
    const result = previewPaneDrop('insert', 1, 1, 300, false, 200) // usable=275，275+200=475<640
    expect(result.refused).toBe(true)
    expect(result.reason).toBe(`窗口太窄，还差 ${640 - 475}px`) // 165
  })
})
