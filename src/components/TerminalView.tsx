import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { ptyResize, ptyWrite } from '../ipc'
import { attachPty } from '../ptyBuffer'
import { useLayout } from '../store/layout'
import { useTheme } from '../store/theme'
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
    term.open(el)
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
      bufferChangeDisposable.dispose()
      ro.disconnect(); detach(); unsubTheme(); unsubFontSize(); term.dispose()
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
