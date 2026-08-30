import { describe, expect, it } from 'vitest'
import { formatDroppedPaths, paneAtPoint, shellQuote, toLogicalPoint } from '../fileDrop'

describe('shellQuote', () => {
  it('普通路径被单引号包裹', () => {
    expect(shellQuote('/tmp/a.txt')).toBe("'/tmp/a.txt'")
  })
  it('含空格的路径不会被 shell 拆成两个参数', () => {
    expect(shellQuote('/tmp/my file.txt')).toBe("'/tmp/my file.txt'")
  })
  it('含单引号的路径被正确断开重接——这是唯一能逃逸出引号的字符', () => {
    // it's.txt -> 'it'\''s.txt'
    expect(shellQuote("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'")
  })
  it('中文路径原样保留在引号内', () => {
    expect(shellQuote('/tmp/项目/说明.md')).toBe("'/tmp/项目/说明.md'")
  })
  it('含 $ 与反引号的路径不会被展开——单引号内一切都是字面量', () => {
    expect(shellQuote('/tmp/$HOME`whoami`.txt')).toBe("'/tmp/$HOME`whoami`.txt'")
  })
})

describe('formatDroppedPaths', () => {
  it('多个路径以空格分隔，并以一个空格结尾便于继续打字', () => {
    expect(formatDroppedPaths(['/a', '/b'])).toBe("'/a' '/b' ")
  })
  it('空数组返回空串，调用方据此不写入任何内容', () => {
    expect(formatDroppedPaths([])).toBe('')
  })
})

describe('toLogicalPoint', () => {
  it('Retina 上把物理像素换算成 CSS 像素', () => {
    // 这是本模块唯一会"在 Retina 上错、在普通屏上对"的失效模式——必须钉住。
    expect(toLogicalPoint({ x: 800, y: 600 }, 2)).toEqual({ x: 400, y: 300 })
  })
  it('dpr 为 1 时原样返回', () => {
    expect(toLogicalPoint({ x: 800, y: 600 }, 1)).toEqual({ x: 800, y: 600 })
  })
})

describe('paneAtPoint', () => {
  const rects = [
    { paneId: 'p1', rect: { top: 100, left: 0, width: 200, height: 400 } },
    { paneId: 'p2', rect: { top: 100, left: 200, width: 200, height: 400 } },
  ]
  it('落在第二个窗格里就返回它，而不是当前聚焦的那个', () => {
    expect(paneAtPoint(rects, 300, 200)).toBe('p2')
  })
  it('落在第一个窗格里', () => {
    expect(paneAtPoint(rects, 50, 200)).toBe('p1')
  })
  it('落在窗格区之外（如标签栏）返回 null，调用方据此整个忽略', () => {
    expect(paneAtPoint(rects, 300, 50)).toBeNull()
  })
  it('边界：左上角含、右下角不含，相邻窗格不会同时命中', () => {
    expect(paneAtPoint(rects, 200, 100)).toBe('p2')
    expect(paneAtPoint(rects, 400, 200)).toBeNull()
  })
  it('没有任何窗格时返回 null', () => {
    expect(paneAtPoint([], 10, 10)).toBeNull()
  })
})
