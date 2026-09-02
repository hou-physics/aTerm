import { useLayout, WHEEL_MULTIPLIER_MAX, WHEEL_MULTIPLIER_MIN } from '../../store/layout'
import { SettingCard } from './SettingCard'
import { SettingRow } from './SettingRow'

// 终端分区：目前只有一项——鼠标滚轮在 Claude TUI 接管滚轮上报期间的放大倍数
// （store/layout.ts 的 wheelMultiplier）。min/max 引用 store 导出的
// WHEEL_MULTIPLIER_MIN/MAX，不在这里另写字面量；clamp 与持久化都在
// setWheelMultiplier 里，onChange 直接把新值转发过去，不重复实现。
//
// v3-2c 只改呈现：一张标题「滚动」的卡片、一行，label/滑块/数值全部原样保留，
// 只是外层换成 SettingCard/SettingRow，逻辑一行没动。
const DESCRIPTION = 'Claude TUI 自己接管鼠标上报时，每个真实滚轮事件的放大倍数。'

export function TerminalSection() {
  const wheelMultiplier = useLayout((s) => s.wheelMultiplier)
  const setWheelMultiplier = useLayout((s) => s.setWheelMultiplier)

  return (
    <div className="terminal-section">
      <SettingCard title="滚动">
        <SettingRow
          label="滚动速度"
          description={DESCRIPTION}
          control={
            <>
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
            </>
          }
        />
      </SettingCard>
    </div>
  )
}
