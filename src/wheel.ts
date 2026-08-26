// alt-screen 下把鼠标滚轮 delta 换算成要发送的方向键行数，纯函数便于单测。
// deltaMode: 0=像素 1=行 2=页（DOM WheelEvent 标准）
export function wheelDeltaToLines(
  deltaY: number,
  deltaMode: number,
  rows: number,
  cellH: number,
  multiplier: number,
  remainder: number,
): { lines: number; remainder: number } {
  const inLines =
    deltaMode === 1 ? deltaY :
    deltaMode === 2 ? deltaY * rows :
    deltaY / cellH
  const total = remainder + inLines * multiplier
  const lines = Math.trunc(total)
  return { lines, remainder: total - lines }
}
