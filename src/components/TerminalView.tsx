import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { ptyResize, ptyWrite } from '../ipc'
import { attachPty } from '../ptyBuffer'
import { useLayout } from '../store/layout'
import { useTheme } from '../store/theme'
import { registerPaste } from '../terminalPaste'
import { registerSerializer } from '../termSerialize'
import { buildXtermTheme } from '../themes/derive'
import { createWheelAmplifier, wheelDeltaToLines } from '../wheel'

// alt-screen（Claude Code 等 TUI）下滚轮换算的放大倍数，便于调参。
const ALT_WHEEL_MULTIPLIER = 3

// xterm 的主题现在直接来自 src/themes 里挑选出的真实 Theme（见 buildXtermTheme），不再是
// 这里手写的两档硬编码色值——这样终端配色与全站 UI 配色（见 App.css / themes/derive.ts）
// 才能共用同一套调色板数据。

export function TerminalView({ ptyId, active }: { ptyId: string; active: boolean }) {
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)

  useEffect(() => { activeRef.current = active }, [active])

  useEffect(() => {
    const el = elRef.current!
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: useLayout.getState().fontSize,
      cursorBlink: true,
      scrollback: 10000,
      // 默认 1 档对触控板过慢；按住 Option 走 fastScroll 档。
      scrollSensitivity: 5,
      fastScrollSensitivity: 12,
      theme: buildXtermTheme(useTheme.getState().activeTheme),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const serializeAddon = new SerializeAddon()
    term.loadAddon(serializeAddon)
    term.open(el)

    // ============================================================================
    // [ime] macOS 中文输入法首字符绕行 —— 详细取证与推导过程见
    // .superpowers/sdd/ime-fix-report.md；私有字段假设的钉子测试见
    // src/__tests__/xtermKeyDownSeenGuard.test.ts；监听器注册/注销的测试见
    // src/__tests__/TerminalView.imeBeforeInputGuard.test.tsx。
    //
    // 现象：用中文输入法在终端里打第一个 ？/（ 之类的全角标点，需要按两次才出字；
    // 之后每个都正常。只有终端里会，主页搜索框不受影响。
    //
    // 根因是 @xterm/xterm 自身的上游缺陷，不是这个仓库的代码问题：xterm 在 textarea 的
    // input 事件处理里（_inputEvent）用这条门禁判断"这次插入是不是已经在别处处理过了"：
    //   (!e.composed || !this._keyDownSeen)
    // input 事件的 composed 恒为 true，所以这条门禁实际只看 `!this._keyDownSeen`——
    // "看到过 keydown 就不发"。而 `_keyDownSeen` 只有两处赋值：_keyDown() 里置 true，
    // _keyUp() 里置 false——xterm 隐含假定 input 一定发生在这次按键自己的 keydown 之后。
    //
    // 但真机取证显示：macOS 中文输入法打标点时，input 早于这次按键自己的 keydown 到达
    // （顺序是 beforeinput → input → keydown code=229）。于是 `_keyDownSeen` 反映的其实
    // 是"上一个键"的状态——用户按住 Shift 打第一个标点时，Shift 的 keydown 刚把标志置
    // true、还没来得及 keyup，这个标点字符就被上面那条门禁悄悄丢弃了；标点自己的 keyup
    // 会清掉标志，所以第二次按同一个键就正常放行——这正是"要按两次才出字"的由来。
    //
    // 绕行思路：赶在 input 事件到达之前，把 `_keyDownSeen` 强行置回 false，造出一个
    // "没见过 keydown"的假象，放行这次插入。选在 beforeinput（发生在 input 之前）、且
    // 注册在终端容器元素（textarea 的父元素，也就是这个 effect 里的 el）上、且是捕获
    // 阶段：DOM 捕获阶段从 window 往下走，父元素上的监听器先于 textarea 上的监听器
    // 执行；而 xterm 自己的 input 监听器就注册在 textarea 上（捕获阶段，term.open() 时
    // 就已经挂上）。挂在 textarea 上不行——同一节点同相位按注册顺序，xterm 比我们先
    // 注册，会抢先跑完。
    //
    // 为什么不会让普通按键（空格、字母……）变成发送两次：_inputEvent 里在这条门禁
    // 之后还有一道独立的守卫 `if (this._keyPressHandled) return false`。普通可打印字符
    // 会先经过 keydown → keypress 路径——_keyPress() 在那里已经把数据发送出去、并把
    // _keyPressHandled 置 true；beforeinput/input 随后才到达，此时 _keyPressHandled
    // 仍是 true，这道守卫会拦下第二次发送（_keyPressHandled 只在 _keyPress() 置 true、
    // _keyUp() 置 false 两处被赋值，已核对成立）。而中文输入法合成插入的标点不会触发
    // keypress 事件，_keyPressHandled 在这一轮里从未被置 true，所以门禁一放行就能送达。
    //
    // 防御性检测：`_keyDownSeen` 是 xterm 完全未公开的私有字段，升级后随时可能改名或
    // 删除。取不到时绝不能抛错、更不能静默失败得让这个功能一次都没工作过——本仓库在
    // Tauri 权限那次已经吃过一次这种亏（见 e476b35/ff9d734/src/__tests__/tauriAcl.test.ts
    // 顶部注释），同样的错不能再犯第二遍。所以这里只 console.warn 一次留下痕迹，然后
    // 什么都不做：这条绕行会失效、中文输入法首字符会丢，但不会把整个终端打崩。
    // src/__tests__/xtermKeyDownSeenGuard.test.ts 钉住了这个私有字段的名字还在——升级后
    // 一旦被改名，那条测试会当场变红，而不是让这个问题悄悄回归。
    // ============================================================================
    let imeKeyDownSeenWarned = false
    const onImeBeforeInput = (e: Event) => {
      const ie = e as InputEvent
      if (ie.inputType !== 'insertText' || !ie.data) return
      const core = (term as unknown as { _core?: { _keyDownSeen?: boolean } })._core
      if (!core || typeof core._keyDownSeen !== 'boolean') {
        if (!imeKeyDownSeenWarned) {
          imeKeyDownSeenWarned = true
          console.warn(
            '[ime] xterm._core._keyDownSeen 取不到（@xterm/xterm 内部结构可能已变化）——' +
              '中文输入法首字符绕行本次跳过，不再重试。见 src/__tests__/xtermKeyDownSeenGuard.test.ts。',
          )
        }
        return
      }
      core._keyDownSeen = false
    }
    el.addEventListener('beforeinput', onImeBeforeInput, true)

    el.classList.toggle('alt-screen', term.buffer.active.type === 'alternate')
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => { webgl.dispose() }) // 上下文丢失时退回 DOM 渲染
      term.loadAddon(webgl)
    } catch (e) {
      console.warn('WebGL 渲染不可用，回退 DOM 渲染', e)
    }
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    term.onData((d) => { void ptyWrite(ptyId, d) })
    // 拖放文件到本窗格（App.tsx）需要把它当一次「粘贴」投递给这个终端实例——term.paste()
    // 会按当前是否开启括号粘贴模式自动包裹标记，是 Claude TUI 把它识别成图片附件的关键
    // （见 terminalPaste.ts 顶部注释）。它会触发上面这个 onData，数据照常流到 PTY。
    const unregisterPaste = registerPaste(ptyId, (text) => term.paste(text))
    const unregisterSerializer = registerSerializer(ptyId, () => serializeAddon.serialize())

    // alt-screen（Claude Code 等 TUI）：无回滚，xterm 会渲染一条无意义的满高滚动条——切到该 buffer 时隐藏它；
    // 同时清空滚轮累积余量，避免残留分数跨模式泄漏。
    let wheelRemainder = 0
    const bufferChangeDisposable = term.buffer.onBufferChange(() => {
      el.classList.toggle('alt-screen', term.buffer.active.type === 'alternate')
      wheelRemainder = 0
    })

    // alt-screen 下 xterm 把滚轮转成方向键序列发给应用，scrollSensitivity 不生效，默认体验很慢很粘；
    // 这里接管滚轮事件自己换算成方向键，实现加速。
    const amplifyMouseWheel = createWheelAmplifier(useLayout.getState().wheelMultiplier)
    term.attachCustomWheelEventHandler((ev) => {
      if (term.buffer.active.type !== 'alternate') return true
      if (term.modes.mouseTrackingMode !== 'none') {
        // 应用自己在处理鼠标滚轮（Claude TUI 即如此）。不自行拼接转义序列——
        // 编码协议未知（SGR 1006 / urxvt / X10）；改为在同一目标上补发合成事件，交由 xterm 按当前协议编码。
        if (ev.target) amplifyMouseWheel(ev.target, ev)
        return true // 原始事件仍交给 xterm 正常处理
      }
      const rows = term.rows || 1
      const cellH = (el.clientHeight || rows * 17) / rows
      const { lines, remainder } = wheelDeltaToLines(ev.deltaY, ev.deltaMode, rows, cellH, ALT_WHEEL_MULTIPLIER, wheelRemainder)
      wheelRemainder = remainder
      if (lines === 0) return false
      const prefix = term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['
      const key = lines > 0 ? 'B' : 'A'
      const n = Math.min(Math.abs(lines), 40) // 单次事件封顶，避免刷屏
      void ptyWrite(ptyId, (prefix + key).repeat(n))
      return false
    })

    // ⌘⇧D：打印一行诊断信息（仅本地渲染，不发送给 shell），用于确认 buffer/鼠标模式等运行时真实状态。
    const onDiagKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey && e.shiftKey && e.key.toLowerCase() === 'd')) return
      if (!activeRef.current) return
      e.preventDefault()
      const rows = term.rows || 1
      const cellH = (el.clientHeight || rows * 17) / rows
      const wheelAmp =
        term.buffer.active.type !== 'alternate' ? 'off' :
        term.modes.mouseTrackingMode !== 'none' ? `mouse×${useLayout.getState().wheelMultiplier}` :
        `keys×${ALT_WHEEL_MULTIPLIER}`
      term.write(
        `\r\n\x1b[90m[aTerm 诊断] buffer=${term.buffer.active.type} mouse=${term.modes.mouseTrackingMode} ` +
        `appCursor=${term.modes.applicationCursorKeysMode} rows=${term.rows} cols=${term.cols} ` +
        `cellH=${cellH.toFixed(1)} fontSize=${term.options.fontSize} wheelAmp=${wheelAmp}\x1b[0m\r\n`,
      )
    }
    window.addEventListener('keydown', onDiagKeyDown)

    const unsubTheme = useTheme.subscribe((state, prevState) => {
      if (state.activeTheme.id !== prevState.activeTheme.id) {
        term.options.theme = buildXtermTheme(state.activeTheme)
      }
    })

    let fontSizeFrame = 0
    const unsubFontSize = useLayout.subscribe((state, prevState) => {
      if (state.fontSize === prevState.fontSize) return
      term.options.fontSize = state.fontSize
      if (fontSizeFrame) { cancelAnimationFrame(fontSizeFrame); fontSizeFrame = 0 }
      if (el.clientWidth === 0) return // 隐藏标签跳过 fit，激活时的 fit 会带上新字号
      fontSizeFrame = requestAnimationFrame(() => {
        fontSizeFrame = 0
        if (el.clientWidth === 0) return // 帧执行时容器可能已被隐藏
        fit.fit()
        void ptyResize(ptyId, term.cols, term.rows)
      })
    })

    const detach = attachPty(
      ptyId,
      (bytes) => term.write(bytes),
      () => term.write('\r\n\x1b[90m[进程已退出，可关闭此标签]\x1b[0m\r\n'),
    )

    let resizeFrame = 0
    const ro = new ResizeObserver(() => {
      if (resizeFrame) { cancelAnimationFrame(resizeFrame); resizeFrame = 0 }
      if (el.clientWidth === 0) return // 隐藏时跳过，并已取消挂起帧
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0
        if (el.clientWidth === 0) return // 帧执行时容器可能已被隐藏
        fit.fit()
        void ptyResize(ptyId, term.cols, term.rows)
      })
    })
    ro.observe(el)
    return () => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      if (fontSizeFrame) cancelAnimationFrame(fontSizeFrame)
      window.removeEventListener('keydown', onDiagKeyDown)
      // [ime] 中文输入法首字符绕行注销 —— 与上方 el.addEventListener 成对，见那段注释。
      el.removeEventListener('beforeinput', onImeBeforeInput, true)
      bufferChangeDisposable.dispose()
      ro.disconnect(); detach(); unsubTheme(); unsubFontSize(); unregisterPaste(); unregisterSerializer(); term.dispose()
    }
  }, [ptyId])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        termRef.current?.focus()
        const t = termRef.current
        if (t) void ptyResize(ptyId, t.cols, t.rows)
      })
    }
  }, [active, ptyId])

  return <div ref={elRef} className="terminal-host" />
}
