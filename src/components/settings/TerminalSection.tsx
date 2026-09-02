import { useLayout, WHEEL_MULTIPLIER_MAX, WHEEL_MULTIPLIER_MIN } from '../../store/layout'

// 终端分区：目前只有一项——鼠标滚轮在 Claude TUI 接管滚轮上报期间的放大倍数
// （store/layout.ts 的 wheelMultiplier）。min/max 引用 store 导出的
// WHEEL_MULTIPLIER_MIN/MAX，不在这里另写字面量；clamp 与持久化都在
// setWheelMultiplier 里，onChange 直接把新值转发过去，不重复实现。
export function TerminalSection() {
  const wheelMultiplier = useLayout((s) => s.wheelMultiplier)
  const setWheelMultiplier = useLayout((s) => s.setWheelMultiplier)

  return (
    <div className="terminal-section">
      <div className="terminal-section-row">
        <span className="terminal-section-label">滚动速度</span>
        <input
          type="range"
          className="terminal-section-slider"
          aria-label="滚动速度"
          min={WHEEL_MULTIPLIER_MIN}
          max={WHEEL_MULTIPLIER_MAX}
          step={0.5}
          value={wheelMultiplier}
          onChange={(e) => setWheelMultiplier(Number(e.target.value))}
        />
        <span className="terminal-section-value">{wheelMultiplier}×</span>
      </div>
    </div>
  )
}
