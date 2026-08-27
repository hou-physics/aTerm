import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// 通用右键菜单（最初为窗格标题栏「移出为独立标签 / 关闭窗格」而建，见设计文档 §5-C；
// 标签栏的「拆分为独立标签 / 关闭标签」直接复用同一个组件，不写第二份——两处菜单唯一
// 的区别只是传入的 items 不同）。没有任何既有的右键菜单基础设施可复用，这里是一个
// 自包含的小组件，不引入第三方菜单库。挂在调用方的 DOM 子树里（不是 portal 到
// document.body——纯 position:fixed 定位到光标处即可，不需要脱离父级子树；调用方的
// 拖拽手柄 pointerdown 处理器因此不能在 pointerdown 上无条件 preventDefault，否则会
// 抑制点击菜单项时冒泡经过手柄的这次 pointerdown 对应的合成 click，见
// store/dragGhost.ts 的 blockSelect() 与 .superpowers/tab-menu-reorder-report.md）。
//
// 出现后量一次自身尺寸，钳在视口范围内（右/下边缘不会被裁出屏幕）——首次渲染时先按
// 光标原始坐标画一帧，量出真实尺寸后用 useLayoutEffect 在同一次浏览器绘制前纠正，
// 不会闪烁；量不到（尺寸为 0，理论上不应发生）时按原坐标显示，不做任何钳制。
//
// 关闭方式三种都要覆盖：点击菜单外部、Escape、窗口失焦——都只是"取消"，不触发任何
// 菜单项本身的动作。
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
    // 与 ThemeSwitcher.tsx/PanePicker.tsx 若有同类"点外面关闭"逻辑的既有做法一致
    // （这里没有可直接复用的既有实现，采用同一常见 idiom：下一个 tick 才开始监听）。
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

  return (
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
    </div>
  )
}
