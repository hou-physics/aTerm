// ipc.ts 里 ptyResize 顺带记下的「本窗口最近一次为该 PTY 请求过的尺寸」（V3.3 Task 4
// R2/I4）。
//
// 为什么值得单独测：这份记录是拖出交接回滚路径的唯一尺寸来源——真实几何只存在于受保护
// 文件 TerminalView.tsx 内部的局部变量里，本任务不得改动它。如果 ptyResize 哪天被重构成
// 不再记录（例如"简化"成直接 invoke），lastPtySize 会恒返回 undefined，回滚里那段拧尺寸
// 的代码就静默变成空操作：没有报错、没有失败的用例，只有用户在交接失败之后看到一个折行
// 错乱的终端。本仓库对"静默失效"有过血的教训（core:window:allow-set-size 那次），这里
// 单独钉住。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { lastPtySize, ptyResize } from '../ipc'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ipc.ptyResize / lastPtySize', () => {
  it('从未请求过的 PTY 返回 undefined（不是 0×0 之类的假值）', () => {
    expect(lastPtySize('never-resized')).toBeUndefined()
  })

  it('请求过之后记下这次的 cols/rows', async () => {
    // 初始值必须与目标值不同——这里是 undefined vs 有值，天然满足。
    expect(lastPtySize('p-a')).toBeUndefined()
    await ptyResize('p-a', 203, 51)
    expect(lastPtySize('p-a')).toEqual({ cols: 203, rows: 51 })
  })

  it('记的是**最近**一次，不是第一次', async () => {
    await ptyResize('p-b', 80, 24)
    await ptyResize('p-b', 160, 48)
    expect(lastPtySize('p-b')).toEqual({ cols: 160, rows: 48 })
  })

  it('按 PTY 分开记，互不覆盖', async () => {
    await ptyResize('p-c', 100, 30)
    await ptyResize('p-d', 200, 60)
    expect(lastPtySize('p-c')).toEqual({ cols: 100, rows: 30 })
    expect(lastPtySize('p-d')).toEqual({ cols: 200, rows: 60 })
  })

  it('记录之外，该发的 IPC 一个都不少（不是把 invoke 换成了记账）', async () => {
    await ptyResize('p-e', 120, 40)
    expect(invokeMock).toHaveBeenCalledWith('pty_resize', { id: 'p-e', cols: 120, rows: 40 })
  })
})
