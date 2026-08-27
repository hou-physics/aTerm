// 测试专用的最小工厂：给分屏（多 pane）相关的新增用例减少字面量重复。既有测试文件
// 里大量手写的 `{ id, kind:'term', title, panes:[...], activePaneId }` 字面量在
// step1 阶段就已经存在（本步骤新增的必填字段更多，逐条手写只会更啰嗦），这里只用于
// 本次新增的用例，不回头改写已通过的旧测试字面量（见 code review 对 step1 的建议：
// 只在"确实大量新增"时引入抽象，不为了统一风格改动已经在跑的用例）。
import type { Pane, Tab } from '../store/tabs'

let seq = 0

export function makePane(overrides: Partial<Pane> = {}): Pane {
  seq += 1
  return { id: `pane-f${seq}`, ptyId: `pty-f${seq}`, title: `窗格${seq}`, ...overrides }
}

export function makeTermTab(overrides: Partial<Tab> = {}): Tab {
  seq += 1
  const panes = overrides.panes ?? [makePane()]
  return {
    id: `tab-f${seq}`,
    kind: 'term',
    title: panes.length > 1 ? `${panes.length} 个对话` : (panes[0]?.title ?? 'tab'),
    panes,
    activePaneId: panes[0]?.id,
    ...overrides,
  }
}

export const HOME_TAB: Tab = { id: 'home', kind: 'home', title: '主页', panes: [] }
