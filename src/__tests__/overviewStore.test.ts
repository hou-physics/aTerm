import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blockKey, useOverviewStore } from '../store/overview'

const t = (rootKey: string, ms: number) => ({ rootKey, lastActivityMs: ms })

beforeEach(() => {
  localStorage.clear()
  useOverviewStore.setState({ order: {}, positions: {}, names: {} })
})

describe('排序快照（spec §5.2：打开时按最后活动时间新→旧，打开期间不重排）', () => {
  it('首次捕获按时间新→旧', () => {
    useOverviewStore.getState().captureOrder('proj', [t('a', 100), t('b', 300), t('c', 200)])
    expect(useOverviewStore.getState().order.proj).toEqual([
      blockKey('proj', 'b'), blockKey('proj', 'c'), blockKey('proj', 'a'),
    ])
  })

  it('已有快照时不因时间变化而重排', () => {
    const s = useOverviewStore.getState()
    s.captureOrder('proj', [t('a', 100), t('b', 300)])
    const before = useOverviewStore.getState().order.proj
    s.captureOrder('proj', [t('a', 999_999), t('b', 300)]) // a 变成最新
    expect(useOverviewStore.getState().order.proj).toEqual(before)
  })

  it('新出现的会话追加到快照末尾，不打乱既有顺序', () => {
    const s = useOverviewStore.getState()
    s.captureOrder('proj', [t('a', 100), t('b', 300)])
    s.captureOrder('proj', [t('a', 100), t('b', 300), t('新', 50)])
    expect(useOverviewStore.getState().order.proj).toEqual([
      blockKey('proj', 'b'), blockKey('proj', 'a'), blockKey('proj', '新'),
    ])
  })

  it('消失的会话从快照中移除', () => {
    const s = useOverviewStore.getState()
    s.captureOrder('proj', [t('a', 100), t('b', 300)])
    s.captureOrder('proj', [t('b', 300)])
    expect(useOverviewStore.getState().order.proj).toEqual([blockKey('proj', 'b')])
  })
})

describe('clearOrder（Task 8 ruling：新建总览标签时清快照，让方块重新按活跃度排序）', () => {
  it('清除后该 dirName 没有快照，下一次 captureOrder 按当前活动时间重新建立顺序', () => {
    const s = useOverviewStore.getState()
    s.captureOrder('proj', [t('a', 100), t('b', 300)])

    s.clearOrder('proj')
    expect(useOverviewStore.getState().order.proj).toBeUndefined()

    s.captureOrder('proj', [t('a', 999_999), t('b', 300)]) // a 现在最新
    expect(useOverviewStore.getState().order.proj).toEqual([
      blockKey('proj', 'a'), blockKey('proj', 'b'),
    ])
  })

  it('不影响其它项目的快照', () => {
    const s = useOverviewStore.getState()
    s.captureOrder('proj-a', [t('a', 100)])
    s.captureOrder('proj-b', [t('b', 200)])

    s.clearOrder('proj-a')

    expect(useOverviewStore.getState().order['proj-a']).toBeUndefined()
    expect(useOverviewStore.getState().order['proj-b']).toEqual([blockKey('proj-b', 'b')])
  })

  it('对没有快照的项目是安全的空操作', () => {
    const s = useOverviewStore.getState()
    expect(() => s.clearOrder('never-opened')).not.toThrow()
    expect(useOverviewStore.getState().order['never-opened']).toBeUndefined()
  })
})

describe('位置：拖拽中只改内存，落手才持久化（沿用项目既有两动作范式）', () => {
  it('setPosition 不写 localStorage', () => {
    useOverviewStore.getState().setPosition('k', { x: 10, y: 20 })
    expect(useOverviewStore.getState().positions.k).toEqual({ x: 10, y: 20 })
    expect(localStorage.getItem('aterm.overview.positions')).toBeNull()
  })

  it('commitPosition 写入 localStorage', () => {
    useOverviewStore.getState().commitPosition('k', { x: 10, y: 20 })
    expect(JSON.parse(localStorage.getItem('aterm.overview.positions')!)).toEqual({ k: { x: 10, y: 20 } })
  })
})

describe('重命名', () => {
  it('rename 持久化，clearName 恢复默认标题', () => {
    const s = useOverviewStore.getState()
    s.rename('k', '我的重构任务')
    expect(JSON.parse(localStorage.getItem('aterm.overview.names')!)).toEqual({ k: '我的重构任务' })
    s.clearName('k')
    expect(useOverviewStore.getState().names.k).toBeUndefined()
  })

  it('空白名字视为清除，不留下空标题的方块', () => {
    const s = useOverviewStore.getState()
    s.rename('k', '   ')
    expect(useOverviewStore.getState().names.k).toBeUndefined()
  })

  // 终审：空白规则此前只对"全空白"做了特判，非空名字的两侧填充原样落盘——
  // `"  我的任务  "` 会带着空格持久化，之后每次渲染都带着空格显示，用户既看不出多的
  // 是什么、也删不掉。trim 放在 rename 的第一步，这条规则因此对全空白和两侧填充是
  // 同一条，不再是特例。
  it('非空名字两侧的空白同样被 trim，不带着空格落盘', () => {
    const s = useOverviewStore.getState()
    s.rename('k', '  我的任务  ')
    expect(useOverviewStore.getState().names.k).toBe('我的任务')
    expect(JSON.parse(localStorage.getItem('aterm.overview.names')!)).toEqual({ k: '我的任务' })
  })
})

describe('持久化读回的健壮性', () => {
  it('localStorage 内容损坏时回退为空，不抛异常', async () => {
    localStorage.setItem('aterm.overview.positions', '{ 这不是 JSON')
    vi.resetModules()
    const fresh = await import('../store/overview')
    expect(fresh.useOverviewStore.getState().positions).toEqual({})
  })
})
