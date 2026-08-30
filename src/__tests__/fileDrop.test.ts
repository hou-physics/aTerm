import { describe, expect, it } from 'vitest'
import { formatDroppedPaths, paneAtPoint, resolveDropWrite, shellQuote, toLogicalPoint, writableDropPaneId } from '../fileDrop'

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

describe('writableDropPaneId', () => {
  const panes = [{ id: 'p1', ptyId: 'pty-1' }, { id: 'p2' }] // p2 还停在 PanePicker，没有 ptyId

  it('候选窗格有 ptyId：原样放行——若这里返回 null，说明把可写窗格误判成了不可写', () => {
    expect(writableDropPaneId(panes, 'p1')).toBe('p1')
  })
  it('候选窗格没有 ptyId（还在 PanePicker）：返回 null——若这里返回 "p2"，说明漏掉了 ptyId 检查，回归本次要修的缺陷', () => {
    expect(writableDropPaneId(panes, 'p2')).toBeNull()
  })
  it('候选 id 是 null（落在窗格区之外）：原样返回 null——若这里抛错，说明没有先做 null 早退', () => {
    expect(writableDropPaneId(panes, null)).toBeNull()
  })
  it('候选 id 在 panes 里查不到：返回 null——若这里返回该 id，说明 find() 没查、或者对 undefined 取 .ptyId 时没做可选链', () => {
    expect(writableDropPaneId(panes, 'ghost')).toBeNull()
  })
})

describe('resolveDropWrite', () => {
  const panes = [{ id: 'p1', ptyId: 'pty-1' }, { id: 'p2' }]

  it('窗格可写、paths 非空：返回对应 ptyId 与 formatDroppedPaths 格式化后的文本', () => {
    expect(resolveDropWrite(panes, 'p1', ['/a', '/b'])).toEqual({ ptyId: 'pty-1', text: "'/a' '/b' " })
  })
  it('窗格没有 ptyId：返回 null，即便 paths 非空——若这里写入了，就是本次要修的"高亮但静默丢弃"缺陷复发', () => {
    expect(resolveDropWrite(panes, 'p2', ['/a'])).toBeNull()
  })
  it('paneId 在 panes 里查不到：返回 null——若这里抛错或返回非 null，说明没有复用 writableDropPaneId 的查找防护', () => {
    expect(resolveDropWrite(panes, 'ghost', ['/a'])).toBeNull()
  })
  it('paneId 为 null（落在窗格区之外）：返回 null', () => {
    expect(resolveDropWrite(panes, null, ['/a'])).toBeNull()
  })
  it('paths 为空数组：即便窗格可写也返回 null，调用方据此不写入任何内容——若这里返回非 null，说明漏掉了空文本检查', () => {
    expect(resolveDropWrite(panes, 'p1', [])).toBeNull()
  })
})
