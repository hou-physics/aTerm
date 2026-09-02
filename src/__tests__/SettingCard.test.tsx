import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SettingCard } from '../components/settings/SettingCard'

// SettingCard：v3-2c 新增的分组卡片基础组件（src/components/settings/SettingCard.tsx），
// 供 TerminalSection/ProjectsSection/HooksSection（本任务）与后续主题页任务共用。
// 这里只测它自己声明的两个行为：title 可选、children 原样渲染——分隔线是纯 CSS
// （`.setting-card-body > * + *`），jsdom 不跑级联样式计算，不在这里断言视觉细节。
describe('SettingCard', () => {
  it('传 title 时渲染标题文字', () => {
    render(
      <SettingCard title="滚动">
        <div>内容</div>
      </SettingCard>,
    )
    expect(screen.queryByText('滚动')).not.toBeNull()
  })

  it('不传 title 时不渲染标题节点', () => {
    const { container } = render(
      <SettingCard>
        <div>内容</div>
      </SettingCard>,
    )
    expect(container.querySelector('.setting-card-title')).toBeNull()
  })

  it('children 原样渲染在卡片内', () => {
    render(
      <SettingCard title="分组">
        <div>第一行</div>
        <div>第二行</div>
      </SettingCard>,
    )
    expect(screen.queryByText('第一行')).not.toBeNull()
    expect(screen.queryByText('第二行')).not.toBeNull()
  })
})
