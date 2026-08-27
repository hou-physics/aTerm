// 拖拽清理的窗口级兜底：TabBar.tsx（拖标签）、Sidebar.tsx（拖「最近会话」）、
// TabPanes.tsx（拖窗格标题栏）三处拖拽源共用。
//
// 背景（.superpowers/drag-cleanup-report.md 的"关切点"）：三处已有的 lostpointercapture
// 处理器走的是 React 的合成事件委托——原生事件要先冒泡到 React 挂载的根容器节点，
// React 才能据此调用组件的 onLostPointerCapture prop。如果浏览器是在被拖元素已经从
// DOM 树里摘除之后才派发这个事件（规范允许这种时序，具体时机是各浏览器实现细节），
// 冒泡路径上就不再包含根容器节点，这个 prop 可能根本收不到它。真实触发场景：
// Sidebar 的「最近会话」列表在 window focus 时 refresh()，可能把正被拖拽的那一条
// 会话挤出 top-12，其 DOM 节点因而在拖拽中途消失，而 Sidebar 组件本身仍然挂载（不
// 会触发组件卸载那一层兜底）。指针捕获丢失的时序不可靠，窗口级监听不依赖被拖元素是否
// 仍在 DOM 中，是最后一道保险——在 lostpointercapture 处理器与组件卸载兜底之外的
// 第三层防御，三者互为补充，不是互相替代。
//
// 用 capture:true 挂在 window 上：window 是事件捕获阶段路径的最顶端，这样即便下游
// 某个元素调用了 stopPropagation()，这张网也已经在事件到达那个元素之前就看到了它。
//
// 但正因为捕获阶段必然先于 React 委托所在的冒泡阶段跑完，这里不能在监听器里同步调用
// endDrag()：一次正常收尾的拖拽（元素仍在 DOM 里，事件按预期冒泡）会先经过这里，如果
// 同步清空 dragRef/useDnd 状态，随后才轮到的组件自身 onPointerUp 处理器就会读到一片
// 空状态，把这次成功的拖拽悄悄变成空操作（合并/排序/移出窗格全部不生效）——这是"网"
// 自己把合法拖拽提前打断的风险，必须避免，不能照字面直接在监听器里同步调用 endDrag()。
// 用 queueMicrotask 把实际的 endDrag() 调用推迟到本次事件的同步派发（捕获 + 目标 +
// 冒泡三个阶段全部在同一个 dispatchEvent 调用栈内完成，中间不会被微任务打断）结束
// 之后：如果组件自己的处理器已经在这次派发里正常跑完并调用过 endDrag()，`isDragActive()`
// 此时已经是 false，这里直接跳过，不产生任何多余效果；只有在正常路径确实没跑（真正
// 需要兜底的场景）时，它才仍然是 true，兜底才会真正生效。
//
// pointerId 过滤：pointerup/pointercancel 只在事件的 pointerId 与发起这次拖拽的
// pointerId 一致时才触发兜底——避免多点触控等场景下，一次与本次拖拽无关的指针抬起
// 提前打断仍在进行中的合法拖拽（同样是"网把合法拖拽提前打断"的风险，只是触发方式不同）。
// blur 没有 pointerId 的概念，窗口整体失焦（例如 ⌘Tab 切到另一个 App）本身就是一个
// 足够明确的"应当中止拖拽"信号，不需要过滤、也不存在与"正常收尾"竞争的问题，但为了
// 三个事件走同一套简单心智模型，同样经 queueMicrotask 延后判断，不做特殊处理。
export function attachDragSafetyNet(pointerId: number, isDragActive: () => boolean, endDrag: () => void): () => void {
  const trigger = () => {
    queueMicrotask(() => {
      if (isDragActive()) endDrag()
    })
  }
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === pointerId) trigger()
  }
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId === pointerId) trigger()
  }
  const onBlur = () => trigger()

  window.addEventListener('pointerup', onPointerUp, { capture: true })
  window.addEventListener('pointercancel', onPointerCancel, { capture: true })
  window.addEventListener('blur', onBlur, { capture: true })

  return () => {
    window.removeEventListener('pointerup', onPointerUp, { capture: true })
    window.removeEventListener('pointercancel', onPointerCancel, { capture: true })
    window.removeEventListener('blur', onBlur, { capture: true })
  }
}
