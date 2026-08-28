// 尾沿节流：把一串密集触发合并成"每 intervalMs 至多跑一次"。
//
// 用途见 App.tsx：会话元数据（模型 / effort / 上下文用量 / 预览行 / 标题）只在
// 挂载与 window focus 时刷新，而用户待在 aTerm 里面时窗口从不失焦，元数据因此
// 一启动就冻住。FSEvents 推来的 `session-status` 事件恰好标志"转录变了"，是天然
// 的刷新时机——但每条事件都刷不行：refresh() 会对每个项目的每个转录文件做一次
// 头尾读取，而运行中的会话每 120ms 就可能推一条事件。
//
// 选尾沿而非前沿：转录刚被追加的那一刻，尾部往往还是半行（parse_meta 读到的仍是
// 上一轮的值），等一会儿再读拿到的才是稳定结果。
export type Throttled = { trigger(): void; cancel(): void }

export function createTrailingThrottle(
  fn: () => void,
  intervalMs: number,
  now: () => number = Date.now,
): Throttled {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRun = Number.NEGATIVE_INFINITY

  return {
    trigger() {
      if (timer !== null) return // 已有待跑的一次，本次触发被合并进去
      const wait = Math.max(0, intervalMs - (now() - lastRun))
      timer = setTimeout(() => {
        timer = null
        lastRun = now()
        fn()
      }, wait)
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
