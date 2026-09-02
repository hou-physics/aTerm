import { describe, expect, it, beforeEach } from 'vitest'
import { useSettings } from '../store/settings'

describe('settings store', () => {
  beforeEach(() => { useSettings.setState({ open: false, activeCategory: 'theme' }) })

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

  it('setActiveCategory 切换分类', () => {
    // 起点 theme，目标 hooks——两者不同，不是恒真检查。
    useSettings.getState().setActiveCategory('hooks')
    expect(useSettings.getState().activeCategory).toBe('hooks')
  })

  // 用 getInitialState()（zustand 5.x）而不是 getState()：前者是 store 定义时的
  // 初始值，与之后任何 setState/action 调用无关，所以不管这条测试排在文件的第几
  // 个、前面跑过什么用例，测的都只会是 create() 里写的那个默认值——不再依赖
  // beforeEach 或 it 的声明顺序（R1 修复：上一版用 getState() + 不重置
  // activeCategory 的写法，被 beforeEach 一并重置就会变成恒真断言，已用变异
  // 验证证实过这个假阳性，见 report「修复轮 R1」）。
  it('activeCategory 默认是 theme（主题）', () => {
    expect(useSettings.getInitialState().activeCategory).toBe('theme')
  })
})
