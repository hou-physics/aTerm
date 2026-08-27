import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { StatusDot } from '../components/StatusDot'

// StatusDot 是纯展示组件（不订阅任何 store，状态由调用方通过 prop 传入），可以直接
// 断言渲染出的真实 DOM，不需要 mock 任何东西——三种已知状态各自的 class/title，以及
// 'unknown'/undefined 时"什么都不画但占位仍在"这条 brief 明确要求的规则。
describe('StatusDot — 渲染 + 空态', () => {
  it('running：圆点带 status-dot-running class、中文 title「运行中」，且带转圈 spinner', () => {
    const { container } = render(<StatusDot status="running" />)
    const dot = container.querySelector('.status-dot')
    expect(dot).toBeTruthy()
    expect(dot?.classList.contains('status-dot-running')).toBe(true)
    expect(dot?.getAttribute('title')).toBe('运行中')
    expect(container.querySelector('.status-dot-spinner')).toBeTruthy()
  })

  it('awaitingInput：中文 title「等你回答」，不带 spinner', () => {
    const { container } = render(<StatusDot status="awaitingInput" />)
    const dot = container.querySelector('.status-dot')
    expect(dot?.classList.contains('status-dot-awaitingInput')).toBe(true)
    expect(dot?.getAttribute('title')).toBe('等你回答')
    expect(container.querySelector('.status-dot-spinner')).toBeNull()
  })

  it('done：中文 title「已完成」，不带 spinner', () => {
    const { container } = render(<StatusDot status="done" />)
    const dot = container.querySelector('.status-dot')
    expect(dot?.classList.contains('status-dot-done')).toBe(true)
    expect(dot?.getAttribute('title')).toBe('已完成')
    expect(container.querySelector('.status-dot-spinner')).toBeNull()
  })

  it("'unknown'：不渲染任何圆点/spinner，但占位 slot 仍在 DOM 里（reserve 高度，不引起相邻文字跳动）", () => {
    const { container } = render(<StatusDot status="unknown" />)
    expect(container.querySelector('.status-dot')).toBeNull()
    expect(container.querySelector('.status-dot-spinner')).toBeNull()
    expect(container.querySelector('.status-dot-slot')).toBeTruthy()
  })

  it('undefined（尚未收到任何状态数据）：同 unknown，不渲染圆点，仅占位', () => {
    const { container } = render(<StatusDot status={undefined} />)
    expect(container.querySelector('.status-dot')).toBeNull()
    expect(container.querySelector('.status-dot-slot')).toBeTruthy()
  })
})
