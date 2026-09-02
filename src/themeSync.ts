// 主题的跨窗口同步（V3.3 设计文档 §5.5）。
//
// ## 为什么需要它
//
// 主题状态住在**每个窗口自己**的 zustand store（src/store/theme.ts），CSS 变量写在
// **每个窗口自己**的 `document.documentElement`（themes/derive.ts 的 applyUiVars）。
// 两个窗口是两个互不相通的 JS 上下文——在一个窗口里改主题，另一个窗口的 store 和
// document 都不会动。
//
// localStorage 虽然同源共享（Tauri 各窗口都是 tauri://localhost），但 store/theme.ts
// **只在模块加载时读一次**（readPersisted()），之后不再回头看；跨 WKWebView 的
// `storage` 事件也不可依赖。所以必须显式广播一条事件。
//
// ## 为什么这一条事件是真广播（`emit`，不是 `emitTo`）
//
// 与本计划里其它几条事件正好相反：`window-close-requested`/`term-window-handoff`/
// `app-close-requested` 的收件人都是**某一个**窗口，因此要 emit_to + 两层校验
// （Ruling 8）；这一条的收件人是**除自己外的所有窗口**，广播就是它想要的语义，
// `listen` 不传 target（落成 `{ kind: 'Any' }`）在这里是正确的而不是漏写的。
//
// 但"广播"不等于"不校验"：`emit` 会把事件也投递回**发送窗口自己**，因此载荷带
// `fromLabel`，收到自己发的一律早退。
//
// ## 不得形成广播循环（本模块的唯一硬不变式）
//
// 天真实现是"订阅 store，一变就广播"。那样 A 改主题 → 广播 → B 应用 → B 的 store 变了
// → B 也广播 → A 应用 → A 的 store 又变了 → A 再广播 …… 两个窗口互相弹球，用户看到的是
// 主题闪烁不止、CPU 空转。
//
// 这里用**两道**闸门，各自独立成立：
//   1. `applyingRemoteChange` 标志位：重新应用远端状态期间，订阅回调直接早退，不广播。
//      zustand 的 `set()` 是**同步**通知订阅者的，而 `applyRemoteThemeState` 内部只有
//      同步代码，所以这个标志位在 try/finally 里覆盖得严丝合缝，中间不存在任何 await
//      能让它漏掉——这是主闸门，也是被测试钉住的那一条。
//   2. `fromLabel === 本窗口` 早退：挡住 `emit` 投递回自己的那一份回声。
//
// 两道都留着不是冗余：第 1 道管"收到之后不再发"，第 2 道管"发出去的不要自己再收一遍"，
// 删掉任何一道都会有一类循环/多余重绘漏网。
import { emit, listen, type Event } from '@tauri-apps/api/event'
import { useTheme } from './store/theme'
import { currentWindowLabel } from './windowLabel'

/** 事件名沿用仓库既有的 kebab-case 风格（'pty-output' / 'app-close-requested' /
 *  'menu-theme-mode'）。 */
export const THEME_CHANGED_EVENT = 'theme-changed'

/** `theme-changed` 的载荷。
 *
 *  `fromLabel` 是**发送窗口自己的** label，用途是让收方识别并丢弃自己的回声——与
 *  握手协议里 ack 带接管方 label 同一手法（windowHandoff.ts 的 HandoffAck）。
 *
 *  其余四个字段就是 store 里全部会被持久化的主题状态。**整份发**而不是只发变化的那
 *  一个字段：接收端一次原子替换就能收敛，不必按字段分派；而且新窗口刚建出来时若与
 *  别的窗口不一致，任意一次后续变更都会把它拉齐，不需要额外的"求当前状态"往返。
 *  `activeTheme` 不在载荷里——它是这四项加上本窗口 systemPrefersDark 推导出来的，
 *  传过去只会多一个可以与推导结果矛盾的真相来源。 */
export type ThemeChangedPayload = {
  fromLabel: string
  mode: string
  lightThemeId: string
  darkThemeId: string
  singleThemeId: string
}

// 见文件顶部「不得形成广播循环」第 1 道闸门。
let applyingRemoteChange = false

/** 把远端状态应用到本窗口，**且保证这次应用不会触发再广播**。
 *
 *  导出是为了让测试能不经事件系统直接验证这条不变式（"应用之后 emit 没有被调用"），
 *  以及让 handleThemeChanged 与它共用同一段闸门代码而不是各写一份。 */
export function applyRemoteThemeChange(payload: ThemeChangedPayload): void {
  applyingRemoteChange = true
  try {
    useTheme.getState().applyRemoteThemeState(payload)
  } finally {
    // finally 而不是紧跟其后一行：applyRemoteThemeState 里任何一环抛出（例如
    // applyUiVars 在某个畸形主题上炸了），标志位若留在 true，这个窗口此后**永远**
    // 不再广播自己的主题变更——一个静默、不可恢复、且只在多窗口下才能观察到的故障。
    applyingRemoteChange = false
  }
}

/** 收到别的窗口的主题变更。 */
export async function handleThemeChanged(event: Event<ThemeChangedPayload>): Promise<void> {
  const payload = event?.payload
  // 载荷缺 fromLabel 就无从判断是不是自己的回声，宁可什么都不做：这条事件的作用只是
  // 让两个窗口看起来一致，跳过一次的代价是"另一个窗口这次没跟上"，而误处理一次自己的
  // 回声的代价是多一次全量重绘。
  if (!payload || typeof payload.fromLabel !== 'string') return
  if (payload.fromLabel === (await currentWindowLabel())) return
  applyRemoteThemeChange(payload)
}

/** 本窗口的主题变了 → 广播给其它窗口。
 *
 *  载荷取的是**发送那一刻**的 `useTheme.getState()`，不是订阅回调里那个 `state`
 *  快照。理由：两次变更挨得很近时（比如用户连点两下模式按钮），两条广播都会带上最终
 *  状态，收方无论按什么顺序收到都收敛到同一个结果；带各自的历史快照则要依赖投递顺序。
 *  这与 Ruling 9 "不要跨 await 复用旧快照"是同一条原则的两面。 */
async function broadcastThemeChange(): Promise<void> {
  const fromLabel = await currentWindowLabel()
  const { mode, lightThemeId, darkThemeId, singleThemeId } = useTheme.getState()
  const payload: ThemeChangedPayload = { fromLabel, mode, lightThemeId, darkThemeId, singleThemeId }
  await emit(THEME_CHANGED_EVENT, payload)
}

/** 这次 store 变化是否触及了需要跨窗口同步的字段。
 *
 *  zustand 对每次 `set()` 都无条件通知订阅者、不做深比较，而 store 里还有
 *  `activeTheme`（推导值）和 `systemPrefersDark`（本窗口自己的系统外观）两个字段会
 *  独立变化——尤其 systemPrefersDark：系统切深色时**每个**窗口的 matchMedia 都会各自
 *  触发一次，若不过滤，N 个窗口会互相广播出 N² 条毫无信息量的事件。 */
function syncedFieldsChanged(a: ThemeSyncedFields, b: ThemeSyncedFields): boolean {
  return a.mode !== b.mode
    || a.lightThemeId !== b.lightThemeId
    || a.darkThemeId !== b.darkThemeId
    || a.singleThemeId !== b.singleThemeId
}

type ThemeSyncedFields = {
  mode: string
  lightThemeId: string
  darkThemeId: string
  singleThemeId: string
}

useTheme.subscribe((state, prevState) => {
  if (applyingRemoteChange) return
  if (!syncedFieldsChanged(state, prevState)) return
  // 广播失败只 console.warn，绝不静默吞掉——理由同 menuEvents.ts 的
  // syncThemeModeToMenu（layout.ts 的 resizeWindowForPanel 那次事故）。失败的后果是
  // 其它窗口这一次没跟上，本窗口自己完全正常，因此不值得打断任何东西。
  void broadcastThemeChange().catch((err) => {
    console.warn('主题跨窗口广播失败', err)
  })
})

// 与 closeRequest.ts / menuEvents.ts 同一注册模式：模块顶层立即发起监听（App.tsx 顶层
// side-effect 导入），不等组件挂载。**刻意不传 target**——见文件顶部「为什么这一条事件
// 是真广播」。导出这个 Promise 只是为了让调用方（测试）在需要时能等它就绪。
export const themeSyncReady: Promise<void> = (async () => {
  await listen<ThemeChangedPayload>(THEME_CHANGED_EVENT, handleThemeChanged)
})()
  .then(() => undefined)
  .catch((err) => { console.error('主题跨窗口同步监听注册失败', err) })
