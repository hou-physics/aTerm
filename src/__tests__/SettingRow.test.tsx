import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingRow } from '../components/settings/SettingRow'

// SettingRow：v3-2c 新增的行组件（src/components/settings/SettingRow.tsx）。这里
// 钉住"禁用态"这个后续主题页任务要用来表达"当前模式不使用这一项"的契约。
//
// R1 修复：初版让 SettingRow 自己用 capture 阶段事件拦截 control 的交互，理由是
// "jsdom 不落地 <fieldset disabled> 的级联禁用、也不做 pointer-events 的命中
// 测试"——这个前提没错，但被错误地推广成了"所以原生 disabled 属性在这里也用不
// 了"。评审实测纠正：<button disabled> + fireEvent.click 在 jsdom 里 onClick
// 调用 0 次，原生 disabled 对 click 类交互是真实生效的；而只挂 onClickCapture
// 时改派发 pointerdown，监听器仍然调用 1 次——说明当初那份"拦哪些事件"的清单
// 本身也有覆盖盲区（下一个任务的自定义下拉多半用 pointerdown/mousedown 开合）。
//
// 新契约：SettingRow 的 disabled 只管呈现（视觉置灰）与无障碍语义
// （aria-disabled），不管交互——control 到底禁不禁用，由调用方把原生 disabled
// 直接传给 control 自身负责。下面的测试相应地验证两件事：① SettingRow 自己不
// 私自拦截任何交互（呈现禁用是调用方的责任，SettingRow 不会偷偷兜底）；② 当
// 调用方按契约把原生 disabled 传给 control 时，禁用是真实生效的——用
// button.disabled 这个结构性证据，而不是"点了没反应"这种在 change 类控件上并不
// 可靠的行为断言（fireEvent.change 是直接 dispatchEvent，不经过浏览器"能不能先
// 交互到这个控件"的门槛，disabled 的 <input type=range> 用 fireEvent.change 时
// onChange 依然会被调用，这是真实浏览器与 jsdom 共有的行为，不是 bug）。
describe('SettingRow 禁用态', () => {
  it('disabled=true：整行带有 setting-row-disabled class（视觉置灰）', () => {
    const { container } = render(<SettingRow label="示例" control={<button>操作</button>} disabled />)
    expect(container.querySelector('.setting-row-disabled')).not.toBeNull()
  })

  it('disabled=false：没有 setting-row-disabled class', () => {
    const { container } = render(<SettingRow label="示例" control={<button>操作</button>} />)
    expect(container.querySelector('.setting-row-disabled')).toBeNull()
  })

  it('disabled=true：control 容器带 aria-disabled="true"；disabled=false 时没有这个属性', () => {
    const { container: disabledContainer } = render(
      <SettingRow label="示例" control={<button>操作</button>} disabled />,
    )
    const { container: enabledContainer } = render(<SettingRow label="示例" control={<button>操作</button>} />)
    expect(disabledContainer.querySelector('.setting-row-control')!.getAttribute('aria-disabled')).toBe('true')
    expect(enabledContainer.querySelector('.setting-row-control')!.getAttribute('aria-disabled')).toBeNull()
  })

  it('description 由调用方按 disabled 状态传入不同文案，SettingRow 原样渲染', () => {
    render(<SettingRow label="亮色主题" description="当前模式不使用这一项" control={<button>操作</button>} disabled />)
    expect(screen.queryByText('当前模式不使用这一项')).not.toBeNull()
  })

  // 契约验证 ①：SettingRow 自己不拦截任何交互。control 没有原生 disabled 时，
  // 即便整行标了 disabled=true，点击依然正常触发——证明"禁用控件"不是 SettingRow
  // 兜底做的，而是完全交给调用方。这条测试同时是一道回归闸门：谁要是往
  // SettingRow 里重新加回 capture 拦截，这条测试会先红（见变异验证）。
  it('disabled=true 但 control 自己没有原生 disabled：SettingRow 不会偷偷拦截，点击仍正常触发', () => {
    const onClick = vi.fn()
    render(<SettingRow label="示例" control={<button onClick={onClick}>操作</button>} disabled />)
    fireEvent.click(screen.getByRole('button', { name: '操作' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  // 契约验证 ②：调用方按契约把原生 disabled 传给 control 自身时，禁用是真实、
  // 可验证生效的——button.disabled 这个结构性证据 + 点击确实不触发 onClick
  // （对 click 类控件，原生 disabled 在 jsdom 里对 fireEvent.click 是真实生效的，
  // 已实测确认，不是靠 SettingRow 帮它拦）。
  it('disabled=true 且 control 自身带原生 disabled：control 结构上真的是 disabled，点击也不触发 onClick', () => {
    const onClick = vi.fn()
    render(
      <SettingRow label="示例" control={<button disabled onClick={onClick}>操作</button>} disabled />,
    )
    const btn = screen.getByRole('button', { name: '操作' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })
})
