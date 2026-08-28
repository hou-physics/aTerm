import { useLayoutEffect, useState, type RefObject } from 'react'
import { dropIndicatorPreviewRect } from '../paneDrop'
import { slotToWrapperStyle, type WrapperStyle } from '../paneGeometry'
import { useDnd } from '../store/dnd'

// 拖放落点指示（设计文档 §5-B "拖拽过程中显示落点指示（半透明色块，使用既有变量）"，
// 本次修复的 Fix 2/3 在此基础上补两件事：'fill' 语义下覆盖整个窗格而不是切半——见
// dropIndicatorPreviewRect；此刻若会被拒绝，切换成"拒绝"视觉并持续显示具体理由，
// 不再让用户等到松手才知道，见下方 refusal）：半透明色块覆盖目标窗格（整个或左/
// 右半，取决于落点语义），随 TabBar.tsx（场景 A）/ Sidebar.tsx（场景 B）的拖拽处理器
// 实时写入 store/dnd.ts 的 target/dropMode/refusal 更新。与 TerminalLayer.tsx 共享
// 同一套"插槽矩形 -> 容器相对坐标"换算（paneGeometry.ts 的 slotToWrapperStyle，只
// 消费，不改动那个文件——任务要求"你可以使用它，不能重写它"），但不需要它那套
// ResizeObserver/rAF 节流：拖拽期间每次 pointermove 本身就是更新节奏，没有独立于
// 指针输入之外的连续几何变化需要跟踪（真要发生窗口 resize 这种极端情况，下一次
// pointermove 也会立刻纠正过来，不值得为这个边角案例加一整套观察者）。
export function DropIndicator({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const target = useDnd((s) => s.target)
  const dropMode = useDnd((s) => s.dropMode)
  const refusal = useDnd((s) => s.refusal)
  const [style, setStyle] = useState<WrapperStyle | null>(null)

  useLayoutEffect(() => {
    if (!target || !dropMode) {
      setStyle(null)
      return
    }
    const container = containerRef.current
    const el = document.querySelector<HTMLElement>(`[data-pane-id="${target.paneId}"]`)
    if (!container || !el) {
      setStyle(null)
      return
    }
    const rect = dropIndicatorPreviewRect(el.getBoundingClientRect(), dropMode, target.side)
    setStyle(slotToWrapperStyle(rect, container.getBoundingClientRect()))
  }, [target, dropMode, containerRef])

  if (!style) return null
  const refused = refusal !== null
  return (
    <div
      className={`pane-drop-indicator${refused ? ' pane-drop-indicator-refused' : ''}`}
      style={{ top: style.top, left: style.left, width: style.width, height: style.height }}
    >
      {/* 拒绝理由：与半透明底色是两个独立盒子（底色用 ::before 承载，见 App.css）
          ——不能把文字塞进那个带 opacity 的元素本身，父级 opacity 会连带把文字也
          变淡，读起来比底色本身还费劲。 */}
      {refused && <span className="pane-drop-reason">{refusal.reason}</span>}
    </div>
  )
}
