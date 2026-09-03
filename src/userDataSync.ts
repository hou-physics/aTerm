// 用户已保存数据的跨窗口同步（V3.3 设计文档 §5.5 的同一模式，全分支终审 Ruling 20）。
//
// ## 为什么需要它
//
// store/library.ts 与 store/overview.ts 都是"模块加载时把整张表读进内存一次，此后每次
// 改动都把**自己内存里的**整张表写回 localStorage"。全仓库没有任何 `storage` 事件监听、
// 也没有第二次 readJson。两个窗口是两个互不相通的 JS 上下文，于是：
//
//   1. 主窗口开着，aliases = {A:'x'}
//   2. 拖出一个标签 → term-1 启动，也读到 {A:'x'}
//   3. 在 term-1 里给会话 B 改名 → 写入 {A:'x', B:'y'}
//   4. 回主窗口给会话 C 改名 → 主窗口按**自己陈旧的内存**写入 {A:'x', C:'z'}
//      → **B 的改名凭空消失，无任何报错**
//
// hiddenProjects / removedSessions / 总览方块位置同理（"隐藏的项目又冒出来"、"移除的
// 会话又回来了"、"摆好的方块跳回原位"）。CLAUDE.md 点名保护的正是这四个键，原话是
// "改任何一个都会静默作废用户已保存的数据"——这里结果完全同类，只是触发方式从"改键名"
// 变成"开两个窗口"。
//
// ## 形状照抄 themeSync.ts
//
// 一条广播事件 + 载荷带 fromLabel + 收方整份替换 + 自己发的早退。差别只有一处：主题
// 的载荷是"全部四个主题字段"，这里是"**哪一个键**的整张表"——见下方 UserDataChangedPayload。
//
// ## 这一条同样是真广播（emit，不是 emitTo）
//
// 与 window-close-requested / term-window-handoff / app-close-requested 相反：那几条
// 的收件人都是**某一个**窗口，必须 emit_to + 两层校验（Ruling 8）；这一条的收件人是
// **除自己外的所有窗口**，广播就是它想要的语义，listen 不传 target（落成
// `{kind:'Any'}`）在这里是正确的而不是漏写的。
// 但"广播"不等于"不校验"：emit 会把事件也投递回**发送窗口自己**，所以载荷带 fromLabel，
// 收到自己发的一律早退；载荷本身也逐项重新校验（它来自 IPC，编译期类型不构成运行期保证）。
//
// ## 不得形成广播循环（本模块的唯一硬不变式）
//
// 收方"整份替换"时会走 store 的 applyRemote* → persist → persist 钩子；不挡住的话
// A 改名 → 广播 → B 应用 → B 落盘 → B 也广播 → A 应用 → A 落盘 → A 再广播 …… 两个
// 窗口互相弹球，每一轮都是一次真实的 localStorage 写。
//
// 与 themeSync 一样用**两道**闸门，各自独立成立：
//   1. `applyingRemoteChange` 标志位：重新应用远端状态期间，persist 钩子直接早退，
//      不广播。applyRemoteUserData 内部只有同步代码（zustand 的 set() 同步通知，
//      persist 同步调用钩子），所以 try/finally 覆盖得严丝合缝，中间没有任何 await
//      能让它漏掉——这是主闸门，也是被测试钉住的那一条。
//   2. `fromLabel === 本窗口` 早退：挡住 emit 投递回自己的那一份回声。
//
// ## 已知边界：两个窗口在同一毫秒内各改一次
//
// 载荷是"某个键的整张表"，收敛规则是后到者胜。两个窗口若在彼此的广播到达之前各改一次，
// 两边会互相覆盖掉对方那一次改动。这是最后写入者胜的固有限制，要根除得引入按条目的
// 合并或版本号，不值当；而它比修复前**严格更好**——修复前是"任何时间差下先写的那次都
// 会丢"，修复后只剩下"同一次事件循环往返内的正面撞车"。
import { emit, listen, type Event } from '@tauri-apps/api/event'
import { ALIASES_KEY, HIDDEN_KEY, REMOVED_KEY, useLibrary } from './store/library'
import { POSITIONS_KEY, setPersistListener, useOverviewStore, type Position } from './store/overview'
import { currentWindowLabel } from './windowLabel'

/** 事件名沿用仓库既有的 kebab-case 风格（'pty-output' / 'theme-changed'）。 */
export const USER_DATA_CHANGED_EVENT = 'user-data-changed'

/** `user-data-changed` 的载荷。
 *
 *  `fromLabel` 是**发送窗口自己的** label，用途是让收方识别并丢弃自己的回声（同
 *  themeSync 的 ThemeChangedPayload、握手协议里 ack 带接管方 label）。
 *
 *  `key` 是 localStorage 键名本身，`value` 是该键**那一刻的整张表**。
 *
 *  为什么按键分条、而不是像主题那样一次发全部四张表：主题那四个字段是一个整体（mode
 *  与三个 id 必须一起解释）；这四张表彼此独立，各有各的最新持有者。一次发全部的话，
 *  "我改了别名"这条广播会连带把**我这份可能已经陈旧的方块位置**也推给对方，等于把本
 *  次要修的那个缺陷原样搬到另外三个键上。 */
export type UserDataChangedPayload = {
  fromLabel: string
  key: string
  value: unknown
}

/** 参与跨窗口同步的键。persist() 将来若被用于别的键，那些键不会被广播出去——刻意如此：
 *  一个键要参与同步，就必须在下面 applyRemoteUserData 里有对应的校验与落地方式，
 *  没有的时候宁可不同步，也不要广播一份没人会正确处理的载荷。 */
const SYNCED_KEYS: ReadonlySet<string> = new Set([ALIASES_KEY, HIDDEN_KEY, REMOVED_KEY, POSITIONS_KEY])

// 见文件顶部「不得形成广播循环」第 1 道闸门。
let applyingRemoteChange = false

/** IPC 来的值必须是一个普通对象（不是 null、不是数组）才可能是一张表。 */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

/** 逐条过滤而不是"整份不合法就整份丢弃"：一条坏记录不该让整次同步失效，否则一个畸形
 *  条目就能让两个窗口从此永久不一致。校验放在本模块（而不是 store）里，是因为它针对
 *  的是**线上格式**——store 不该因为多了一个 IPC 收件口就长出 IPC 的知识。 */
function sanitizeTable<T>(v: unknown, keep: (val: unknown) => val is T): Record<string, T> | null {
  const rec = asRecord(v)
  if (!rec) return null
  const out: Record<string, T> = {}
  for (const [k, val] of Object.entries(rec)) if (keep(val)) out[k] = val
  return out
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isTrue = (v: unknown): v is true => v === true
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
function isPosition(v: unknown): v is Position {
  const rec = asRecord(v)
  return rec !== null && isFiniteNumber(rec.x) && isFiniteNumber(rec.y)
}

/** 把远端的一张表应用到本窗口，**且保证这次应用不会触发再广播**。
 *
 *  导出是为了让测试能不经事件系统直接验证这条不变式（"应用之后 emit 没有被调用"），
 *  以及让 handleUserDataChanged 与它共用同一段闸门代码而不是各写一份。 */
export function applyRemoteUserData(payload: UserDataChangedPayload): void {
  applyingRemoteChange = true
  try {
    switch (payload.key) {
      case ALIASES_KEY: {
        const t = sanitizeTable(payload.value, isString)
        if (t) useLibrary.getState().applyRemoteAliases(t)
        break
      }
      case HIDDEN_KEY: {
        const t = sanitizeTable(payload.value, isTrue)
        if (t) useLibrary.getState().applyRemoteHiddenProjects(t)
        break
      }
      case REMOVED_KEY: {
        const t = sanitizeTable(payload.value, isFiniteNumber)
        if (t) useLibrary.getState().applyRemoteRemovedSessions(t)
        break
      }
      case POSITIONS_KEY: {
        const t = sanitizeTable(payload.value, isPosition)
        if (t) useOverviewStore.getState().applyRemotePositions(t)
        break
      }
      // 认不出的键：什么都不做。见 SYNCED_KEYS 上方的注释。
    }
  } finally {
    // finally 而不是紧跟其后一行：任何一环抛出（例如 zustand 的订阅者里有人炸了），
    // 标志位若留在 true，这个窗口此后**永远**不再把自己的改动告诉别人——一个静默、
    // 不可恢复、且只在多窗口下才能观察到的故障。
    applyingRemoteChange = false
  }
}

/** 收到别的窗口的用户数据变更。 */
export async function handleUserDataChanged(event: Event<UserDataChangedPayload>): Promise<void> {
  const payload = event?.payload
  // 载荷缺 fromLabel 就无从判断是不是自己的回声，宁可什么都不做（同 themeSync）。
  if (!payload || typeof payload.fromLabel !== 'string' || typeof payload.key !== 'string') return
  if (payload.fromLabel === (await currentWindowLabel())) return
  applyRemoteUserData(payload)
}

/** 本窗口有东西落盘了 → 广播给其它窗口。 */
async function broadcastUserData(key: string, value: unknown): Promise<void> {
  const fromLabel = await currentWindowLabel()
  await emit(USER_DATA_CHANGED_EVENT, { fromLabel, key, value } satisfies UserDataChangedPayload)
}

// 挂在 persist 上而不是订阅 store——理由见 store/overview.ts 里 setPersistListener
// 上方的注释（唯一写入口 + 拖拽中的 setPosition 不该广播）。
setPersistListener((key, value) => {
  if (applyingRemoteChange) return
  if (!SYNCED_KEYS.has(key)) return
  // 广播失败只 console.warn，绝不静默吞掉（理由同 themeSync 的 broadcastThemeChange）。
  // 失败的后果是其它窗口这一次没跟上，本窗口自己完全正常，不值得打断任何东西。
  void broadcastUserData(key, value).catch((err) => {
    console.warn('用户数据跨窗口广播失败', err)
  })
})

// 与 themeSync.ts / closeRequest.ts / menuEvents.ts 同一注册模式：模块顶层立即发起监听
// （App.tsx 顶层 side-effect 导入），不等组件挂载。**刻意不传 target**——见文件顶部
// 「这一条同样是真广播」。导出这个 Promise 只是为了让调用方（测试）能等它就绪。
export const userDataSyncReady: Promise<void> = (async () => {
  await listen<UserDataChangedPayload>(USER_DATA_CHANGED_EVENT, handleUserDataChanged)
})()
  .then(() => undefined)
  .catch((err) => { console.error('用户数据跨窗口同步监听注册失败', err) })
