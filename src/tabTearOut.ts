// 标签拖出窗口边界的判定（设计文档 §4.1：docs/superpowers/specs/
// 2026-09-02-aterm-v3-3-multiwindow-design.md）。纯函数，不摸 DOM/store，供
// src/components/TabBar.tsx 在 pointermove/pointerup 时判定"此刻是否已经拖出窗口"，
// 也便于脱离真实拖拽单独做单元测试（同 paneDrop.ts 的既有做法：几何/判定逻辑与
// DOM 胶水分开，前者纯粹、可测，后者只做"从真实 DOM 取数"这一步）。
//
// 现有拖拽已用 setPointerCapture——macOS 会把 mouse-dragged 事件继续投递给最初接收
// mouse-down 的窗口，指针移出窗口后 pointermove/pointerup 仍会到达，clientX/clientY
// 因此可能为负值或超出窗口尺寸（设计文档 §2 "已核实的技术前提"已实测核实过这一点，
// 这里直接依赖它，不重新验证）。windowRect 因此只需要 width/height——它描述的是"当前
// 窗口自己的坐标系"，原点恒为 (0, 0)（clientX/clientY 本就是相对当前窗口视口的坐标），
// 不需要 top/left。
export type TearOutPoint = { x: number; y: number }
export type TearOutWindowRect = { width: number; height: number }

// 只剩一个（非主页）标签时永不拖出：那等于把窗口整体搬到新窗口，没有意义（设计文档
// §4.1 明确的边界情况——"若被拖的标签是该窗口内唯一的标签……此时不触发拖出，退回既有
// 行为"）。tabCount 的具体口径（是否把恒定钉住、不可拖动的主页标签算进去）由调用方
// 决定，这个纯函数只认"<=1 就不拖出"这一条规则本身，不关心 tabCount 是怎么数出来的。
//
// 边界取闭区间——判断"窗口内"用 >=下界 且 <=上界，不是 paneDrop.ts 里
// resolveDropTarget/pointInRect 那套左闭右开约定。那套约定的用途是让"多个互相紧邻的
// 矩形"边界像素只命中其中一个、不会同时命中相邻的下一个；这里全局只有一个矩形（整个
// 窗口），不存在相邻矩形互相抢边界像素的问题，窗口边缘的像素本身仍然是"在窗口内"这件
// 事没有理由改变，边界因此应当算作"未拖出"（brief 的测试用例明确要求
// {x:width,y:height} 这个右下角边界点判定为"不拖出"）。

/** 判定为"拖出"所需的**额外出界距离**（逻辑像素）。光标只是刚刚越过窗口边缘不算拖出，
 *  要再往外走够这么多才算。
 *
 *  为什么必须有这个余量（终审 I4）：`.tabbar` 是 `.main` 的第一个子元素、`padding:
 *  6px 8px 0`，**标签本体的中心在 clientY ≈ 19px**；`tauri.conf.json` 没有
 *  `titleBarStyle`，用的是原生标题栏，因此标题栏区域对 webview 就是 `clientY < 0`。
 *  没有余量的话，用户横向拖动标签**排序**时只要向上多晃 20 像素就落进标题栏、命中拖出
 *  判定，松手直接弹出一个新窗口。而设计文档 §3 明确不做"拖回已存在的窗口"——误触之后
 *  没有撤销手段：要么永远多一个窗口，要么关掉它（V3.3 Task 5 之后关非主窗口会 kill 它
 *  持有的 PTY，有确认框，但那是唯一出路）。一个不可逆的操作不能由 20 像素的手抖触发。
 *
 *  **取 40 的依据**：
 *    1. macOS 标准窗口的原生标题栏高 28pt，也就是标题栏区域恒为 `clientY ∈ [-28, 0)`。
 *       余量 40 > 28 意味着**整条标题栏都落在死区里**——"横向排序时晃进标题栏"这一整类
 *       误触被彻底排除，而不是把阈值调高一点、让它变得少见一些。
 *    2. 另外三个方向沿用同一个值：判定本身是对称的，没有理由让左右下三边比上边更容易
 *       误触；40 相对本应用的窗口最小尺寸（`tauri.conf.json` 的 800×500）只有 5%/8%，
 *       真心要把标签拖到窗口外时完全感觉不到它的存在。
 *  Chrome / iTerm2 这类应用同样要求一个明显的位移才撕出标签页，并且允许拖回；本应用
 *  不做"拖回"，因此这个门槛只能设得更高、而不是更低。 */
const TEAR_OUT_MARGIN_PX = 40

/** 纯几何：光标是否已经在窗口视口之外**足够远**（含上面那个余量），**不含** tabCount
 *  守卫。
 *
 *  V3.4 把它从 shouldTearOut 里摘出来单独导出：松手时的三路分流（设计文档 §5.2）里，
 *  「指针在源窗口外」是四条路共同的入口条件，而 `tabCount <= 1` 那道守卫**只拦第 4 路**
 *  （建新窗口）——把 `term-*` 窗口里最后一个标签拖到别的窗口正是 V3.4 的核心用例，被守卫
 *  拦下就等于这个功能对空壳窗口不可用。余量则四条路一视同仁（设计文档 §5.2 原文"沿用
 *  V3.3 的判定与 40px 余量"）：它挡的是"横向排序时向上晃进标题栏"这类手抖，而 V3.4 之后
 *  那一晃的后果从"弹出一个新窗口"变成了"把标签甩进背后那个窗口"——级联摆放的窗口正好
 *  就在源窗口标题栏背后，误触面反而更大，没有任何理由在这条路上把余量放掉。 */
export function isPointerOutsideWindow(point: TearOutPoint, windowRect: TearOutWindowRect): boolean {
  const insideX = point.x >= -TEAR_OUT_MARGIN_PX && point.x <= windowRect.width + TEAR_OUT_MARGIN_PX
  const insideY = point.y >= -TEAR_OUT_MARGIN_PX && point.y <= windowRect.height + TEAR_OUT_MARGIN_PX
  return !(insideX && insideY)
}

export function shouldTearOut(point: TearOutPoint, windowRect: TearOutWindowRect, tabCount: number): boolean {
  if (tabCount <= 1) return false
  return isPointerOutsideWindow(point, windowRect)
}

/** 目标窗口「标签栏落区」的高度（逻辑像素）：`window_at_point` 返回的 `localY` 小于它，
 *  才算落在目标窗口的标签栏上、才交接（设计文档 §5.2 第 2 路）；落在这个高度之外就是
 *  **取消**（Ruling 2：在别的窗口的终端区域上松手，用户意图不明，更不可能是"在它上面再
 *  叠一个新窗口"）。
 *
 *  **取 68 的依据 —— 关键在于 `localY` 的原点是窗口外框，不是内容区**：
 *    1. Task 2 的 `hit_test_windows`（src-tauri/src/lib.rs）算的是
 *       `local_y = py - rect.y`，而 `rect` 由 `outer_position()`/`outer_size()` 换算而来
 *       ——**外框**矩形，macOS 上它把原生标题栏一并算在内（`tauri.conf.json` 没有
 *       `titleBarStyle`，用的是原生标题栏）。也就是说 `localY === 0` 是标题栏顶边，
 *       webview 内容区从 `localY ≈ 28` 才开始。
 *    2. 内容区里的落区高度是 **40**：`.tabbar` 实际高约 33px（`padding: 6px 8px 0`
 *       + `.tab` 5+13+5 + 1px 下边框，见 App.css），40 给它留一点余量。
 *    3. 两者相加：**28（原生标题栏，macOS 标准窗口 28pt）+ 40 = 68**。少了这 28 的偏移，
 *       用户把标签放在目标窗口标签栏正中央（`localY ≈ 28 + 19 = 47`）会被判成"不在落区"
 *       而**静默取消**——正是本功能最主要的那一次手势。
 *
 *  顺带说明为什么把标题栏也算进落区：拖到另一个窗口的标题栏上松手，与拖到它的标签栏上
 *  是同一个意图（"把这个标签交给那个窗口"），Chrome/iTerm2 同样接受标题栏落点；而它离
 *  终端内容区仍有整条标签栏的距离，不会与 Ruling 2 要拦的"落在终端区域"混淆。 */
export const TABBAR_DROP_ZONE_PX = 68
