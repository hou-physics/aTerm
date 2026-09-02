// 当前窗口的身份（V3.3 多窗口）。
//
// 单独成模块的理由：这两个函数原本住在 windowHandoff.ts 里，而 V3.3 Task 5 之后有三个
// 模块要用到它们——windowHandoff.ts（判定载荷是不是发给自己的）、closeRequest.ts
// （限定 app-close-requested 的监听 target）、windowClose.ts（限定本窗口的关闭事件、
// 并把自己的 label 传给 destroy_term_window）。后两者若从 windowHandoff.ts 导入，就会
// 顺带触发那个模块顶层的副作用（注册接管监听、广播就绪事件）——一个只想知道"我是谁"
// 的调用方不该因此发起一次握手。

/** 当前窗口的 label。
 *
 *  每次调用都重新读一次（`import()` 本身由模块加载器缓存，重复调用不会重复下载/求值），
 *  不做模块级缓存：这个值是**安全判定的一部分**（windowHandoff 的 handleHandoff 用它比对
 *  payload.toLabel；windowClose 用它决定要不要杀 PTY），缓存一个安全判定的输入只会让
 *  "它什么时候被算出来的"变成又一件要推理的事，而这里省下的是一次 Map 查找级别的开销。
 *
 *  用 `await import(...)` 而不是顶层静态 import：`@tauri-apps/api/window` 与
 *  `@tauri-apps/api/webviewWindow` 这两个模块在本仓库里此前只出现在动态 import 里
 *  （store/layout.ts 的 runPanelResize、App.tsx 的 onDragDropEvent），从主 chunk 静态
 *  引它们会让 rollup 报 "dynamically imported by X but also statically imported by Y,
 *  dynamic import will not move module into another chunk"——基线的 `npm run build`
 *  是零警告的，不该由这个模块开这个头。
 *
 *  getCurrentWindow() 读的是 window.__TAURI_INTERNALS__.metadata，在 jsdom/浏览器
 *  预览里那个对象根本不存在、会同步抛 TypeError——这个模块被 App.tsx 顶层
 *  side-effect 导入的几个模块用到，抛出去会连累整个应用起不来，所以兜底成 'main'
 *  （"当作主窗口"是最保守的答案：主窗口不会去抢接管、也不会自己杀 PTY 关窗，见
 *  isTornOutWindow 与 windowClose.ts）。 */
export async function currentWindowLabel(): Promise<string> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().label
  } catch {
    return 'main'
  }
}

/** 这个窗口是不是"被标签拖出创建的"。
 *
 *  **判定方式：label 前缀**（另一条可选路径是由 Rust 在创建时告知，例如往新窗口注入
 *  一个初始化状态或加个查询参数）。选前缀的理由：
 *    1. label 已经是既有契约，不是为这个判断新造的信息——create_term_window 的返回值
 *       就是 `term-<n>`（src-tauri/src/lib.rs 的 new_term_window_label），
 *       capabilities/default.json 的 windows 也已经写成 ["main", "term-*"]，同一个
 *       前缀在三处共同承载"这是拖出来的终端窗口"这一含义，再引入第二套标记只会多一
 *       处可以互相矛盾的真相来源；
 *    2. 它是**同步且零往返**的：新窗口必须先挂好接管监听、再 emit 就绪事件，中间多
 *       一次 invoke 往返就多一段"旧窗口已经在等、新窗口还没准备好"的窗口期。
 *
 *  用白名单式判断（必须是 `term-` 前缀）而不是 `label !== 'main'`：以后若出现别的
 *  用途的窗口（面板、预览…），"不是主窗口"会让它们也一起去抢接管载荷、也一起按
 *  "拖出来的终端窗口"那套流程自行关闭。Rust 侧 `is_term_window_label` 是同一条规则的
 *  另一侧，两边各自校验一次。 */
export function isTornOutWindow(label: string): boolean {
  return label.startsWith('term-')
}
