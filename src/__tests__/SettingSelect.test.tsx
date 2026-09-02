import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SettingSelect, type SettingSelectOption } from '../components/settings/SettingSelect'

// SettingSelect：v3-2c 第二轮新增的设置页专用下拉（src/components/settings/
// SettingSelect.tsx），供主题页四行共用。这里只测组件自己的行为——展开/收起、
// 键盘、点外面收起、disabled 透传——不测 AppearanceSection 怎么组装 options，那部分
// 在 AppearanceSection.test.tsx。

const OPTIONS: SettingSelectOption[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
  { id: 'c', label: 'Charlie' },
]

// 点外面收起用的是 ContextMenu.tsx 同款 idiom：pointerdown 监听器要等一个
// setTimeout(0) 之后才挂上，断言"点外面收起"前必须先冲掉这个宏任务，否则监听器
// 还没注册，断言会拿到"点了但没关"的假阳性——与 SettingsPanel.test.tsx 的
// flushPointerDownGuard 同一理由、同一写法。
const flushPointerDownGuard = () => new Promise((r) => setTimeout(r, 0))

describe('SettingSelect', () => {
  it('触发器显示当前选中项的文字', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="b" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: '测试' })
    expect(trigger.textContent).toContain('Bravo')
  })

  it('初始不展开：看不到任何 option，aria-expanded=false', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} />)
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(screen.getByRole('button', { name: '测试' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('触发器带 aria-haspopup=listbox；点击展开后列表 role=listbox 且 aria-expanded 变 true', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: '测试' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('option').length).toBe(3)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('测试')
  })

  it('展开列表：当前选中项 aria-selected=true，其余为 false', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="b" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '测试' }))
    expect(screen.getByRole('option', { name: 'Bravo' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('option', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('false')
  })

  it('点击一个选项：调用 onChange 并收起列表', () => {
    const onChange = vi.fn()
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '测试' }))
    fireEvent.click(screen.getByRole('option', { name: 'Charlie' }))
    expect(onChange).toHaveBeenCalledWith('c')
    expect(screen.queryAllByRole('option').length).toBe(0)
  })

  it('disabled：触发器带原生 disabled 属性，点击不展开', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} disabled />)
    const trigger = screen.getByRole('button', { name: '测试' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryAllByRole('option').length).toBe(0)
  })

  it('Enter 展开', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} />)
    fireEvent.keyDown(screen.getByRole('button', { name: '测试' }), { key: 'Enter' })
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('Space 展开', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} />)
    fireEvent.keyDown(screen.getByRole('button', { name: '测试' }), { key: ' ' })
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('展开后 ↓↓ 移动高亮、Enter 选中：调用 onChange、收起列表、焦点回到触发器', () => {
    const onChange = vi.fn()
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: '测试' })
    fireEvent.click(trigger)
    fireEvent.blur(trigger) // 模拟焦点当时不在触发器上，"收起后把焦点还给触发器"这条断言才不是摆设
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // a(0) -> b(1)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // b(1) -> c(2)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('c')
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(document.activeElement).toBe(trigger)
  })

  it('展开后 ↑ 钳在第一项：从当前值 b 往上两次仍停在 a，Enter 选中 a', () => {
    const onChange = vi.fn()
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="b" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: '测试' })
    fireEvent.click(trigger) // 打开时高亮回到当前值 b（下标 1）
    fireEvent.keyDown(trigger, { key: 'ArrowUp' }) // 1 -> 0 (a)
    fireEvent.keyDown(trigger, { key: 'ArrowUp' }) // 已经是 0，钳住不再前进
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('Esc 收起并把焦点还给触发器', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: '测试' })
    fireEvent.click(trigger)
    fireEvent.blur(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(document.activeElement).toBe(trigger)
  })

  it('点外面收起', async () => {
    render(
      <div>
        <button type="button">外面</button>
        <SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: '测试' }))
    await flushPointerDownGuard()
    expect(screen.getAllByRole('option').length).toBe(3)
    fireEvent.pointerDown(screen.getByRole('button', { name: '外面' }))
    expect(screen.queryAllByRole('option').length).toBe(0)
  })

  it('点列表内部（选项）的 pointerdown 不会被当成"点外面"提前收起', async () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '测试' }))
    await flushPointerDownGuard()
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Bravo' }))
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('展开这次 pointerdown 本身不会被当场当成"外部点击"立刻收起', () => {
    render(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '测试' }))
    // 不 flush setTimeout(0)：模拟展开这次操作仍在同一个事件循环 tick 内，监听器
    // 应该还没挂上。
    fireEvent.pointerDown(document.body)
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('选项带 swatches 时，触发器与展开列表里都渲染对应数量的色块', () => {
    const swatchOptions: SettingSelectOption[] = [
      { id: 'x', label: 'X 主题', swatches: ['#111111', '#eeeeee'] },
      { id: 'y', label: 'Y 主题', swatches: ['#222222', '#dddddd'] },
    ]
    const { container } = render(
      <SettingSelect ariaLabel="主题" options={swatchOptions} value="x" onChange={() => {}} />,
    )
    expect(container.querySelectorAll('.setting-select-trigger .setting-select-swatch').length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '主题' }))
    expect(container.querySelectorAll('.setting-select-option .setting-select-swatch').length).toBe(4)
  })

  it('调用方把 disabled 从 false 改成 true 时，若列表当时展开着会被强制收起', () => {
    const { rerender } = render(
      <SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} disabled={false} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '测试' }))
    expect(screen.getAllByRole('option').length).toBe(3)
    rerender(<SettingSelect ariaLabel="测试" options={OPTIONS} value="a" onChange={() => {}} disabled={true} />)
    expect(screen.queryAllByRole('option').length).toBe(0)
  })
})
