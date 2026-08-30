// 把文件拖进终端（spec §5）用到的纯函数。DOM/Tauri 事件的接线在 App.tsx，
// 这里只放可单测的换算与字符串处理。
import type { PaneSlotRect } from './paneDrop'

/** 单引号包裹；内部的 ' 用 '\'' 断开重接。这是 POSIX shell 里唯一无需枚举元字符的
 *  安全写法——单引号内除 ' 本身之外一切字符都是字面量，$ / 反引号 / 空格 / 换行全部
 *  失去特殊含义，因此不需要维护一张"危险字符"清单（那种清单迟早会漏）。 */
export function shellQuote(path: string): string {
  return `'${path.split("'").join("'\\''")}'`
}

/** 多个文件以空格分隔；末尾补一个空格，便于用户接着打字。空数组返回空串。 */
export function formatDroppedPaths(paths: string[]): string {
  if (paths.length === 0) return ''
  return paths.map(shellQuote).join(' ') + ' '
}

/** Tauri 的拖放坐标是 PhysicalPosition（物理像素），而 getBoundingClientRect() 是
 *  CSS 像素。Retina 上 devicePixelRatio = 2，不换算会整体偏一倍——而在外接的非
 *  Retina 显示器上又恰好正确，是最难查的那类缺陷。 */
export function toLogicalPoint(p: { x: number; y: number }, dpr: number): { x: number; y: number } {
  return { x: p.x / dpr, y: p.y / dpr }
}

/** 命中测试：左上闭、右下开，保证相邻窗格的公共边只归属右/下那个，不会同时命中。 */
export function paneAtPoint(rects: PaneSlotRect[], x: number, y: number): string | null {
  for (const { paneId, rect } of rects) {
    if (x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height) {
      return paneId
    }
  }
  return null
}

/** paneAtPoint 只做几何命中测试，不知道窗格是否已经选定会话（有 ptyId）——还停在
 *  PanePicker 的窗格没有 ptyId，drop 到它头上什么都写不进去。App.tsx 的悬停高亮
 *  （dropPaneId）与真正的 drop 写入都要调用这一个函数来过滤 paneAtPoint 的候选结果，
 *  这样"高亮"与"可写"由同一条规则决定，不会分叉成两条各自维护的判断（此前的缺陷：
 *  悬停在选择器窗格上会高亮，真正放下去却被"没有 ptyId 就不写"那条判断静默丢弃，
 *  用户以为能放、实际什么都没发生）。candidatePaneId 为 null，或者在 panes 里根本
 *  查不到，同样返回 null。 */
export function writableDropPaneId(
  panes: { id: string; ptyId?: string }[],
  candidatePaneId: string | null,
): string | null {
  if (!candidatePaneId) return null
  const pane = panes.find((p) => p.id === candidatePaneId)
  return pane?.ptyId ? candidatePaneId : null
}

/** drop 事件真正落地时的写入决策，取代此前内联在 App.tsx 事件回调里、只靠 tsc 兜底、
 *  没有任何测试覆盖的那段"按 paneId 查 ptyId、判断该不该写"逻辑。两个必要条件缺一
 *  不可：窗格必须可写（复用 writableDropPaneId，与悬停高亮同一条规则）；
 *  formatDroppedPaths 产出的文本必须非空（paths 为空数组时它返回 ''，代表不该写入
 *  任何内容）。都满足才返回 { ptyId, text }，否则返回 null。 */
export function resolveDropWrite(
  panes: { id: string; ptyId?: string }[],
  paneId: string | null,
  paths: string[],
): { ptyId: string; text: string } | null {
  const target = writableDropPaneId(panes, paneId)
  if (!target) return null
  const text = formatDroppedPaths(paths)
  if (text === '') return null
  // 非空断言安全：target 只可能来自 writableDropPaneId 的返回值，它已经确认过
  // 对应窗格存在且 ptyId 非空。
  const ptyId = panes.find((p) => p.id === target)!.ptyId!
  return { ptyId, text }
}
