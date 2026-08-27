import { useDragGhost } from '../store/dragGhost'

// 跟随光标的拖拽指示（用户明确反馈"拖拽过程中没有任何视觉反馈，感觉不像在拖东西"）：
// 显示正在拖拽的标签/窗格/会话标题，半透明、pointer-events:none（绝不拦截拖拽过程中
// 持续发生的指针事件——三个拖拽源都用 setPointerCapture 接管，这一点与
// .pane-drop-indicator/.tabbar-drop-indicator 同理）。position:fixed 直接用视口坐标
// 定位，不需要像 DropIndicator.tsx 那样再减去某个祖先容器的偏移——挂在哪里都一样，
// 因此不必是 `.content` 的同级子节点，App.tsx 里随意选了一处渲染。
//
// x/y 由 store/dragGhost.ts 的 move() 经 requestAnimationFrame 合并写入（同一套"拖拽源
// 实时写、这里只读"模式，与 useDnd 的 target/tabBarIndex 一致）；向右下偏移 12px，
// 避免指示本身正好压在光标与其下方的落点之上。
export function DragGhost() {
  const visible = useDragGhost((s) => s.visible)
  const label = useDragGhost((s) => s.label)
  const x = useDragGhost((s) => s.x)
  const y = useDragGhost((s) => s.y)

  if (!visible) return null
  return (
    <div className="drag-ghost" style={{ transform: `translate(${x + 12}px, ${y + 12}px)` }}>
      {label}
    </div>
  )
}
