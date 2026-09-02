import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// 通用右键菜单（最初为窗格标题栏「移出为独立标签 / 关闭窗格」而建，见设计文档 §5-C；
// 标签栏的「拆分为独立标签 / 关闭标签」直接复用同一个组件，不写第二份——两处菜单唯一
// 的区别只是传入的 items 不同）。没有任何既有的右键菜单基础设施可复用，这里是一个
// 自包含的小组件，不引入第三方菜单库。
//
// 用 createPortal 挂到 document.body 下，而不是留在调用方的 DOM 子树里（本次修复，见
// .superpowers/context-menu-portal-report.md）：调用方（PaneTitleBar/TabBar 的标签
// 条目）同时是"把窗格/标签拖出去"的拖拽手柄，pointerdown 时会 setPointerCapture 接管
// 该指针后续的事件。此前菜单是手柄的 DOM 子节点，点击菜单项的 pointerdown 会先冒泡
// 经过手柄——position:fixed 只改变视觉位置，不改变它在 DOM 树里仍是手柄后代这一
// 事实。手柄一旦对这次指针 setPointerCapture，真实浏览器里随后的 pointerup（进而
// 派生出的合成 click）会被重定向到手柄本身，菜单项自己的 click 再也发不出来——这与
// 上一轮"pointerdown 上无条件 preventDefault 抑制 click"是同一处代码、不同的两种
// 抑制机制（后者已经在那一轮修复；这一轮是前者）。portal 到 document.body 之后，
// 菜单在 DOM 树里不再是任何拖拽手柄的后代，这一整类问题不会再发生（调用方也仍然各自
// 加了一层 `.closest('.context-menu')` 早退分支作为纵深防御，见 TabPanes.tsx/
// TabBar.tsx/Sidebar.tsx 的 pointerdown 处理器）。
//
// 出现后量一次自身尺寸，钳在视口范围内（右/下边缘不会被裁出屏幕）——首次渲染时先按
// 光标原始坐标画一帧，量出真实尺寸后用 useLayoutEffect 在同一次浏览器绘制前纠正，
// 不会闪烁；量不到（尺寸为 0，理论上不应发生）时按原坐标显示，不做任何钳制。
//
// 关闭方式三种都要覆盖：点击菜单外部、Escape、窗口失焦——都只是"取消"，不触发任何
// 菜单项本身的动作。outside-click 判定用真实 DOM 的 ref.current.contains()，portal
// 只改变节点在树里的父级，不改变它仍是一个真实 DOM 节点这一事实，判定逻辑不用跟着改。
export type ContextMenuItem = { label: string; onSelect: () => void }

export function ContextMenu({
  x,
  y,
  items,
  onDismiss,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { offsetWidth: w, offsetHeight: h } = el
    if (w === 0 && h === 0) return
    const clampedX = Math.max(4, Math.min(x, window.innerWidth - w - 4))
    const clampedY = Math.max(4, Math.min(y, window.innerHeight - h - 4))
    setPos({ x: clampedX, y: clampedY })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    // 捕获阶段：菜单出现的这次 pointerdown 本身（触发右键的那次）不该立刻被当成
    // "外部点击"关掉菜单——用 setTimeout 0 把监听器的注册推迟到当前事件循环之后，
    // 与 SettingsPanel.tsx 遮罩关闭同一 idiom（下一个 tick 才开始监听；PanePicker.tsx
    // 没有这类"点外面关闭"逻辑，不适用）。Task 5 之前这里还提过 ThemeSwitcher.tsx，
    // 但那是三处"点外面关闭"里唯一没有这层 setTimeout(0) 守卫的一个（挂在 window 而非
    // document、未传 capture），该文件已随 Task 5 删除，不再作为参考样板。
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('blur', onDismiss)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onDismiss)
    }
  }, [onDismiss])

  return createPortal(
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((item) => (
        <div
          key={item.label}
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            item.onSelect()
            onDismiss()
          }}
        >
          {item.label}
        </div>
      ))}
    </div>,
    document.body,
  )
}
