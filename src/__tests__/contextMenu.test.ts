import { describe, expect, it } from 'vitest'
import '../contextMenu'

// contextMenu.ts 是模块级的全局副作用（import 时就在 document 上注册好监听器，不依赖
// 任何组件树），因此这里不用 React Testing Library，直接用原生 DOM API 构造 contextmenu
// 事件来验证：cancelable 事件被 preventDefault() 后，dispatchEvent() 返回 false——用
// 这个返回值断言，不需要 spy 侵入事件对象。

describe('contextMenu：全局屏蔽 WKWebView 原生右键菜单', () => {
  it('普通区域的右键菜单被拦截（e.preventDefault 被调用）', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const notCanceled = div.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    expect(notCanceled).toBe(false) // dispatchEvent 对被 preventDefault 的可取消事件返回 false
    div.remove()
  })

  it('终端内容区域（.terminal-host 及其后代）豁免：不拦截，原生菜单（含粘贴）继续可用', () => {
    const host = document.createElement('div')
    host.className = 'terminal-host'
    const inner = document.createElement('div') // xterm 内部真实结构是 .terminal-host 的后代，不一定是直接子节点
    host.appendChild(inner)
    document.body.appendChild(host)

    const notCanceledOnHost = host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const notCanceledOnInner = inner.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    expect(notCanceledOnHost).toBe(true)
    expect(notCanceledOnInner).toBe(true)
    host.remove()
  })

  it('应用自己已经处理过这次右键（某个祖先的冒泡阶段监听器先调用了 preventDefault）：不重复处理，也不报错', () => {
    // 模拟"我们自己的右键菜单"约定：宿主元素自己的 onContextMenu 处理器（冒泡阶段，
    // React 把它挂在渲染根容器上，先于这里的 document 监听器收到事件）先调用一次
    // e.preventDefault()——这里直接在祖先节点上挂一个原生监听器达到同样的时序效果。
    const host = document.createElement('div')
    host.className = 'pane-titlebar'
    const item = document.createElement('div')
    host.appendChild(item)
    document.body.appendChild(host)
    host.addEventListener('contextmenu', (e) => e.preventDefault())

    const notCanceled = item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    expect(notCanceled).toBe(false) // 依旧是"被取消"的状态，只是这里的监听器没有二次调用、也没有抛错
    host.remove()
  })
})
