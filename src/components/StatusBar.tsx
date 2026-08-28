// 底部常驻状态栏（spec §5.2）：内容随当前激活标签的 kind 变化——
//   - term 标签：显示该会话（活动窗格指向的 thread）的 模型 · effort 强度 · 权限模式。
//   - home / overview 标签：显示全局会话统计（n 个会话 · n 运行中 · n 等待回答）。
//     两种 kind 共用同一份统计口径（跨全部项目的全部 thread，不按单个项目筛选）——
//     spec §5.2 原文把总览与主页并列写在一起，字面意思就是同一份数据、两个入口都能看到。
//
// spec §5.2 原文还写了总览/主页这一档要额外带上"全局默认模型"，这里**没有实现**：
// 全仓库（含 src-tauri）没有任何地方读取过"默认模型"这个概念（没有对应的 Rust 命令、
// 没有 settings 读取、没有任何 store），brief 明确要求"不要发明一个数据源"；同时
// task-10-brief.md 给出的 buildOverviewStatusText 纯函数签名本身也只收 counts 三个
// 数字、不含模型，说明这条文案在纯函数这一层就没有位置。按"缺失字段直接略去"的既有
// 原则处理：该段落恒缺失，效果上等同于没有它。若产品侧后续接入真实的默认模型来源，
// 补法是在 buildOverviewStatusText 签名上加一个可选字段、在这里传入即可，不需要动
// 现有测试。见 task-10-report.md 的“Concerns”一节。
//
// 两段文案抽成纯函数（buildSessionStatusText/buildOverviewStatusText）：「缺失字段不
// 留空段」是最容易出错的一条规则，纯函数上一目了然、也测得干净；组件本身只管按 kind
// 分派、取数，不重新决定"要不要加分隔符"这类字符串细节（brief 明确要求这个切分）。
//
// 挂载位置（App.tsx）：作为 `.content` 的同级兄弟挂在 `.main` 下，不进 `.content`
// 内部，更不进 TerminalLayer/TabPanes 测量几何的任何容器（`.pane-body`/
// `.terminal-wrapper`/`.terminal-host`）。本项目为"把间距塞进 FitAddon 测量的容器、
// 裁掉终端最后一行"这类问题真实付过代价（见提交 3d6b0da 的教训），状态栏固定高度、
// 不带来任何这类风险的前提就是它压根不在被测量的子树里——`.main` 变矮只是让
// `.content` 通过 flex 布局分到更少高度，这与 `.tabbar` 早已在做的事完全一样，
// ResizeObserver 会正常感知并重新 fit()，不是"往测量对象本身加内边距"那种情况。
import { useMemo } from 'react'
import { shortModelName } from '../modelNames'
import { useSessions } from '../store/sessions'
import { threadStatusKey, useStatusStore } from '../store/status'
import { useTabs } from '../store/tabs'

/** 会话标签的状态栏文案：模型 · effort · 权限模式，收集非空段再 join(' · ')，天然满足
 * "不留空段"；三者全缺时返回空串，调用方据此不渲染任何文字（状态栏容器本身仍固定
 * 占高，不随内容有无跳动，见下方 StatusBar）。model 走 shortModelName（Task 6 既有的
 * 唯一模型短名映射，这里不重复第二套）；effort/permissionMode 是后端给的短标识本身
 * （'xhigh'/'acceptEdits' 等），没有另一份人读映射表，原样显示。 */
export function buildSessionStatusText(t: { model?: string | null; effort?: string | null; permissionMode?: string | null }): string {
  const segments = [shortModelName(t.model), t.effort ?? undefined, t.permissionMode ?? undefined].filter(
    (s): s is string => !!s,
  )
  return segments.join(' · ')
}

/** 总览/主页标签的状态栏文案：总数恒显示；运行中/等待回答均为 0 时只显示总数，不堆砌
 * "0 运行中 · 0 等待回答"——0 不是一条值得占用状态栏空间的提醒。 */
export function buildOverviewStatusText(counts: { total: number; running: number; awaiting: number }): string {
  const segments = [`${counts.total} 个会话`]
  if (counts.running > 0) segments.push(`${counts.running} 运行中`)
  if (counts.awaiting > 0) segments.push(`${counts.awaiting} 等待回答`)
  return segments.join(' · ')
}

export function StatusBar() {
  const tabs = useTabs((s) => s.tabs)
  const activeId = useTabs((s) => s.activeId)
  const projects = useSessions((s) => s.projects)
  const statuses = useStatusStore((s) => s.statuses)

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeId), [tabs, activeId])

  const text = useMemo(() => {
    if (activeTab?.kind === 'term') {
      const pane = activeTab.panes.find((p) => p.id === activeTab.activePaneId)
      // 还没选定会话的窗格（PanePicker 阶段）或找不到对应 thread（projects 尚未刷新到）
      // 都视为"缺失"，与 buildSessionStatusText({}) 走同一条"不渲染"路径，不猜测/
      // 不显示陈旧数据。
      if (!pane?.dirName || !pane.rootKey) return ''
      const project = projects.find((p) => p.dirName === pane.dirName)
      const thread = project?.threads.find((t) => t.rootKey === pane.rootKey)
      if (!thread) return ''
      return buildSessionStatusText(thread)
    }
    // home / overview：跨全部项目统计会话总数与运行中/等待回答数。
    let total = 0
    let running = 0
    let awaiting = 0
    for (const project of projects) {
      for (const t of project.threads) {
        total += 1
        const status = statuses.get(threadStatusKey(project.dirName, t.rootKey))?.status
        if (status === 'running') running += 1
        else if (status === 'awaitingInput') awaiting += 1
      }
    }
    return buildOverviewStatusText({ total, running, awaiting })
  }, [activeTab, projects, statuses])

  return <div className="status-bar">{text && <span className="status-bar-text">{text}</span>}</div>
}
