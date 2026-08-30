// 窗格身份对账（spec §3）：窗格记 sessionId（我们用 --session-id 指定、永不变），
// rootKey 每次刷新反查得出。
//
// 为什么不能让窗格直接记 rootKey：scan.rs 的 group_chain_files 用"首条用户消息 uuid，
// 缺失时退回自身 session_id"作链键。新对话刚建时 rootKey == 我们给的 session_id，
// 用户发出第一句话后它翻成那条消息的 uuid——只记 rootKey 的窗格会绑对一瞬间，随即
// 再次失联。
import type { ProjectInfo } from './ipc'
import { displayTitle } from './sessionList'

export type PaneIdentity = { dirName: string; rootKey: string; threadKey: string; title: string }

/** 在 projects 里按 sessionId 找到它当前所属的链，算出该窗格此刻应有的身份。
 *  找不到（转录尚未落盘、或用户在窗格里退出 claude 后跑了别的命令）返回 null，
 *  调用方保持窗格原样，不清空已有身份。 */
export function resolvePaneIdentity(
  projects: ProjectInfo[],
  sessionId: string,
  aliases: Record<string, string>,
): PaneIdentity | null {
  for (const project of projects) {
    for (const thread of project.threads) {
      if (!thread.sessionIds.includes(sessionId)) continue
      return {
        dirName: project.dirName,
        rootKey: thread.rootKey,
        // 与 actions.ts 的 resumeThread 逐字相同的拼法。rootKey 只在单个项目目录内
        // 唯一（见 scan.rs 按目录分组），跨项目必须以「项目:会话」复合键去重。
        threadKey: `${project.dirName}:${thread.rootKey}`,
        // 与侧栏「最近会话」/主页/总览用的是同一个优先级函数：别名 > 真实标题 >
        // 「新对话」（见 sessionList.ts 顶部注释）。标签标题此前完全不认识别名——
        // 这条 title 只走 thread.titled 的真实标题，是本次要修的 bug 本身（用户
        // 原话：「重命名之后的标签不会改变命名，但是在项目栏里面，确实它改变
        // 了」）。titled 为 false 且没有别名时，displayTitle 给的是「新对话」，
        // 不是 session_id 前 8 位的回退值——这一点与旧实现保持一致，只是现在改由
        // displayTitle 统一负责，不在这里单独判断。
        title: displayTitle(thread, project.dirName, aliases),
      }
    }
  }
  return null
}
