// 展开/收起对话面板时，窗口自身应该怎么挪、怎么变宽的纯函数集合。用户反馈：面板展开时
// 终端区被挤窄——.main 是 flex:1、.conv-panel-dock 是 flex:none，面板一展开就把 .main
// 的可用宽度吃掉一块，视觉上像"面板向左展开"。真正要的是"窗口自己向右变宽，终端区宽度
// 不变"；收起时窗口变窄回去。这里只放可单测的坐标/宽度换算，不碰 DOM/Tauri，接线部分在
// store/layout.ts（与 src/fileDrop.ts、src/paneLayout.ts 同一惯例：纯函数与副作用分开，
// 前者才好在 jsdom 里独立验证这套数学关系）。
//
// 全部使用物理像素（与 Tauri 的 outerPosition/outerSize/Monitor.workArea 同一单位）。
// 调用方（store/layout.ts）负责把 CSS 像素的 panelWidth 换算成物理像素再传进来——这里
// 不做任何换算，也不知道 devicePixelRatio 是多少。

export type WindowBounds = { x: number; width: number }

// aTerm 窗口的最小宽度（src-tauri/tauri.conf.json 的 windows[0].minWidth，CSS/逻辑像素）。
// planPanelCollapse 的 minWidth 参数按这个值换算成物理像素传入，防止连续收起把窗口收缩到
// 比应用自身声明的最小尺寸还窄。两处数字如有一处改动，必须同步改另一处，否则这份下限保证
// 会悄悄失效（与 paneLayout.ts 顶部那组开销常量同一类风险）。
export const WINDOW_MIN_WIDTH_CSS = 800

/** 展开面板：先尽量向右展开（只变宽、不挪位置）；右边空间不够就把窗口向左挪，让新宽度
 *  仍完整落在工作区内；连工作区整体都放不下时，铺满工作区——剩下装不下的差额交给既有的
 *  flex 布局去挤压终端区，这是没有更多物理空间时唯一的退路，不是本函数的常规路径。
 *
 *  三条分支依次判断：
 *    1) target 比整个工作区还宽 → 铺满工作区（{ x: workArea.x, width: workArea.width }）；
 *    2) 否则，右边界超出工作区右边界 → 向左挪到刚好贴住工作区右边界；
 *    3) 否则 → 只变宽，x 不变。 */
export function planPanelExpand(
  win: WindowBounds,
  workArea: WindowBounds,
  delta: number,
): WindowBounds {
  const target = win.width + delta
  if (target > workArea.width) {
    return { x: workArea.x, width: workArea.width }
  }
  if (win.x + target > workArea.x + workArea.width) {
    return { x: workArea.x + workArea.width - target, width: target }
  }
  return { x: win.x, width: target }
}

/** 收起面板：只缩宽度，绝不移动窗口的 x。如果像 planPanelExpand 那样反向挪位置（收起时
 *  往右移回去），"展开时窗口左移、收起时窗口右移"这套来回位移在展开分支命中过"向左挪"
 *  的那次之后，只要中途 panelWidth 变过、或者窗口在展开状态下被用户手动拖动过，收起时的
 *  "移回去"就对不上当初"移过去"的量，多次开合会让窗口一路向左/向右漂移。只缩宽度、原地
 *  不动，从根源上避免这类漂移。宽度钳制到不低于 minWidth（调用方传入 aTerm 窗口的最小
 *  宽度，物理像素），避免收起把窗口挤压到不合理的宽度。 */
export function planPanelCollapse(
  win: WindowBounds,
  delta: number,
  minWidth: number,
): WindowBounds {
  return { x: win.x, width: Math.max(minWidth, win.width - delta) }
}
