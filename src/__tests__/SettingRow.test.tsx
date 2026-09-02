import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingRow } from '../components/settings/SettingRow'

// SettingRow：v3-2c 新增的行组件（src/components/settings/SettingRow.tsx）。这里专门
// 钉住"禁用态"这个后续主题页任务要用来表达"当前模式不使用这一项"的行为——
// disabled=true 时 control 必须真的不可交互，不能只是视觉上置灰。
//
// jsdom 不实现 <fieldset disabled> 对子孙表单控件的级联禁用（button.disabled 在其中
// 恒为 false），也不做 pointer-events 的真实命中测试（CSS pointer-events:none 拦不住
// fireEvent 直接派发到内部节点），这两种"看起来能禁用"的写法在这个项目的测试环境里
// 都测不出行为差异——SettingRow.tsx 因此改用 capture 阶段事件拦截，下面用真实的
// fireEvent.click/fireEvent.change 验证它确实生效，不是只测 CSS class。
describe('SettingRow 禁用态', () => {
  it('disabled=true：点击内部按钮不会触发 onClick', () => {
    const onClick = vi.fn()
    render(<SettingRow label="示例" control={<button onClick={onClick}>操作</button>} disabled />)
    fireEvent.click(screen.getByRole('button', { name: '操作' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  // 对照组：同一个组件、只把 disabled 去掉，点击必须正常触发——证明上一条测试
  // 的"没触发"确实是 SettingRow 拦下来的，不是断言本身写挂了、或者 onClick 压根
  // 没接对地方。起点（0 次）与对照组目标（1 次）不同，不是恒真检查。
  it('disabled=false（对照组）：点击内部按钮正常触发 onClick', () => {
    const onClick = vi.fn()
    render(<SettingRow label="示例" control={<button onClick={onClick}>操作</button>} />)
    fireEvent.click(screen.getByRole('button', { name: '操作' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('disabled=true：改动内部滑块不会触发 onChange（覆盖 change 类控件，不止 click）', () => {
    const onChange = vi.fn()
    render(
      <SettingRow
        label="滚动速度"
        control={<input type="range" aria-label="滚动速度" min={0} max={10} defaultValue={2} onChange={onChange} />}
        disabled
      />,
    )
    fireEvent.change(screen.getByRole('slider', { name: '滚动速度' }), { target: { value: '8' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disabled=true：整行带有 setting-row-disabled class，用于视觉置灰；disabled=false 时没有', () => {
    const { container: disabledContainer } = render(
      <SettingRow label="示例" control={<button>操作</button>} disabled />,
    )
    const { container: enabledContainer } = render(<SettingRow label="示例" control={<button>操作</button>} />)
    expect(disabledContainer.querySelector('.setting-row-disabled')).not.toBeNull()
    expect(enabledContainer.querySelector('.setting-row-disabled')).toBeNull()
  })

  it('description 由调用方按 disabled 状态传入不同文案，SettingRow 原样渲染', () => {
    render(
      <SettingRow
        label="亮色主题"
        description="当前模式不使用这一项"
        control={<button>操作</button>}
        disabled
      />,
    )
    expect(screen.queryByText('当前模式不使用这一项')).not.toBeNull()
  })
})
