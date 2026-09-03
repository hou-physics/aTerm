import { describe, expect, it } from 'vitest'
import { isPointerOutsideWindow, shouldTearOut } from '../tabTearOut'

const RECT = { width: 1200, height: 780 }

describe('shouldTearOut', () => {
  it('落点在窗口内：不拖出', () => {
    expect(shouldTearOut({ x: 600, y: 400 }, RECT, 3)).toBe(false)
  })
  // 出界距离刻意取得远大于余量（见下面那个 describe）：这几条问的是"出了窗口算拖出"
  // 这条主规则本身，不该同时受余量取值的影响。
  it('落点在窗口左侧之外：拖出', () => {
    expect(shouldTearOut({ x: -300, y: 400 }, RECT, 3)).toBe(true)
  })
  it('落点在窗口下方之外：拖出', () => {
    expect(shouldTearOut({ x: 600, y: 900 }, RECT, 3)).toBe(true)
  })
  it('只剩一个标签时永不拖出（等于把窗口整体搬走，没有意义）', () => {
    // x 同样取到余量之外：用 -30 那种"本来就在余量内"的坐标，这条断言会因为余量而恒真，
    // 把 tabCount 那道闸门整个删掉也照样绿。
    expect(shouldTearOut({ x: -300, y: 400 }, RECT, 1)).toBe(false)
  })
  it('边界上算窗口内', () => {
    expect(shouldTearOut({ x: 0, y: 0 }, RECT, 3)).toBe(false)
    expect(shouldTearOut({ x: 1200, y: 780 }, RECT, 3)).toBe(false)
  })
})

// 出界余量（终审 I4）。没有它的话，横向拖动标签**排序**时向上多晃 20 像素就落进原生
// 标题栏（对 webview 就是 clientY < 0）、命中拖出判定，松手弹出一个新窗口——而设计文档
// §3 不做"拖回已存在的窗口"，这次误触没有任何撤销手段。
//
// 四个方向各两条：刚出界、但还在余量之内 → 不拖出；再多一个像素、超过余量 → 拖出。
// 两侧刻意贴着余量取值（40 / 41）而不是"20 与 80"这种宽松的一对：后者只能说明余量落在
// [20, 80) 里的某处，把 40 改成 25 照样全绿。这里的取值是不可逆操作的触发门槛，值本身
// 就该被钉住——真要调整它是一次需要连同这些用例一起改的、明摆着的决定。
//
// 坐标里的字面量不许换成从被测模块导入的那个常量：那样"余量内不拖出"会退化成恒真
// （余量改成 0 时，-0 仍然判定为窗口内），正是本仓库反复栽过的那种测试。
describe('shouldTearOut — 出界余量（横向排序时手抖不该弹出新窗口）', () => {
  it('向上出界 20px（正落在原生标题栏里，终审给出的真实误触场景）：不拖出', () => {
    expect(shouldTearOut({ x: 600, y: -20 }, RECT, 3)).toBe(false)
  })

  it('向上刚好出界到余量边界：不拖出', () => {
    expect(shouldTearOut({ x: 600, y: -40 }, RECT, 3)).toBe(false)
  })
  it('向上超过余量一个像素：拖出', () => {
    expect(shouldTearOut({ x: 600, y: -41 }, RECT, 3)).toBe(true)
  })

  it('向下刚好出界到余量边界：不拖出', () => {
    expect(shouldTearOut({ x: 600, y: 820 }, RECT, 3)).toBe(false)
  })
  it('向下超过余量一个像素：拖出', () => {
    expect(shouldTearOut({ x: 600, y: 821 }, RECT, 3)).toBe(true)
  })

  it('向左刚好出界到余量边界：不拖出', () => {
    expect(shouldTearOut({ x: -40, y: 400 }, RECT, 3)).toBe(false)
  })
  it('向左超过余量一个像素：拖出', () => {
    expect(shouldTearOut({ x: -41, y: 400 }, RECT, 3)).toBe(true)
  })

  it('向右刚好出界到余量边界：不拖出', () => {
    expect(shouldTearOut({ x: 1240, y: 400 }, RECT, 3)).toBe(false)
  })
  it('向右超过余量一个像素：拖出', () => {
    expect(shouldTearOut({ x: 1241, y: 400 }, RECT, 3)).toBe(true)
  })
})

// V3.4 §5.2：松手时的四条路里，`tabCount <= 1` 那道守卫**只拦第 4 路**（建新窗口），
// 40px 出界余量则四条路共用。isPointerOutsideWindow 就是"共用的那一半"被摘出来的结果。
describe('isPointerOutsideWindow — 出界判定里不含 tabCount 守卫的那一半', () => {
  it('窗口内：不算出界', () => {
    expect(isPointerOutsideWindow({ x: 600, y: 400 }, RECT)).toBe(false)
  })

  // 支点用例：同一个落点，只剩一个标签时 shouldTearOut 说"不拖出"（第 4 路被守卫拦下），
  // 而出界判定仍然为真——交接那两路因此照旧走得下去。把 term-* 窗口里最后一个标签拖到
  // 别的窗口正是 V3.4 的核心用例，被守卫拦下等于这个功能对空壳窗口完全不可用。
  it('只剩一个标签：shouldTearOut 为 false，但出界判定仍为 true（守卫不属于这一半）', () => {
    expect(shouldTearOut({ x: -300, y: 400 }, RECT, 1)).toBe(false)
    expect(isPointerOutsideWindow({ x: -300, y: 400 }, RECT)).toBe(true)
  })

  // 另一半：余量确实是**同一个**，不是两处各写一份、将来各自漂移。坐标沿用上面那组的
  // 40 / 41 这一对，值本身同样被钉住。
  it('余量与 shouldTearOut 共用同一个值：-40 不算出界，-41 算', () => {
    expect(isPointerOutsideWindow({ x: 600, y: -40 }, RECT)).toBe(false)
    expect(isPointerOutsideWindow({ x: 600, y: -41 }, RECT)).toBe(true)
  })
})
