import type { ReactNode } from 'react'

export type SettingRowProps = {
  /** 设置名，行左侧的主文字。 */
  label: ReactNode
  /** 设置名下方一行灰色说明文字，可选。disabled 态下想换一句话（比如"当前模式
   *  不使用这一项"），调用方在这里直接传入不同的文案即可——SettingRow 本身
   *  不做任何文案切换，只负责渲染传进来的内容。 */
  description?: ReactNode
  /** 行右侧的控件：开关 / 下拉 / 按钮 / 数值展示……任意 ReactNode。 */
  control: ReactNode
  /**
   * 整行禁用态。**契约：disabled 只管呈现与无障碍语义，不管交互**——它做的事情
   * 只有两件：① 整行视觉置灰（`setting-row-disabled` class）；② 给包住 control
   * 的容器打上 `aria-disabled`。control 本身是否真的不可交互，是调用方的责任：
   * 调用方需要把 `disabled` 同时传给 control 自己（原生 `<button disabled>`/
   * `<select disabled>`/`<input disabled>` 等）。SettingRow 不会替 control 做任何
   * 拦截。
   *
   * 例：
   *   <SettingRow
   *     label="亮色主题"
   *     control={<select disabled={mode !== 'dual'}>...</select>}
   *     disabled={mode !== 'dual'}
   *   />
   *
   * 默认 false。
   */
  disabled?: boolean
}

// R1 修复：v3-2c 初版在这里用 capture 阶段事件监听（click/change/input/keydown）
// 拦截 control 内部的交互，理由是"jsdom 不落地 <fieldset disabled> 的级联禁用、
// 也不做 pointer-events 的命中测试"——这个前提本身没错，但被错误地推广成了
// "所以原生 disabled 属性在这里也用不了"，这一步推广不成立，评审实测纠正：
//
//   - <button disabled> + fireEvent.click → onClick 调用 0 次（原生 disabled
//     对 click 类交互在 jsdom 里是真实生效的，不需要额外拦截）。
//   - <input type="range" disabled> + fireEvent.change → onChange 仍然调用
//     1 次（fireEvent.change 是直接对目标节点 dispatchEvent，不经过浏览器的
//     "用户能不能先聚焦/拖动这个被禁用的控件"这一层真实交互门槛，所以哪怕
//     control 自己写了原生 disabled，程序化派发的 change 事件依然会到达监听器
//     ——这是 jsdom 与真实浏览器共有的行为，不是 jsdom 的缺陷：disabled 从来
//     约束的是"用户交互与表单提交"，不是"JS 能不能对节点 dispatchEvent"）。
//   - 只挂 onClickCapture 时，改派发 pointerdown → 监听器仍然调用 1 次，说明
//     当初那份拦截列表本身也有覆盖盲区（漏了 pointerdown/mousedown，下一个
//     任务的自定义下拉多半就用这类事件开合），越补越不完整。
//
// 综合结论：与其在 SettingRow 里维护一份"要拦哪些事件"的清单（永远可能漏、
// 且给出的是假的安全感——控件仍然能获得焦点、屏幕阅读器仍然会读成"可用"），
// 不如把"控件到底禁不禁用"这件事交还给控件自己的原生语义：真正的禁用来自
// 调用方直接把 disabled 传给 control 自身（可聚焦性、键盘不可达、表单语义、
// 读屏播报全部正确），SettingRow 这一层只负责它自己能负责、也应该负责的两件
// 事——视觉置灰 + aria-disabled。

/**
 * 设置卡片里的一行：左边 label + 可选 description，右边 control。与 SettingCard
 * 配合使用——SettingCard 的直接子节点通常就是若干个 SettingRow，行间分隔线由
 * SettingCard 负责画，SettingRow 自己不画。
 */
export function SettingRow({ label, description, control, disabled = false }: SettingRowProps) {
  return (
    <div className={disabled ? 'setting-row setting-row-disabled' : 'setting-row'}>
      <div className="setting-row-text">
        <div className="setting-row-label">{label}</div>
        {description != null && <div className="setting-row-description">{description}</div>}
      </div>
      <div className="setting-row-control" aria-disabled={disabled || undefined}>
        {control}
      </div>
    </div>
  )
}
