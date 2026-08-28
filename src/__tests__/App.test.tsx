import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
// 与 ptyBuffer 同一理由：这批测试不关心会话状态，整个模块换成不触碰真实 Tauri 事件桥的
// 空实现（真实的合并/聚合行为由 status.test.ts / StatusDot 相关测试单独覆盖）。Task 10
// 起 App.tsx 新挂了 StatusBar，它直接读 useStatusStore/threadStatusKey（不经
// useThreadStatus/useProjectStatus 这两个既有 selector），这里一并补最小静态桩，否则
// 渲染 <App/> 会在 StatusBar 内部因缺失导出而抛错。
vi.mock('../store/status', () => ({
  statusEventsReady: Promise.resolve(),
  useThreadStatus: () => undefined,
  useProjectStatus: () => 'unknown' as const,
  useStatusStore: (selector: (s: { statuses: Map<string, unknown> }) => unknown) => selector({ statuses: new Map() }),
  threadStatusKey: (dirName: string, rootKey: string) => `${dirName}::${rootKey}`,
}))
// 与上面 store/status 同一理由：这批测试不关心 hooks 安装状态，整个模块换成不触碰真实
// ipc 调用的空实现（真实行为由 HooksInstall.test.tsx / hooksInstall.test.ts 单独覆盖）。
vi.mock('../store/hooksInstall', () => ({
  hooksInstallReady: Promise.resolve(),
  hooksPhase: () => null,
  useHooksInstall: Object.assign(() => null, { getState: () => ({ dismiss: () => {}, install: async () => {}, uninstall: async () => {} }) }),
}))
// App.tsx 顶层 side-effect 导入 closeRequest.ts 是为了在真实环境里尽早注册"应用关闭前确认"
// 监听器；替身掉避免它在测试环境里去调用真实的 @tauri-apps/api/event（没有 Tauri 运行时
// 会抛错），与本文件要验证的 Ctrl+Tab 循环切换无关。closeRequest.ts 自身的行为见
// closeRequest.test.ts。
vi.mock('../closeRequest', () => ({}))
// TerminalView 内部会实例化真实的 xterm.js Terminal（渲染器、ResizeObserver 等），
// 与本文件要验证的"标签间循环切换"无关，替身掉避免测试和真实终端机制耦合。
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }))

import App from '../App'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }
const TAB_A = { id: 'tab-a', kind: 'term' as const, title: 'A', panes: [{ id: 'pane-a', ptyId: 'p1', title: 'A' }], activePaneId: 'pane-a' }
const TAB_B = { id: 'tab-b', kind: 'term' as const, title: 'B', panes: [{ id: 'pane-b', ptyId: 'p2', title: 'B' }], activePaneId: 'pane-b' }

beforeEach(() => {
  useTabs.setState({ tabs: [HOME], activeId: 'home' })
  // hint 现在是独立 store（见 store/hint.ts），不再随 App 每次挂载天然重置——手动清空，
  // 避免上一个测试触发的轻提示（真实 setTimeout，2200ms 后才会自行清除）泄漏进下一个
  // 测试的断言。
  useHint.setState({ message: null })
})

// App 挂载时会触发一次异步的 useSessions().refresh()（mock 的 listProjects 也是个
// async fn）；render 后 flush 一次微任务，让它在 act() 里落地，避免测试里出现
// 与本文件断言无关的 "not wrapped in act" 噪音。
async function renderApp() {
  const utils = render(<App />)
  await act(async () => { await Promise.resolve() })
  return utils
}

async function ctrlTab(opts: { shift?: boolean } = {}) {
  let notCanceled = true
  await act(async () => {
    notCanceled = window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: !!opts.shift, bubbles: true, cancelable: true }),
    )
  })
  return notCanceled
}

async function cmdD() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true }))
  })
}

async function cmdW() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true }))
  })
}

async function cmdAltArrow(direction: 'left' | 'right') {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: direction === 'left' ? 'ArrowLeft' : 'ArrowRight',
        metaKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

describe('App — Control+Tab 在标签间循环切换', () => {
  it('Ctrl+Tab 从最后一个标签前进，越过末尾回绕到第一个（主页）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-b' })
    await renderApp()
    await ctrlTab()
    expect(useTabs.getState().activeId).toBe('home')
  })

  it('Ctrl+Shift+Tab 从第一个标签（主页）后退，越过开头回绕到最后一个', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'home' })
    await renderApp()
    await ctrlTab({ shift: true })
    expect(useTabs.getState().activeId).toBe('tab-b')
  })

  it('非边界位置：Ctrl+Tab 前进一格、Ctrl+Shift+Tab 后退一格，按数组既有顺序', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    await ctrlTab()
    expect(useTabs.getState().activeId).toBe('tab-b')
    await ctrlTab({ shift: true })
    expect(useTabs.getState().activeId).toBe('tab-a')
    await ctrlTab({ shift: true })
    expect(useTabs.getState().activeId).toBe('home')
  })

  it('只有主页一个标签时，Ctrl+Tab 回绕到自身且不抛错', async () => {
    await renderApp()
    await ctrlTab() // 若内部抛错，await 会让这个测试直接失败
    expect(useTabs.getState().activeId).toBe('home')
  })

  it('命中 Ctrl+Tab 时阻止默认行为并停止传播；未命中的普通按键原样放行给终端', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'home' })
    await renderApp()
    // dispatchEvent 对被 preventDefault() 的（可取消）事件返回 false
    expect(await ctrlTab()).toBe(false)
    expect(useTabs.getState().activeId).toBe('tab-a') // 确实处理了，不是碰巧返回 false

    let plain = true
    await act(async () => {
      plain = window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    })
    expect(plain).toBe(true) // 未命中的按键完全不受影响，没有被提前拦截
  })
})

describe('App — Ctrl+Tab 只切标签，不切窗格焦点（设计文档 §6"语义不变"）', () => {
  it('多窗格标签的 activePaneId 在 Ctrl+Tab 循环标签前后保持不变', async () => {
    const MULTI = {
      id: 'tab-multi', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'm1', ptyId: 'pty-m1', title: 'M1' }, { id: 'm2', ptyId: 'pty-m2', title: 'M2' }],
      activePaneId: 'm2',
    }
    useTabs.setState({ tabs: [HOME, MULTI, TAB_A], activeId: 'tab-multi' })
    await renderApp()

    await ctrlTab() // 循环到下一个标签（tab-a）
    expect(useTabs.getState().activeId).toBe('tab-a')
    await ctrlTab({ shift: true }) // 循环回 tab-multi

    expect(useTabs.getState().activeId).toBe('tab-multi')
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-multi')!.activePaneId).toBe('m2') // 未被 Ctrl+Tab 动过
  })
})

describe('App — ⌘D 新建窗格（设计文档 §5-A、§8）', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('从 1 个窗格新建到 3 个；第 4 次被拒绝并显示轻提示，窗格数保持 3', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 }) // 足够宽，不触发 §8 降级
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    const { getByText } = await renderApp()

    await cmdD()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2)
    await cmdD()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(3)
    await cmdD()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(3) // 拒绝第 4 个，数量不变
    expect(getByText('最多支持 3 个窗格')).toBeTruthy()
  })

  it('新窗格插在聚焦窗格右侧、未选定会话前没有 ptyId，且立即成为新的焦点窗格', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()

    await cmdD()

    const tab = useTabs.getState().tabs.find((t) => t.id === 'tab-a')!
    expect(tab.panes.map((p) => p.id)[0]).toBe('pane-a')
    expect(tab.activePaneId).toBe(tab.panes[1].id)
    expect(tab.panes[1].ptyId).toBeUndefined()
  })

  it('窄窗口：单独装不下时优先收起对话面板，腾出空间后成功新建', async () => {
    // 内容区 600px 装不下 2×320=640；收起面板（400px）后 600+400=1000 足够。
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 600 })
    useLayout.setState({ panelCollapsed: false, panelWidth: 400 })
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()

    await cmdD()

    expect(useLayout.getState().panelCollapsed).toBe(true)
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2)
  })

  it('窄窗口：收起面板也装不下时，拒绝新建并提示，不挤压已有窗格', async () => {
    // 300 + 200 = 500，仍小于 2×320=640。
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 300 })
    useLayout.setState({ panelCollapsed: false, panelWidth: 200 })
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    const { getByText } = await renderApp()

    await cmdD()

    expect(useLayout.getState().panelCollapsed).toBe(false) // 没有被误收起
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(1) // 没有被挤压/新建
    expect(getByText('窗口太窄，放不下新窗格')).toBeTruthy()
  })

  it('主页标签上按 ⌘D 是空操作', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
    await renderApp() // activeId 默认 home
    await cmdD()
    expect(useTabs.getState().tabs).toHaveLength(1)
  })

  // 修正 paneLayout.ts 的 320px 最小宽度扣除分隔条/窗格边框/容器内边距开销之后，⌘D
  // 的拒绝阈值也要跟着变——这两个用例专门钉住 contentRef.current.clientWidth 这个原始
  // 测量值（.content 无边框/内边距，数值上与 .term-wrap 相等）需要先扣掉
  // TERM_WRAP_HORIZONTAL_PADDING_PX + DIVIDER_TOTAL_WIDTH_PX + 2*PANE_BORDER_TOTAL_WIDTH_PX
  // = 12+9+4 = 25px 才是真正分给 2 个窗格内容区的宽度（见 paneLayout.ts）。
  // panelCollapsed:true 让 decidePaneFit 只看第一条 fitsPanes 分支，不掺进"收起面板"
  // 那条分支的干扰。
  it('原始测量值 640px：修正前会被误判"刚好装得下"，修正后应正确拒绝', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 640 })
    useLayout.setState({ panelCollapsed: true, panelWidth: 0 })
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    const { getByText } = await renderApp()

    await cmdD()

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(1) // 没有被挤压/新建
    expect(getByText('窗口太窄，放不下新窗格')).toBeTruthy()
  })

  it('原始测量值 665px（640 + 25px 开销）：修正后的真实边界仍然装得下', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 665 })
    useLayout.setState({ panelCollapsed: true, panelWidth: 0 })
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()

    await cmdD()

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2)
  })
})

describe('App — ⌘⌥←/→ 窗格焦点移动（不跨标签，边界不循环）', () => {
  const MULTI = {
    id: 'tab-multi', kind: 'term' as const, title: '3 个对话',
    panes: [
      { id: 'p1', ptyId: 'pty-1', title: 'P1' },
      { id: 'p2', ptyId: 'pty-2', title: 'P2' },
      { id: 'p3', ptyId: 'pty-3', title: 'P3' },
    ],
    activePaneId: 'p2',
  }

  it('从中间窗格向右/向左移动，到达边界后不循环', async () => {
    useTabs.setState({ tabs: [HOME, MULTI], activeId: 'tab-multi' })
    await renderApp()

    await cmdAltArrow('right')
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-multi')!.activePaneId).toBe('p3')
    await cmdAltArrow('right') // 已在最右侧
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-multi')!.activePaneId).toBe('p3')

    await cmdAltArrow('left')
    await cmdAltArrow('left')
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-multi')!.activePaneId).toBe('p1')
    await cmdAltArrow('left') // 已在最左侧
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-multi')!.activePaneId).toBe('p1')
  })

  it('不跨标签：只改变当前激活标签的 activePaneId，不影响其他标签', async () => {
    const OTHER = { id: 'tab-other', kind: 'term' as const, title: 'O', panes: [{ id: 'po', ptyId: 'pty-o', title: 'O' }], activePaneId: 'po' }
    useTabs.setState({ tabs: [HOME, MULTI, OTHER], activeId: 'tab-multi' })
    await renderApp()

    await cmdAltArrow('right')

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-other')!.activePaneId).toBe('po')
  })
})

describe('App — ⌘W 关闭聚焦窗格；标签只剩一个窗格时等同关闭标签（设计文档 §6）', () => {
  it('多窗格标签：只关闭聚焦窗格，标签仍在', async () => {
    const TWO = {
      id: 'tab-two', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'q1', ptyId: 'pty-q1', title: 'Q1' }, { id: 'q2', ptyId: 'pty-q2', title: 'Q2' }],
      activePaneId: 'q1',
    }
    useTabs.setState({ tabs: [HOME, TWO], activeId: 'tab-two' })
    await renderApp()

    await cmdW()

    // 本文件顶部 mock 的 ptyIsAlive 恒为 false，closePane 内部不会弹确认，
    // 用 waitFor 等它异步的 set() 落地。
    await waitFor(() => {
      const t = useTabs.getState().tabs.find((x) => x.id === 'tab-two')
      expect(t?.panes.map((p) => p.id)).toEqual(['q2'])
    })
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-two')).toBeTruthy() // 标签还在
  })

  it('单窗格标签：⌘W 等同关闭整个标签', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()

    await cmdW()

    await waitFor(() => {
      expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')).toBeUndefined()
    })
    expect(useTabs.getState().activeId).toBe('home')
  })
})
