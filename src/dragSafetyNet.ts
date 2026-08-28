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
// 足够明确的"应当中止拖拽"信号，不需要按 pointerId 过滤、也不存在与"正常收尾"竞争的
// 问题，但同样经 queueMicrotask 延后判断（三个事件共用同一套简单心智模型）。
//
// 【重要】blur 绝不能像上面两个事件那样用 capture:true——这不是风格问题，是曾经真实
// 导致"所有拖拽都失效"的一次回归的根因。pointerup/pointercancel 是会冒泡的事件，
// capture:true 只是让这张网在冒泡阶段之前先看到它们，不改变"谁能看到"这件事本身
// （不管捕不捕获，pointerup/pointercancel 最终都会经过 window）。blur 不一样：blur
// 不冒泡，但"不冒泡"只挡住了冒泡阶段，挡不住捕获阶段——捕获阶段是从 window 往下走到
// 事件目标的，不管目标是谁、目标的事件冒不冒泡，捕获阶段都必然先经过 window。于是
// capture:true 的 window blur 监听器实际收到的是"文档树里任意元素的 blur"，不是
// "窗口整体失焦"：pointerdown 之后，浏览器把焦点从此前聚焦的元素（例如 xterm 的隐藏
// textarea）移开是完全正常的一步，这一步产生的普通元素 blur 会被这张网误判成"应当
// 中止拖拽"，在第一次 pointermove 发生之前就把 dragRef 清空——拖拽因此从未真正开始。
// 三处拖拽源（TabBar/Sidebar/TabPanes）共用这一张网，症状是全局性的"所有拖拽都失效"。
//
// 正确写法是不传 capture（等价于 capture:false，冒泡阶段/目标阶段监听）：blur 不冒泡，
// 因此一个非捕获阶段的 window 监听器只会在 window 自己就是事件目标时才被调用——这正是
// "窗口整体失焦"的准确定义，不多不少。再加一层显式的目标判定（见 onBlur）纯粹是为了
// "写在代码里、不依赖别人记住这段注释"：万一将来有人把这个监听器改挂到 document 上，
// 或者不小心又给它加回 capture:true，这层判定依然能挡住"目标不是 window"的调用，
// 不会重演这次回归。判定没有直接写 `e.target === window`：这个模块作用域里能拿到的
// `window` 引用，和事件分发算法内部用来生成 target 的 window 对象，未必是同一个引用
// ——例如本仓库的 vitest+jsdom 单测环境就是这样，`window.dispatchEvent(...)` 内部
// 派发时使用的 window 对象与测试/源码里 `window` 这个全局变量并不是同一个对象引用
// （语义上是同一个"窗口"，但 `===` 比较为 false）。因此改用一条对任何 Window 对象都
// 成立、对任何 DOM 节点都不成立的不变式：Window 对象的 `.window` getter 恒等于自身，
// DOM 节点根本没有这个属性（读出来是 undefined）。两条判据（字面比较 + 自指不变式）
// 任一成立就够，字面比较留着是因为它是最直接、最不需要解释的第一直觉。
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
  const onBlur = (e: FocusEvent) => {
    const target = e.target as (EventTarget & { window?: unknown }) | null
    const isWindowItself = target === (window as unknown as EventTarget) || (!!target && target.window === target)
    if (!isWindowItself) return
    trigger()
  }

  window.addEventListener('pointerup', onPointerUp, { capture: true })
  window.addEventListener('pointercancel', onPointerCancel, { capture: true })
  // 不传 capture——原因见上方大段注释，这是这次修复的关键一行。
  window.addEventListener('blur', onBlur)

  return () => {
    window.removeEventListener('pointerup', onPointerUp, { capture: true })
    window.removeEventListener('pointercancel', onPointerCancel, { capture: true })
    window.removeEventListener('blur', onBlur)
  }
}
