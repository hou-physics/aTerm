// 窗格插槽几何：把插槽（TabPanes.tsx 里 `.pane-body[data-pane-slot]`——只承载窗格的
// 终端区域，不含标题栏/分隔条）在视口坐标系下的矩形，换算成相对共同容器（App.tsx 的
// `.content`，position:relative，见 App.css）的 top/left/width/height——
// TerminalLayer.tsx 据此把绝对定位的终端包裹层精确覆盖在插槽正上方。
//
// 纯函数，不摸 DOM：入参/出参都是普通矩形对象，方便在 jsdom（不做真实布局，
// getBoundingClientRect() 恒返回全 0）之外单独验证这套坐标换算本身；真实运行时的输入
// 来自插槽/容器各自调用 getBoundingClientRect() 的返回值（原生 DOMRect 结构上兼容
// 这里的 Rect 类型，不需要额外转换）。

export type Rect = { top: number; left: number; width: number; height: number }
export type WrapperStyle = { top: number; left: number; width: number; height: number }

// 两个矩形须处于同一坐标系（视口坐标）。容器是插槽的 position:relative 祖先，做差即得
// 到"绝对定位子元素相对该祖先"的坐标——应用不使用 CSS transform:scale，1px 视口坐标差
// 恒等于 1px 定位坐标差，不需要额外的缩放系数。
export function slotToWrapperStyle(slotRect: Rect, containerRect: Rect): WrapperStyle {
  return {
    top: slotRect.top - containerRect.top,
    left: slotRect.left - containerRect.left,
    width: slotRect.width,
    height: slotRect.height,
  }
}

// 批量版本：一次性把"当前激活标签、每个持有 PTY 的窗格"各自插槽的矩形换算成包裹层
// 样式，供 TerminalLayer 在一帧内合并写入 state（见该文件 recompute()）。
export function computeWrapperStyles(slotRects: Map<string, Rect>, containerRect: Rect): Map<string, WrapperStyle> {
  const out = new Map<string, WrapperStyle>()
  for (const [paneId, rect] of slotRects) out.set(paneId, slotToWrapperStyle(rect, containerRect))
  return out
}
