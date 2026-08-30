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
