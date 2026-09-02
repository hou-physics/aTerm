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
  // activeCategory 也一起重置：本文件（组件层）要测的是"渲染的是 activeCategory
  // 指向的那个分区"，不是 store 默认值本身（那是 settingsStore.test.ts 的活，用
  // getInitialState() 测，见该文件 R1 修复注释）。下面用到 activeCategory 的用例
  // 都会自己再显式 setState 一次起点分类，不依赖这里的重置值，纯粹是防止上一条
  // 用例改过的分类泄漏到下一条。
  beforeEach(() => { useSettings.setState({ open: false, activeCategory: 'theme' }) })

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

  // v3-2b：左侧分类列表 + 右侧详情。用户明确否掉了"四个分区全部平铺展开"，这里
  // 钉住三件事——渲染的是 activeCategory 指向的那一个分区、切换分类时未选中的
  // 分区完全不挂载（不是 display:none）、关闭再打开保留上次选的分类——以及
  // aria-current 的选中态标记。「activeCategory 默认值是 theme」本身不是这个文件
  // 的活，那条断言归 settingsStore.test.ts（用 getInitialState() 测，不受
  // beforeEach/顺序影响，见该文件 R1 修复注释）。
  describe('分类导航（左侧列表 + 右侧详情）', () => {
    it('activeCategory 为「主题」时，右侧只渲染主题分区', () => {
      // 显式钉住 activeCategory，不依赖它恰好等于 store 的默认值——这条测的是
      // "组件根据 activeCategory 渲染对应分区"这件事本身，跟 activeCategory 的
      // 默认值是什么无关（那是上面提到的 store 测试的职责）。
      useSettings.setState({ open: true, activeCategory: 'theme' })
      const { container } = render(<SettingsPanel />)
      expect(container.querySelector('.appearance-section')).not.toBeNull()
      // 其余三个分区此时不应该被挂载。
      expect(container.querySelector('.terminal-section')).toBeNull()
      expect(container.querySelector('.projects-section')).toBeNull()
      expect(container.querySelector('.hooks-section')).toBeNull()
    })

    it('点「终端」→ 右侧变成终端分区，且主题分区不再存在于 DOM 中', () => {
      // 显式钉住起点分类，自己的前提自己负责，不依赖 beforeEach 的重置值。
      useSettings.setState({ open: true, activeCategory: 'theme' })
      const { container } = render(<SettingsPanel />)
      // 起点：默认分类「主题」的分区确实在 DOM 里，与下面点击之后的状态不同——
      // 不是恒真检查。
      expect(container.querySelector('.appearance-section')).not.toBeNull()
      expect(container.querySelector('.terminal-section')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: '终端' }))

      expect(container.querySelector('.terminal-section')).not.toBeNull()
      expect(container.querySelector('.appearance-section')).toBeNull()
    })

    it('关闭浮层再打开，仍停留在上次选的分类', () => {
      useSettings.setState({ open: true, activeCategory: 'theme' })
      const { container, rerender } = render(<SettingsPanel />)
      fireEvent.click(screen.getByRole('button', { name: 'Hooks' }))
      expect(container.querySelector('.hooks-section')).not.toBeNull()

      // 关闭走真实的关闭按钮（调到 closeSettings() 本身），不是直接
      // useSettings.setState({ open: false })——后者绕过了 closeSettings 的实现，
      // 如果哪天有人在 closeSettings 里顺手把 activeCategory 也重置掉，
      // 直接 setState 的写法测不出这个回归（已经在变异验证里实际跑出过这个假阳性：
      // 给 closeSettings 塞一行 activeCategory: 'theme'，这条测试原样全绿）。
      fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
      expect(container.firstChild).toBeNull() // 关闭时确实不渲染任何内容

      act(() => { useSettings.setState({ open: true }) })
      rerender(<SettingsPanel />)
      // 重开后还是 Hooks，不是回落到默认的「主题」。
      expect(container.querySelector('.hooks-section')).not.toBeNull()
      expect(container.querySelector('.appearance-section')).toBeNull()
    })

    it('选中项有 aria-current，未选中项没有', () => {
      useSettings.setState({ open: true, activeCategory: 'theme' })
      render(<SettingsPanel />)
      const themeBtn = screen.getByRole('button', { name: '主题' })
      const terminalBtn = screen.getByRole('button', { name: '终端' })
      expect(themeBtn.getAttribute('aria-current')).toBe('true')
      expect(terminalBtn.getAttribute('aria-current')).toBeNull()
    })

    it('切换分类后，aria-current 跟着切换到新选中项', () => {
      useSettings.setState({ open: true, activeCategory: 'theme' })
      render(<SettingsPanel />)
      const themeBtn = screen.getByRole('button', { name: '主题' })
      const terminalBtn = screen.getByRole('button', { name: '终端' })
      // 起点与下面点击后的目标值不同：终端此时是 null，不是 'true'。
      expect(terminalBtn.getAttribute('aria-current')).toBeNull()

      fireEvent.click(terminalBtn)

      expect(terminalBtn.getAttribute('aria-current')).toBe('true')
      expect(themeBtn.getAttribute('aria-current')).toBeNull()
    })
  })

  // R1 修复 A：Tab 焦点陷阱。
  describe('Tab 焦点陷阱', () => {
    it('面板内只有一个可聚焦元素（当前只有关闭按钮）时，Tab 停在原地', async () => {
      useSettings.setState({ open: true })
      const { container } = render(<SettingsPanel />)
      // v3-2b 起面板分两栏：.settings-panel-nav（4 个分类按钮）+ .settings-panel-body
      // （当前选中分类的真实控件），面板不再天然只有关闭按钮一个可聚焦元素。两栏的
      // 共同父容器是 .settings-panel-content，清空它一次性把两栏都拔掉，重建
      // "只有一个可聚焦元素"这个边界——与下面"没有可聚焦元素"用例同一 idiom。
      container.querySelector('.settings-panel-content')!.innerHTML = ''
      const closeBtn = screen.getByRole('button', { name: '关闭设置' })
      closeBtn.focus()

      await userEvent.tab()
      expect(document.activeElement).toBe(closeBtn)

      await userEvent.tab({ shift: true })
      expect(document.activeElement).toBe(closeBtn)
    })

    // 面板内已经有多个天然可聚焦元素（关闭按钮 + 4 个分类导航按钮 + 当前选中分类
    // ——默认是"主题"——里的真实控件），光有它们已经测得出"多个可聚焦元素之间绕
    // 回"，但为了不依赖"主题"分区具体挂了哪些控件（以后可能变化），这里仍然手动往
    // .settings-panel-body 里追加一个占位按钮，钉死"最后一个可聚焦元素"是谁。陷阱
    // 逻辑本身是每次按键现查 DOM（getFocusableElements），不是挂载时缓存的固定
    // 列表，所以这样挂靠谱地验证了同一套逻辑。
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
      const { container } = render(<SettingsPanel />)
      const dialog = screen.getByRole('dialog')
      // 拔掉所有可聚焦元素，模拟"面板内没有可聚焦元素"这一边界。清空
      // .settings-panel-content 的 innerHTML（而不是逐个找 button 移除）+ 移除关闭
      // 按钮——v3-2b 起这个容器同时装着左侧 .settings-panel-nav（4 个分类按钮）和
      // 右侧 .settings-panel-body（当前分类的真实控件，可能是 button，切到"终端"
      // 分类时是 TerminalSection 的 <input type="range">，`querySelectorAll('button')
      // .forEach(remove)` 清不掉它），一次性清空两栏，不依赖分区内控件的具体标签，
      // 往后分区里加什么控件都不用回来改这条测试。
      container.querySelector('.settings-panel-content')!.innerHTML = ''
      screen.getByRole('button', { name: '关闭设置' }).remove()
      dialog.focus()
      expect(document.activeElement).toBe(dialog)

      await userEvent.tab()
      expect(document.activeElement).toBe(dialog)
    })
  })
})
