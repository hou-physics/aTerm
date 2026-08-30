// 窗格身份对账（spec §3）：窗格记 sessionId（我们用 --session-id 指定、永不变），
// rootKey 每次刷新反查得出。
//
// 为什么不能让窗格直接记 rootKey：scan.rs 的 group_chain_files 用"首条用户消息 uuid，
// 缺失时退回自身 session_id"作链键。新对话刚建时 rootKey == 我们给的 session_id，
// 用户发出第一句话后它翻成那条消息的 uuid——只记 rootKey 的窗格会绑对一瞬间，随即
// 再次失联。
import type { ProjectInfo } from './ipc'

export type PaneIdentity = { dirName: string; rootKey: string; threadKey: string; title?: string }

/** 在 projects 里按 sessionId 找到它当前所属的链，算出该窗格此刻应有的身份。
 *  找不到（转录尚未落盘、或用户在窗格里退出 claude 后跑了别的命令）返回 null，
 *  调用方保持窗格原样，不清空已有身份。 */
export function resolvePaneIdentity(projects: ProjectInfo[], sessionId: string): PaneIdentity | null {
  for (const project of projects) {
    for (const thread of project.threads) {
      if (!thread.sessionIds.includes(sessionId)) continue
      return {
        dirName: project.dirName,
        rootKey: thread.rootKey,
        // 与 actions.ts 的 resumeThread 逐字相同的拼法。rootKey 只在单个项目目录内
        // 唯一（见 scan.rs 按目录分组），跨项目必须以「项目:会话」复合键去重。
        threadKey: `${project.dirName}:${thread.rootKey}`,
        // 只在有真实标题时给出。titled 为 false 时 thread.title 是 session_id 前 8 位
        // 的回退值（见 scan.rs），采纳它会把标签标题从「新对话」变成一串 uuid。
        //
        // 契约：title 有值时保证非空——src-tauri/src/sessions/parser.rs 的三条 title
        // 路径都带 !is_empty() / trim() 非空守卫，titled === true 蕴含 title 非空，
        // 生产中不存在 `titled: true, title: ''` 这个状态。下游 store/tabs.ts 的
        // reconcilePanes 用 `id.title ?? pane.title` 采纳这里给出的值：既然 title
        // 有值就非空，`??` 与 `||` 在此处等价；选 `??` 是因为语义本就是「字段缺省
        // 则保留旧标题」，不是「遇到假值就回退」，用 `??` 如实表达这个意图，而不是
        // 为了规避一个实际不会出现的空串。
        title: thread.titled ? thread.title : undefined,
      }
    }
  }
  return null
}
