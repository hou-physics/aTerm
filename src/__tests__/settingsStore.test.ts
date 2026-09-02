import { describe, expect, it, beforeEach } from 'vitest'
import { useSettings } from '../store/settings'

describe('settings store', () => {
  beforeEach(() => { useSettings.setState({ open: false }) })
  // 注意：这里刻意不重置 activeCategory（不像 open 那样每条用例前摁回固定值）。
  // 下面「activeCategory 默认是 theme」那条测试要验证的是 store 定义里的真实初始
  // 值，如果每次都强制摁回 'theme'，就算把 store 定义里的默认值改错，这条测试也
  // 测不出来——变异验证里实际跑出过这个假阳性（见下方 mutation 记录）。这条测试
  // 必须是本文件里第一个碰 activeCategory 的用例（下面 it 声明顺序保证了这点，
  // Vitest 默认按声明顺序跑），会*写* activeCategory 的只有最后一条
  // 「setActiveCategory 切换分类」，排在它后面。

  it('默认关闭', () => {
    expect(useSettings.getState().open).toBe(false)
  })

  it('openSettings 打开，closeSettings 关闭', () => {
    useSettings.getState().openSettings()
    expect(useSettings.getState().open).toBe(true)
    useSettings.getState().closeSettings()
    expect(useSettings.getState().open).toBe(false)
  })

  it('重复调用是幂等的', () => {
    useSettings.getState().openSettings()
    useSettings.getState().openSettings()
    expect(useSettings.getState().open).toBe(true)
  })

  // v3-2b：设置浮层左侧分类列表 + 右侧详情。activeCategory 与 open 同一个 store，
  // 同样刻意不持久化（beforeEach 里手动重置，不依赖 localStorage 清空）。
  it('activeCategory 默认是 theme（主题）', () => {
    expect(useSettings.getState().activeCategory).toBe('theme')
  })

  it('setActiveCategory 切换分类', () => {
    // 起点 theme，目标 hooks——两者不同，不是恒真检查。
    useSettings.getState().setActiveCategory('hooks')
    expect(useSettings.getState().activeCategory).toBe('hooks')
  })
})
