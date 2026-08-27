import { describe, expect, it, vi } from 'vitest'
import type { SessionStatusPayload } from '../ipc'
import { aggregateStatus } from '../store/status'

// 模块级注册 + ready promise 的验证模式与 ptyBuffer.test.ts 完全一致：hoisted 的
// listen mock 记录 handler，getSessionStatuses mock 提供受控的快照数据，freshModule
// 用 vi.resetModules() 保证每个用例拿到一份全新的 store（否则模块级注册只会执行一次，
// 后续用例读到的是前一个用例遗留的状态）。
const { handlers, listenMock, getSessionStatusesMock } = vi.hoisted(() => {
  const handlers: Record<string, (e: { payload: SessionStatusPayload[] }) => void> = {}
  const listenMock = vi.fn(async (event: string, handler: (e: { payload: SessionStatusPayload[] }) => void) => {
    handlers[event] = handler
    return () => {}
  })
  const getSessionStatusesMock = vi.fn(async (): Promise<SessionStatusPayload[]> => [])
  return { handlers, listenMock, getSessionStatusesMock }
})

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('../ipc', () => ({ getSessionStatuses: getSessionStatusesMock }))

function entry(over: Partial<SessionStatusPayload> = {}): SessionStatusPayload {
  return {
    dirName: 'proj-a', rootKey: 'root-1', sessionId: 'sess-1',
    status: 'running', lastActivityMs: 1, updatedAtMs: 10,
    ...over,
  }
}

async function freshModule() {
  vi.resetModules()
  getSessionStatusesMock.mockClear()
  const mod = await import('../store/status')
  await mod.statusEventsReady
  return mod
}

describe('store/status — 快照 + 增量事件的真实合并行为', () => {
  it('启动时用 get_session_statuses() 的快照灌入 store', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([entry({ status: 'running', updatedAtMs: 10 })])
    const { useStatusStore, threadStatusKey } = await freshModule()

    const got = useStatusStore.getState().statuses.get(threadStatusKey('proj-a', 'root-1'))
    expect(got?.status).toBe('running')
  })

  it('快照灌入之后，session-status 事件把对应会话的状态原地更新', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([entry({ status: 'running', updatedAtMs: 10 })])
    const { useStatusStore, threadStatusKey } = await freshModule()

    handlers['session-status']({ payload: [entry({ status: 'done', updatedAtMs: 20 })] })

    expect(useStatusStore.getState().statuses.get(threadStatusKey('proj-a', 'root-1'))?.status).toBe('done')
  })

  it('一次事件数组可以同时携带多个会话的状态变化（后端一次去抖批次）', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([])
    const { useStatusStore, threadStatusKey } = await freshModule()

    handlers['session-status']({
      payload: [
        entry({ rootKey: 'root-1', status: 'running', updatedAtMs: 5 }),
        entry({ rootKey: 'root-2', status: 'awaitingInput', updatedAtMs: 6 }),
      ],
    })

    expect(useStatusStore.getState().statuses.get(threadStatusKey('proj-a', 'root-1'))?.status).toBe('running')
    expect(useStatusStore.getState().statuses.get(threadStatusKey('proj-a', 'root-2'))?.status).toBe('awaitingInput')
  })

  it('较旧的 updatedAtMs 不会覆盖已经更新的状态（快照与事件的到达顺序不保证，见 store/status.ts 注释）', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([entry({ status: 'done', updatedAtMs: 100 })])
    const { useStatusStore, threadStatusKey } = await freshModule()

    // 模拟一条"迟到"的旧事件（updatedAtMs 早于快照里已有的值）
    handlers['session-status']({ payload: [entry({ status: 'running', updatedAtMs: 50 })] })

    expect(useStatusStore.getState().statuses.get(threadStatusKey('proj-a', 'root-1'))?.status).toBe('done')
  })

  it('不同 (dirName, rootKey) 组合各自独立维护状态，不互相覆盖', async () => {
    getSessionStatusesMock.mockResolvedValueOnce([
      entry({ dirName: 'proj-a', rootKey: 'root-1', status: 'running', updatedAtMs: 1 }),
      entry({ dirName: 'proj-b', rootKey: 'root-1', status: 'done', updatedAtMs: 1 }),
    ])
    const { useStatusStore, threadStatusKey } = await freshModule()

    expect(useStatusStore.getState().statuses.get(threadStatusKey('proj-a', 'root-1'))?.status).toBe('running')
    expect(useStatusStore.getState().statuses.get(threadStatusKey('proj-b', 'root-1'))?.status).toBe('done')
  })
})

describe('aggregateStatus — 项目卡片聚合规则（spec §7）', () => {
  it('任一 running：即使其余是 done/awaitingInput，聚合结果仍是 running', () => {
    expect(aggregateStatus(['done', 'running', 'awaitingInput'])).toBe('running')
  })

  it('没有 running，但任一 awaitingInput：聚合为 awaitingInput', () => {
    expect(aggregateStatus(['done', 'awaitingInput', 'done'])).toBe('awaitingInput')
  })

  it('全部已知状态都是 done：聚合为 done', () => {
    expect(aggregateStatus(['done', 'done'])).toBe('done')
  })

  it('存在未知（undefined）状态，但其余已知状态全是 done：未知不参与判定，仍聚合为 done', () => {
    expect(aggregateStatus(['done', undefined, 'done'])).toBe('done')
  })

  it('没有任何已知状态：聚合为 unknown（不猜色，见 StatusDot 渲染测试）', () => {
    expect(aggregateStatus([undefined, undefined])).toBe('unknown')
  })

  it('空数组（项目没有任何会话）：聚合为 unknown', () => {
    expect(aggregateStatus([])).toBe('unknown')
  })
})
