import type { ReactNode } from 'react'

export type SettingCardProps = {
  /** 卡片上方的小标题，如「权限」「常规」「滚动」。可选——不传就是一张没有
   *  标题、只有内容本身的卡片（比如列表为空时只想显示一行说明文字）。 */
  title?: string
  /** 卡片内容，通常是若干个 SettingRow。行与行之间的细分隔线由本组件的 CSS
   *  自动画（`.setting-card-body > * + *`），不要求子节点一定是 SettingRow——
   *  任何直接子节点之间都会被分隔，SettingCard 不关心子节点具体是什么。 */
  children: ReactNode
}

/**
 * 设置浮层里的分组卡片：圆角容器，底色/边框取自主题变量
 * （--color-elevated / --color-border），与右侧详情区背景（--color-panel）
 * 拉开一层层次。
 */
export function SettingCard({ title, children }: SettingCardProps) {
  return (
    <div className="setting-card">
      {title != null && <div className="setting-card-title">{title}</div>}
      <div className="setting-card-body">{children}</div>
    </div>
  )
}
