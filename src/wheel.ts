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

// 鼠标上报模式（如 Claude TUI 的 All-Motion Mouse Tracking）下，xterm 会把滚轮自行编码发给应用，
// 我们不知道当前生效的是哪种协议（SGR 1006 / urxvt / X10），所以不手工拼接转义序列，
// 而是在收到真实滚轮事件的同一目标上按余量累加补发若干个合成 WheelEvent（非整数倍率下不是每次都补发同样个数，长期均值收敛到 multiplier，见下方 carry 的注释），交给 xterm 按当前协议编码。
// 返回的函数自带重入守卫：xterm 的监听器会对每个合成事件也调用一次该函数（因为事件会冒泡回同一目标），
// 若不加守卫会无限递归；守卫确保一次真实事件最终只产生 (multiplier - 1) 次真正的补发。
// view 转发原始事件的 ev.view（浏览器派发的可信事件必带真实 window）而非硬编码全局 window——
// xterm 用 view.devicePixelRatio 换算鼠标坐标，转发原值在 Retina 下才准确，也不依赖测试/嵌入环境里的全局绑定。
export function createWheelAmplifier(multiplier: number): (target: EventTarget, ev: WheelEvent) => void {
  let synthesizing = false
  // 未满一个事件的补发余量，跨事件累加。合成事件只能是整数个，而 1.5 这样的倍率
  // 要求"平均每次补发 0.5 个"——靠余量累积实现：攒够 1 才真的补发一个，长期均值
  // 收敛到 multiplier。与 wheelDeltaToLines 的 remainder 是同一手法。
  // 整数倍率下 carry 恒为 0，行为与改动前逐次相同。
  let carry = 0
  return (target, ev) => {
    if (synthesizing) return
    carry += multiplier - 1
    const extra = Math.floor(carry)
    carry -= extra
    if (extra <= 0) return
    synthesizing = true
    try {
      for (let i = 0; i < extra; i++) {
        target.dispatchEvent(new WheelEvent('wheel', {
          deltaX: ev.deltaX, deltaY: ev.deltaY, deltaZ: ev.deltaZ, deltaMode: ev.deltaMode,
          clientX: ev.clientX, clientY: ev.clientY,
          bubbles: true, cancelable: true, view: ev.view,
        }))
      }
    } finally {
      synthesizing = false
    }
  }
}
