// 本文件测试范围是刻意收窄过的：见 src/components/TerminalView.tsx 里那段 beforeinput
// 绕行监听器上的注释、以及 .superpowers/sdd/ime-fix-report.md——jsdom 不实现真实的
// macOS 中文输入法合成时序，没法复现"第一个标点需要按两次才出字"那个真实场景，所以
// 这里完全不模拟那个场景，也不对"绕行有没有真的让 IME 首字符出字"下任何断言。这个
// 文件只验证两件在 jsdom 里可靠、诚实可测的事：
//   1) 挂载时，那个 beforeinput 监听器确实注册在容器元素（textarea 的父元素）上、
//      且是捕获阶段——而不是（更容易写错但看起来也能跑的）挂在 textarea 本身上。
//   2) 卸载时，注销用的是同一个函数引用、同一个 capture 标志——不是漏卸载。
// 绕行本身能不能修好真实的 IME 输入，只能由用户在真机上验证。
//
// 要挂载真实的 <TerminalView>（多数测试反而是把它替身掉，见 App.test.tsx 顶部注释）
// 需要给 jsdom 补两个它没有的浏览器 API：ResizeObserver（TerminalView 自己 new 了一个
// 来监听容器尺寸）和 window.matchMedia（xterm.js 内部 CoreBrowserService.open() 里用它
// 探测 devicePixelRatio 变化，缺失会直接抛错，整个 effect 跑不完，cleanup 闭包也就永远
// 注册不上，卸载时无从验证注销）。两个桩都只在本文件内生效。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptyResize: vi.fn(async () => {}),
  ptyWrite: vi.fn(async () => {}),
}))
vi.mock('../ptyBuffer', () => ({
  ptyEventsReady: Promise.resolve(),
  attachPty: vi.fn(() => () => {}),
}))

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
  }
})

// 必须在上面的 jsdom 补丁装好之后再 import——TerminalView 顶层 import '@xterm/xterm/css/xterm.css'
// 没问题，但它的 effect 一跑到 term.open(el) 就会用到 matchMedia，模块本身倒是随便什么时候
// import 都行；这里延后只是保持"先补环境、再动真格"的顺序，避免以后谁往顶层加东西时忘了这茬。
import { TerminalView } from '../components/TerminalView'

describe('TerminalView 的 beforeinput 绕行监听器 —— 只测注册与注销，不测 IME 行为', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('挂载时把 beforeinput 监听器（捕获阶段）注册在容器元素上而不是 textarea 上；卸载时用同一个函数引用+同一个 capture 标志注销', async () => {
    const addSpy = vi.spyOn(Element.prototype, 'addEventListener')
    const removeSpy = vi.spyOn(Element.prototype, 'removeEventListener')

    const { container, unmount } = render(<TerminalView ptyId="pty-ime-guard-test" active={false} />)
    await act(async () => {}) // flush mount effect

    const el = container.querySelector('.terminal-host') as HTMLElement
    expect(el).toBeTruthy()
    const textarea = el.querySelector('textarea')
    expect(textarea).toBeTruthy()

    // spy.mock.instances 的 TS 类型是从 addEventListener 的返回类型（void）推出来的，
    // 和实际运行时的 `this`（Element）对不上——这里转成 unknown 只是为了绕开这个类型
    // 推导误差，不影响运行时行为（instances 数组存的本来就是真实的 `this`）。
    const zip = (spy: typeof addSpy) =>
      spy.mock.calls.map((call, i) => ({ call, instance: spy.mock.instances[i] as unknown }))

    const onEl = zip(addSpy).filter(({ call, instance }) => instance === el && call[0] === 'beforeinput')
    expect(onEl.length).toBe(1) // 只注册一次，不是每次渲染都重复挂
    const [eventName, handler, capture] = onEl[0].call
    expect(eventName).toBe('beforeinput')
    expect(typeof handler).toBe('function')
    expect(capture).toBe(true) // 必须是捕获阶段——原理见 TerminalView.tsx 注释：要抢在 xterm 挂在 textarea 上的捕获阶段 input 监听器前面

    // 反向确认：没有误挂在 textarea 上。挂在 textarea 上会失去"先于 xterm 自己的监听器
    // 执行"这个前提（同节点同相位按注册顺序，xterm 在 term.open() 时就先注册了），修复
    // 会静默失效——这正是 TerminalView.tsx 注释里"为什么必须挂在父元素"的原因。
    const onTextarea = zip(addSpy).filter(({ call, instance }) => instance === textarea && call[0] === 'beforeinput')
    expect(onTextarea.length).toBe(0)

    unmount()

    const removedOnEl = zip(removeSpy).filter(({ call, instance }) => instance === el && call[0] === 'beforeinput')
    expect(removedOnEl.length).toBe(1) // 卸载时确实注销了，不是泄漏的监听器
    expect(removedOnEl[0].call[1]).toBe(handler) // 注销的是同一个函数引用——不是新建了一个导致原监听器漏卸载
    expect(removedOnEl[0].call[2]).toBe(true) // capture 标志也要匹配，否则 removeEventListener 是空操作，等于没卸载
  })
})
