import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { computeWrapperStyles, type Rect, type WrapperStyle } from '../paneGeometry'
import { useTabs } from '../store/tabs'
import { TerminalView } from './TerminalView'

type Entry = {
  tabId: string
  paneId: string
  ptyId: string
  isActiveTab: boolean
  focused: boolean
  // 该窗格所属标签是否渲染了标题栏（多窗格时才有，见 TabPanes.tsx 的 showTitlebar）。
  // 只用来决定包裹层要不要把顶部两个圆角也裁掉——见下方 TerminalWrapper 的注释。
  showTitlebar: boolean
}

// 单个窗格的终端包裹层：position:absolute，尺寸/位置由 TerminalLayer 按插槽几何算出后
// 内联写入；还没测到几何（刚挂载、或所属标签当前不是激活标签）时 display:none——
// TerminalView 内部 `el.clientWidth === 0` 的既有判断本就会因此跳过 fit/resize（见该
// 文件的 resizeFrame/fontSizeFrame 两处守卫），这里不需要再加第二道尺寸判断。
//
// onPointerDownCapture 复刻 TabPanes.tsx 里 PaneItem 对 `.pane` 的同一条"点击窗格内
// 任意位置即聚焦"逻辑（设计文档 §6）：终端本身现在渲染在这一层而不是 `.pane` 子树内，
// `.pane` 的捕获监听器不再是终端点击事件的 DOM 祖先，必须在这里单独接一份，否则点击
// 终端将不再聚焦窗格——这是重构前就有的可见行为，必须原样保住，不是新增行为。
//
// borderRadius 按 showTitlebar 二选一：单窗格（无标题栏）时插槽就是整个 `.pane` 的内部
// 区域，四角都曾被 `.pane` 的 `border-radius:4px; overflow:hidden` 裁过一点；多窗格
// （有标题栏）时插槽只是标题栏下方那块，原来只有底部两角落在 `.pane` 的裁剪弧线内，
// 顶部两角紧贴标题栏底边、本就是直角。半径写 3px 而非 4px：`.pane` 有 1px 边框，
// overflow:hidden 实际裁剪的是 padding-box，其内圆角半径按规范是 border-radius 减去
// 边框宽度（4-1=3），这里照实还原，避免终端四角与 `.pane` 描边角出现肉眼可辨的错位。
function TerminalWrapper({ tabId, paneId, ptyId, isActiveTab, focused, showTitlebar, style }: Entry & { style: WrapperStyle | undefined }) {
  const onPointerDownCapture = useCallback(() => {
    if (!focused) useTabs.getState().focusPane(tabId, paneId)
  }, [tabId, paneId, focused])

  const wrapperStyle: CSSProperties =
    isActiveTab && style
      ? {
          display: 'block',
          top: style.top,
          left: style.left,
          width: style.width,
          height: style.height,
          borderRadius: showTitlebar ? '0 0 3px 3px' : '3px',
        }
      : { display: 'none' }

  return (
    <div className="terminal-wrapper" style={wrapperStyle} onPointerDownCapture={onPointerDownCapture}>
      <TerminalView ptyId={ptyId} active={isActiveTab && focused} />
    </div>
  )
}

// 扁平终端层：整个应用只挂载一份，在 App.tsx 里与各标签的 TabPanes 同级渲染在 `.content`
// 内（而不是嵌套在某个标签自己的子树里）——这正是本次重构的核心：不管标签切换还是
// 窗格增删，这里渲染的每个 <TerminalWrapper> 都以 pane.id 为 key，只要该窗格仍然存在
// 就绝不卸载，xterm 实例与其内部回滚缓冲因此不会再因为布局变化（未来的"把窗格拖进
// 另一个标签"）被销毁重建。
//
// 每个包裹层的位置/尺寸来自它对应窗格插槽（TabPanes.tsx 渲染的
// `.pane-body[data-pane-slot]`，现在只是几何占位，不再包含终端）当前的
// getBoundingClientRect()，减去容器（`.content`，position:relative，见 App.css）自身的
// rect——具体换算见 paneGeometry.ts。只测量"当前激活标签、且持有 PTY"的窗格插槽：
// 非激活标签的插槽本就 display:none（见 TabPanes.tsx 的 `.term-wrap`），量出来也是
// 全 0，量了白量，直接跳过；这也是"非激活标签的终端不参与重排"这条要求的落地方式，
// 不需要再加一道显式判断。
export function TerminalLayer({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const tabs = useTabs((s) => s.tabs)
  const activeId = useTabs((s) => s.activeId)

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = []
    for (const t of tabs) {
      if (t.kind !== 'term') continue
      const showTitlebar = t.panes.length > 1
      for (const p of t.panes) {
        if (!p.ptyId) continue
        out.push({ tabId: t.id, paneId: p.id, ptyId: p.ptyId, isActiveTab: t.id === activeId, focused: t.activePaneId === p.id, showTitlebar })
      }
    }
    return out
  }, [tabs, activeId])

  // 只有"当前激活标签持有哪些窗格"这个子集需要被观察/重算；这个数组只要内容不变就
  // 保持同一引用（entries 本身在 tabs/activeId 未变时也是同一引用，见上面的 useMemo）。
  const activePaneIds = useMemo(() => entries.filter((e) => e.isActiveTab).map((e) => e.paneId), [entries])

  const [styles, setStyles] = useState<Map<string, WrapperStyle>>(() => new Map())

  const recompute = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const rects = new Map<string, Rect>()
    for (const paneId of activePaneIds) {
      const el = container.querySelector<HTMLElement>(`[data-pane-slot="${paneId}"]`)
      if (el) rects.set(paneId, el.getBoundingClientRect())
    }
    const computed = computeWrapperStyles(rects, containerRect)
    // 合并而非整体替换：切走的标签下次切回来、几何没变时，直接沿用上次量出的坐标，
    // 不必等一帧 rAF 才补上正确位置（减少标签切换时的闪烁）。
    setStyles((prev) => {
      const next = new Map(prev)
      computed.forEach((s, paneId) => next.set(paneId, s))
      return next
    })
  }, [activePaneIds, containerRef])

  const frameRef = useRef(0)
  const scheduleRecompute = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      recompute()
    })
  }, [recompute])

  // 结构性变化（标签切换、窗格增删）：同步测一次，赶在浏览器上屏前算好位置，避免
  // "先 display:none 一帧、下一帧才补上正确坐标"的闪烁——与下面 ResizeObserver 驱动的
  // 连续几何变化（拖拽分隔条、窗口缩放等）刻意分成两条路径，后者才是"合并进
  // requestAnimationFrame"这条要求真正要覆盖的对象。
  //
  // 注意：首次挂载这一帧，这个同步调用几乎总会是空操作。TerminalLayer 和它的容器
  // （App.tsx 的 `.content`）在同一次 commit 里一起挂载时，React 对宿主节点 ref 的
  // 绑定与整棵树 useLayoutEffect 的调用走的是同一趟自底向上遍历；作为 `.content` 的
  // 后代，本组件的 useLayoutEffect 必然先于 `.content` 自己的 ref 绑定执行，届时
  // containerRef.current 还是 null（上面 recompute() 里的 `if (!container) return`
  // 会静默跳过）。真正兜底首次挂载的是下面那个 useEffect——它是 passive effect，
  // 在全树所有 layout effect（含祖先的 ref 绑定）都跑完之后才执行，届时
  // containerRef.current 必定已经就绪。这里仍然保留这个 useLayoutEffect：对"容器早已
  // 存在"的后续场景（标签切换、窗格增删）它能同步生效，真正做到不闪烁；只有"容器与
  // 本组件同帧首次挂载"这一种情况需要靠下面的 effect 补救。
  useLayoutEffect(() => {
    recompute()
  }, [recompute])

  // 连续几何变化：分隔条拖拽、对话面板收起/展开/拖宽、侧边栏收起/展开、窗口缩放，
  // 最终都会改变某个插槽或容器自身的尺寸——盯着插槽与容器各自的 ResizeObserver 就足够
  // 覆盖全部来源，不需要分别去监听每一种触发它们的 UI 操作。多次连续触发合并进同一个
  // requestAnimationFrame（与 TerminalView.tsx 自己的 resize/字号 effect、
  // ConversationPanel.tsx 的拖拽同一套节流克制），卸载 / 依赖变化时清掉挂起的帧。
  //
  // 这里额外同步调用一次 recompute()（不经过 rAF）：如上面 useLayoutEffect 注释所述，
  // 这是"容器与本组件同帧首次挂载"这种情况下唯一能正确测到几何的时机——这个 effect
  // 本身是 passive effect，晚于全树的 ref 绑定，此刻 containerRef.current 一定已经
  // 就绪。对容器早已存在的场景（标签切换等），这次调用只是与上面的 useLayoutEffect
  // 重复算一遍同样的结果，无害，也不会闪烁（同一帧内两次写入同样的值）。
  useEffect(() => {
    recompute()
    // jsdom 测试环境没有 ResizeObserver 这个全局（真实 Tauri 窗口里恒有）；这里只是
    // 优雅跳过连续观察这条路径——上面的同步 recompute() 与 paneGeometry.ts 的纯函数
    // 测试已经覆盖了这层逻辑本身，不需要在测试里也构造一个 polyfill。
    if (typeof ResizeObserver === 'undefined') return undefined
    const container = containerRef.current
    const ro = new ResizeObserver(() => scheduleRecompute())
    if (container) {
      ro.observe(container)
      for (const paneId of activePaneIds) {
        const el = container.querySelector<HTMLElement>(`[data-pane-slot="${paneId}"]`)
        if (el) ro.observe(el)
      }
    }
    return () => {
      if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = 0 }
      ro.disconnect()
    }
  }, [activePaneIds, recompute, scheduleRecompute, containerRef])

  return (
    <>
      {entries.map((e) => (
        <TerminalWrapper key={e.paneId} {...e} style={styles.get(e.paneId)} />
      ))}
    </>
  )
}
