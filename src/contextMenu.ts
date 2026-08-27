// 屏蔽 WKWebView 自带右键菜单（用户反馈：右键一个标签时弹出的是系统 WebView 原生菜单，
// 只有一项「Reload」，与桌面应用的观感格格不入）。与 ptyBuffer.ts/closeRequest.ts 同一
// 引入方式——App.tsx 顶层 side-effect 导入，模块加载时就注册好这一个全局监听器，不需要
// 挂在任何组件树里。
//
// 两类区域刻意不拦截：
//
// 1) 应用自己已经处理过这次右键的地方——本应用弹出自己的菜单时，它的 onContextMenu
//    处理器自己会先调用一次 e.preventDefault()（PaneContextMenu 的宿主 .pane-titlebar、
//    TabBar.tsx 里标签自己的右键菜单都是这个约定）。React 把这些处理器挂在渲染根容器上，
//    在事件冒泡阶段，根容器先于 document 收到事件——因此这里只需要检查
//    `e.defaultPrevented`：为 true 就说明已经有别处处理过了，直接放行，不需要靠白名单
//    class/属性去识别"是不是我们自己的菜单"，新增任意一个右键菜单都自动免疫，不需要
//    回来改这个文件。
//
// 2) 终端内容区域（`.terminal-host`，xterm 的挂载点，见 TerminalView.tsx）——xterm.js
//    本身不监听 contextmenu、不用它做粘贴或任何其它交互（已通读 TerminalView.tsx 确认，
//    它没有注册任何 contextmenu 处理器，也没有开启 rightClickSelectsWord 之类的选项）。
//    但这个 App 目前没有实现"右键粘贴"这个终端应用里常见交互的替代方案（没有自己的
//    终端右键菜单），唯一能提供它的就是 WKWebView 原生右键菜单里的「粘贴」项——如果在
//    这里也无差别拦截，会让终端里的右键粘贴彻底失效，是一次不必要的能力倒退。因此这里
//    特意豁免终端区域，保留原生菜单（连带「Reload」这类无关项——但终端区域本来就不该
//    出现在标签栏那种场景下，用户反馈的截图针对的是标签，不是终端内容本身）。
document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.terminal-host')) return
  e.preventDefault()
})
