// 会话/项目状态点：Sidebar 每条会话前、主页项目卡片（聚合）与展开的会话行（各自状态）
// 共用同一个小组件（设计文档 §7）。
//
// 布局：外层 .status-dot-slot 恒渲染、固定尺寸——即使当前状态是 undefined/'unknown'
// （没有任何已知状态，见 store/status.ts 的 aggregateStatus），也占住这块空间，
// 只是内部什么都不画。这样状态从"未知"变为"已知"（或反过来）时相邻文字不会跟着挪动
// （brief 明确要求"No layout jumps"）。
//
// 转圈动画（仅 running）：动画本身定义在 App.css 的 .status-dot-spinner，用
// animation: … infinite。它不需要在这个组件里额外做"是否可见"的判断——转圈的宿主
// 元素永远画在 Sidebar（折叠时整个 <Sidebar/> 不挂载，见 App.tsx `{!sidebarCollapsed
// && <Sidebar/>}`）或主页卡片（非当前标签时整个 .home-wrap 是 display:none，见
// App.tsx）里；CSS 规范保证 display:none 的子树完全不参与渲染/动画（不是"暂停"，
// 是彻底不跑，比 animation-play-state:paused 更强），所以只要这两处既有的隐藏机制
// 还在（本次改动未触碰它们），转圈动画就绝不会在不可见时消耗任何重绘/CPU。
import type { AggregateStatus } from '../store/status'

const STATUS_TITLE: Record<'running' | 'awaitingInput' | 'done', string> = {
  running: '运行中',
  awaitingInput: '等你回答',
  done: '已完成',
}

export function StatusDot({ status }: { status: AggregateStatus | undefined }) {
  const known = status && status !== 'unknown' ? status : undefined
  return (
    <span className="status-dot-slot">
      {known && (
        <span className={`status-dot status-dot-${known}`} title={STATUS_TITLE[known]}>
          {known === 'running' && <span className="status-dot-spinner" />}
        </span>
      )}
    </span>
  )
}
