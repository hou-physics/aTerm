import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
// App.tsx 顶层 side-effect 导入 closeRequest.ts 是为了在真实环境里尽早注册"应用关闭前确认"
// 监听器；替身掉避免它在测试环境里去调用真实的 @tauri-apps/api/event（没有 Tauri 运行时
// 会抛错），与本文件要验证的 Ctrl+Tab 循环切换无关。closeRequest.ts 自身的行为见
// closeRequest.test.ts。
vi.mock('../closeRequest', () => ({}))
// TerminalView 内部会实例化真实的 xterm.js Terminal（渲染器、ResizeObserver 等），
// 与本文件要验证的"标签间循环切换"无关，替身掉避免测试和真实终端机制耦合。
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }))

import App from '../App'
import { useTabs } from '../store/tabs'

const HOME = { id: 'home', kind: 'home' as const, title: '主页' }
const TAB_A = { id: 'tab-a', kind: 'term' as const, title: 'A', ptyId: 'p1' }
const TAB_B = { id: 'tab-b', kind: 'term' as const, title: 'B', ptyId: 'p2' }

beforeEach(() => {
  useTabs.setState({ tabs: [HOME], activeId: 'home' })
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
