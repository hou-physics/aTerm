import { describe, expect, it, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPanel } from '../components/SettingsPanel'
import { useSettings } from '../store/settings'

// SettingsPanel 的"点外部关闭"改成了 pointerdown + setTimeout(0) 的 idiom（照抄
// ContextMenu.tsx，见组件内注释）：监听器要等一个宏任务之后才挂上，测试里在
// fireEvent.pointerDown 之前必须先把这个 setTimeout(0) 冲掉，否则监听器还没注册，
// 断言会拿到"点了但没关"的假阳性。
const flushPointerDownGuard = () => new Promise((r) => setTimeout(r, 0))

describe('SettingsPanel', () => {
  beforeEach(() => { useSettings.setState({ open: false }) })

  it('关闭时不渲染任何内容', () => {
    const { container } = render(<SettingsPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('打开时渲染面板', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('按 Esc 关闭', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useSettings.getState().open).toBe(false)
  })

  // R1 修复 B：原 brief 这两条测试写的是 click 语义，改成组件实际使用的 pointerdown
  // 语义（授权改写，见 task-2-report.md「修复轮 R1」）。
  it('点遮罩关闭', async () => {
    useSettings.setState({ open: true })
    const { container } = render(<SettingsPanel />)
    await flushPointerDownGuard()
    const scrim = container.querySelector('.settings-scrim')!
    fireEvent.pointerDown(scrim)
    expect(useSettings.getState().open).toBe(false)
  })

  it('点面板内部不关闭', async () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    await flushPointerDownGuard()
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(useSettings.getState().open).toBe(true)
  })

  it('打开浮层的那次 pointerdown 不会被当场当成"面板外点击"立刻关闭', () => {
    // 不 flush setTimeout(0)：模拟"触发浮层的那次 pointerdown 仍在同一个事件循环
    // tick 内"——监听器要下一个 tick 才挂上，这次按下不该被它看见。
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    fireEvent.pointerDown(document.body)
    expect(useSettings.getState().open).toBe(true)
  })

  // 固化本轮教训：mousedown 与 mouseup 落在不同元素时，浏览器合成的 click 事件
  // target 是二者的最近公共祖先——面板内按下、拖到遮罩上松开，合成出来的 click
  // target 是遮罩本身，不是从面板冒泡上来的，旧版 stopPropagation 对它完全无效。
  // 新版判定的是"这次按下动作起点在不在面板内"（pointerdown 的 target），不受这个
  // 影响，所以这里模拟的是"面板内 pointerdown、遮罩上 pointerup + click"，断言不关闭。
  it('面板内按下、拖到遮罩上松开：不应关闭（click+stopPropagation 拦不住这种拖选越界）', async () => {
    useSettings.setState({ open: true })
    const { container } = render(<SettingsPanel />)
    await flushPointerDownGuard()
    const dialog = screen.getByRole('dialog')
    const scrim = container.querySelector('.settings-scrim')!
    fireEvent.pointerDown(dialog)
    fireEvent.pointerUp(scrim)
    fireEvent.click(scrim) // 合成 click：target 是 mousedown/mouseup 两次落点的最近公共祖先（遮罩）
    expect(useSettings.getState().open).toBe(true)
  })

  it('点关闭按钮关闭', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(useSettings.getState().open).toBe(false)
  })

  it('打开时把焦点移进面板', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })

  it('关闭后把焦点还给打开它的触发元素', () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开设置'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    useSettings.setState({ open: true })
    const { rerender } = render(<SettingsPanel />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))

    act(() => { useSettings.setState({ open: false }) })
    rerender(<SettingsPanel />)
    expect(document.activeElement).toBe(trigger)

    trigger.remove()
  })

  // R1 修复 A：Tab 焦点陷阱。
  describe('Tab 焦点陷阱', () => {
    it('面板内只有一个可聚焦元素（当前只有关闭按钮）时，Tab 停在原地', async () => {
      useSettings.setState({ open: true })
      render(<SettingsPanel />)
      const closeBtn = screen.getByRole('button', { name: '关闭设置' })
      closeBtn.focus()

      await userEvent.tab()
      expect(document.activeElement).toBe(closeBtn)

      await userEvent.tab({ shift: true })
      expect(document.activeElement).toBe(closeBtn)
    })

    // 当前四个分区都还是空占位，面板内唯一天然可聚焦的元素只有关闭按钮，光靠它测不出
    // "多个可聚焦元素之间绕回"这件事——上面那条"只有一个"的用例 first===last，正向和
    // 反向恰好都退化成"停在原地"，不能证明陷阱在有多个元素时也认得清"谁是第一个/最后
    // 一个"。这里手动往 .settings-panel-body 里挂一个占位按钮，模拟 Task 3/4 把真实
    // 控件塞进分区之后的场景：陷阱逻辑本身是每次按键现查 DOM（getFocusableElements），
    // 不是挂载时缓存的固定列表，所以这样挂靠谱地验证了同一套逻辑。
    it('面板内有多个可聚焦元素时，正向 Tab 从最后一个绕回第一个', async () => {
      useSettings.setState({ open: true })
      const { container } = render(<SettingsPanel />)
      const body = container.querySelector('.settings-panel-body')!
      const extra = document.createElement('button')
      extra.type = 'button'
      extra.textContent = '占位按钮'
      body.appendChild(extra)
      const closeBtn = screen.getByRole('button', { name: '关闭设置' })

      extra.focus()
      expect(document.activeElement).toBe(extra)

      await userEvent.tab()
      expect(document.activeElement).toBe(closeBtn)
    })

    it('面板内有多个可聚焦元素时，Shift+Tab 从第一个绕回最后一个', async () => {
      useSettings.setState({ open: true })
      const { container } = render(<SettingsPanel />)
      const body = container.querySelector('.settings-panel-body')!
      const extra = document.createElement('button')
      extra.type = 'button'
      extra.textContent = '占位按钮'
      body.appendChild(extra)
      const closeBtn = screen.getByRole('button', { name: '关闭设置' })

      closeBtn.focus()
      expect(document.activeElement).toBe(closeBtn)

      await userEvent.tab({ shift: true })
      expect(document.activeElement).toBe(extra)
    })

    it('面板内没有可聚焦元素时，Tab 不抛异常、焦点钳在面板本身', async () => {
      useSettings.setState({ open: true })
      render(<SettingsPanel />)
      const dialog = screen.getByRole('dialog')
      // 拔掉唯一的可聚焦元素，模拟"面板内没有可聚焦元素"这一边界。
      screen.getByRole('button', { name: '关闭设置' }).remove()
      dialog.focus()
      expect(document.activeElement).toBe(dialog)

      await userEvent.tab()
      expect(document.activeElement).toBe(dialog)
    })
  })
})
