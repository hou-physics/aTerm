// 标签拖出窗口边界的判定（设计文档 §4.1：docs/superpowers/specs/
// 2026-09-02-aterm-v3-3-multiwindow-design.md）。纯函数，不摸 DOM/store，供
// src/components/TabBar.tsx 在 pointermove/pointerup 时判定"此刻是否已经拖出窗口"，
// 也便于脱离真实拖拽单独做单元测试（同 paneDrop.ts 的既有做法：几何/判定逻辑与
// DOM 胶水分开，前者纯粹、可测，后者只做"从真实 DOM 取数"这一步）。
//
// 现有拖拽已用 setPointerCapture——macOS 会把 mouse-dragged 事件继续投递给最初接收
// mouse-down 的窗口，指针移出窗口后 pointermove/pointerup 仍会到达，clientX/clientY
// 因此可能为负值或超出窗口尺寸（设计文档 §2 "已核实的技术前提"已实测核实过这一点，
// 这里直接依赖它，不重新验证）。windowRect 因此只需要 width/height——它描述的是"当前
// 窗口自己的坐标系"，原点恒为 (0, 0)（clientX/clientY 本就是相对当前窗口视口的坐标），
// 不需要 top/left。
export type TearOutPoint = { x: number; y: number }
export type TearOutWindowRect = { width: number; height: number }

// 只剩一个（非主页）标签时永不拖出：那等于把窗口整体搬到新窗口，没有意义（设计文档
// §4.1 明确的边界情况——"若被拖的标签是该窗口内唯一的标签……此时不触发拖出，退回既有
// 行为"）。tabCount 的具体口径（是否把恒定钉住、不可拖动的主页标签算进去）由调用方
// 决定，这个纯函数只认"<=1 就不拖出"这一条规则本身，不关心 tabCount 是怎么数出来的。
//
// 边界取闭区间——判断"窗口内"用 >=0 且 <=width/height，不是 paneDrop.ts 里
// resolveDropTarget/pointInRect 那套左闭右开约定。那套约定的用途是让"多个互相紧邻的
// 矩形"边界像素只命中其中一个、不会同时命中相邻的下一个；这里全局只有一个矩形（整个
// 窗口），不存在相邻矩形互相抢边界像素的问题，窗口边缘的像素本身仍然是"在窗口内"这件
// 事没有理由改变，边界因此应当算作"未拖出"（brief 的测试用例明确要求
// {x:width,y:height} 这个右下角边界点判定为"不拖出"）。
export function shouldTearOut(point: TearOutPoint, windowRect: TearOutWindowRect, tabCount: number): boolean {
  if (tabCount <= 1) return false
  const insideX = point.x >= 0 && point.x <= windowRect.width
  const insideY = point.y >= 0 && point.y <= windowRect.height
  return !(insideX && insideY)
}
