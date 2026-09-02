import type { ReactNode, SyntheticEvent } from 'react'

export type SettingRowProps = {
  /** 设置名，行左侧的主文字。 */
  label: ReactNode
  /** 设置名下方一行灰色说明文字，可选。disabled 态下想换一句话（比如"当前模式
   *  不使用这一项"），调用方在这里直接传入不同的文案即可——SettingRow 本身
   *  不做任何文案切换，只负责渲染传进来的内容。 */
  description?: ReactNode
  /** 行右侧的控件：开关 / 下拉 / 按钮 / 数值展示……任意 ReactNode。 */
  control: ReactNode
  /** 整行禁用态：视觉置灰 + control 不可交互（见下方实现说明），用于"当前模式
   *  不使用这一项"这类场景（主题页三行会用到）。默认 false。 */
  disabled?: boolean
}

// jsdom 既不实现 <fieldset disabled> 对子孙表单控件的级联禁用（button.disabled/
// input.disabled 在其中始终是 false，实测见 report），也不做 pointer-events 的
// 真实命中测试（CSS pointer-events:none 拦不住 fireEvent 直接派发到内部节点的
// 事件）——这两种"看起来能禁用"的写法在这个项目的测试环境里都测不出效果，会
// 变成一条量不出行为差异的死断言。
//
// 所以这里换一种不依赖 control 内部实现、也不依赖 CSS 命中测试的做法：在包住
// control 的容器上，用 capture 阶段拦截 click/change/input/keydown 四类事件，
// disabled 时统一 preventDefault + stopPropagation。capture 阶段发生在事件到达
// target（也就是 control 内部真正的 <button>/<input> 等节点）触发它自己的
// onClick/onChange 之前，React 的合成事件系统按 stopPropagation() 中止同一路径
// 上后续监听器的调用，所以无论传进来的 control 是什么实现，点了/改了都不会有
// 任何可观察效果——这一点直接用 fireEvent.click/fireEvent.change 就能断言到。
// 四类事件覆盖了本仓库目前所有控件的交互面：按钮用 click，滑块/下拉用 change，
// 滑块拖动过程用 input，键盘激活（Enter/Space 触发按钮）用 keydown。
function blockEvent(e: SyntheticEvent): void {
  e.preventDefault()
  e.stopPropagation()
}

/**
 * 设置卡片里的一行：左边 label + 可选 description，右边 control。与 SettingCard
 * 配合使用——SettingCard 的直接子节点通常就是若干个 SettingRow，行间分隔线由
 * SettingCard 负责画，SettingRow 自己不画。
 */
export function SettingRow({ label, description, control, disabled = false }: SettingRowProps) {
  const capture = disabled ? blockEvent : undefined
  return (
    <div className={disabled ? 'setting-row setting-row-disabled' : 'setting-row'}>
      <div className="setting-row-text">
        <div className="setting-row-label">{label}</div>
        {description != null && <div className="setting-row-description">{description}</div>}
      </div>
      <div
        className="setting-row-control"
        aria-disabled={disabled || undefined}
        onClickCapture={capture}
        onChangeCapture={capture}
        onInputCapture={capture}
        onKeyDownCapture={capture}
      >
        {control}
      </div>
    </div>
  )
}
