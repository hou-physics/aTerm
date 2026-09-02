// 拖放落点改走粘贴（见 App.tsx onDragDropEvent 里的 pasteTo(...) ?? ptyWrite(...) 分支）。
// 只断言"注册表命中时走 pasteTo、未命中时退回 ptyWrite"这个分支选择本身——term.paste()
// 是否真的会被 xterm 包上括号粘贴标记、Claude 是否真的识别成图片附件，那是 xterm/Claude
// 的行为，jsdom 里没有真实终端，已经用真 pty 做过 A/B 实测（见需求文档），这里不重复
// 声称验证了那件事。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

const dragDrop = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: unknown }) => void),
}))

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
  countSubagents: vi.fn(() => new Promise<number>(() => {})),
  ptyWrite: vi.fn(async () => {}),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
vi.mock('../store/status', () => ({
  statusEventsReady: Promise.resolve(),
  useThreadStatus: () => undefined,
  useProjectStatus: () => 'unknown' as const,
  useStatusStore: (selector: (s: { statuses: Map<string, unknown> }) => unknown) => selector({ statuses: new Map() }),
  threadStatusKey: (dirName: string, rootKey: string) => `${dirName}::${rootKey}`,
}))
vi.mock('../store/hooksInstall', () => ({
  hooksInstallReady: Promise.resolve(),
  hooksPhase: () => null,
  useHooksInstall: Object.assign(() => null, { getState: () => ({ dismiss: () => {}, install: async () => {}, uninstall: async () => {} }) }),
}))
vi.mock('../closeRequest', () => ({}))
vi.mock('../menuEvents', () => ({}))
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }))
// 与 App.test.tsx 不同：这里要真的拿到 App.tsx 传给 onDragDropEvent 的回调，手动喂一个
// 合成的 'drop' payload 进去，才能触发到 pasteTo/ptyWrite 那条分支选择。
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (e: { payload: unknown }) => void) => {
      dragDrop.handler = handler
      return () => {}
    },
  }),
}))
// getPaneSlotRects 读真实 DOM 矩形，jsdom 里恒为 0（见 paneDropDom.ts 顶部注释），
// 直接桩成命中固定窗格，绕开这个已知限制，专注测分支选择。
vi.mock('../paneDropDom', () => ({
  getPaneSlotRects: vi.fn(() => [{ paneId: 'pane-a', rect: { top: 0, left: 0, width: 100, height: 100 } }]),
}))
vi.mock('../terminalPaste', () => ({
  pasteTo: vi.fn(),
  registerPaste: vi.fn(() => () => {}),
}))

import App from '../App'
import { ptyWrite } from '../ipc'
import { pasteTo } from '../terminalPaste'
import { useTabs } from '../store/tabs'

const TAB_A = {
  id: 'tab-a', kind: 'term' as const, title: 'A',
  panes: [{ id: 'pane-a', ptyId: 'p1', title: 'A' }], activePaneId: 'pane-a',
}

beforeEach(() => {
  vi.clearAllMocks()
  dragDrop.handler = null
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home' as const, title: '主页', panes: [] }, TAB_A], activeId: 'tab-a' })
})

async function renderApp() {
  const utils = render(<App />)
  await act(async () => { await Promise.resolve() })
  return utils
}

function fireDrop(paths: string[]) {
  dragDrop.handler!({ payload: { type: 'drop', position: { x: 10, y: 10 }, paths } })
}

describe('App — 拖放落点改走粘贴（pasteTo 命中/未命中的分支选择）', () => {
  it('pasteTo 命中（终端已注册）：调用 pasteTo，不退回 ptyWrite', async () => {
    vi.mocked(pasteTo).mockReturnValue(true)
    await renderApp()
    expect(dragDrop.handler).toBeTruthy()

    await act(async () => { fireDrop(['/tmp/probe img.png']) })

    expect(pasteTo).toHaveBeenCalledWith('p1', "'/tmp/probe img.png' ")
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('pasteTo 未命中（终端未注册，返回 false）：退回 ptyWrite，同样的 ptyId/text', async () => {
    vi.mocked(pasteTo).mockReturnValue(false)
    await renderApp()
    expect(dragDrop.handler).toBeTruthy()

    await act(async () => { fireDrop(['/tmp/probe img.png']) })

    expect(pasteTo).toHaveBeenCalledWith('p1', "'/tmp/probe img.png' ")
    expect(ptyWrite).toHaveBeenCalledWith('p1', "'/tmp/probe img.png' ")
  })
})
