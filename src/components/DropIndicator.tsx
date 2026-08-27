import { useLayoutEffect, useState, type RefObject } from 'react'
import { dropIndicatorRect } from '../paneDrop'
import { slotToWrapperStyle, type WrapperStyle } from '../paneGeometry'
import { useDnd } from '../store/dnd'

// 拖放落点指示（设计文档 §5-B "拖拽过程中显示落点指示（半透明色块，使用既有变量）"）：
// 半透明色块覆盖目标窗格的左半或右半，随 TabBar.tsx（场景 A）/ Sidebar.tsx（场景 B）
// 的拖拽处理器实时写入 store/dnd.ts 的 target 更新。与 TerminalLayer.tsx 共享同一套
// "插槽矩形 -> 容器相对坐标"换算（paneGeometry.ts 的 slotToWrapperStyle，只消费，不
// 改动那个文件——任务要求"你可以使用它，不能重写它"），但不需要它那套
// ResizeObserver/rAF 节流：拖拽期间每次 pointermove 本身就是更新节奏，没有独立于
// 指针输入之外的连续几何变化需要跟踪（真要发生窗口 resize 这种极端情况，下一次
// pointermove 也会立刻纠正过来，不值得为这个边角案例加一整套观察者）。
export function DropIndicator({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const target = useDnd((s) => s.target)
  const [style, setStyle] = useState<WrapperStyle | null>(null)

  useLayoutEffect(() => {
    if (!target) {
      setStyle(null)
      return
    }
    const container = containerRef.current
    const el = document.querySelector<HTMLElement>(`[data-pane-id="${target.paneId}"]`)
    if (!container || !el) {
      setStyle(null)
      return
    }
    const half = dropIndicatorRect(el.getBoundingClientRect(), target.side)
    setStyle(slotToWrapperStyle(half, container.getBoundingClientRect()))
  }, [target, containerRef])

  if (!style) return null
  return (
    <div
      className="pane-drop-indicator"
      style={{ top: style.top, left: style.left, width: style.width, height: style.height }}
    />
  )
}
