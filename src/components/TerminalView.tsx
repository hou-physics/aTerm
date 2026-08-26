import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { ptyResize, ptyWrite } from '../ipc'
import { attachPty } from '../ptyBuffer'
import { useLayout } from '../store/layout'
import { useTheme } from '../store/theme'
import { wheelDeltaToLines } from '../wheel'

// alt-screen（Claude Code 等 TUI）下滚轮换算的放大倍数，便于调参。
const ALT_WHEEL_MULTIPLIER = 3

// 滚动条滑块颜色必须走主题设置：xterm 的 SmoothScrollableElement 把颜色写成内联样式，CSS 规则会被覆盖。
const XTERM_THEME: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#15161e', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#3d59a166',
    scrollbarSliderBackground: 'rgba(192,202,245,0.35)',
    scrollbarSliderHoverBackground: 'rgba(192,202,245,0.55)',
    scrollbarSliderActiveBackground: 'rgba(192,202,245,0.75)',
  },
  light: {
    background: '#ffffff', foreground: '#2a2a35', cursor: '#2a2a35', selectionBackground: '#3d59a133',
    scrollbarSliderBackground: 'rgba(42,42,53,0.35)',
    scrollbarSliderHoverBackground: 'rgba(42,42,53,0.55)',
    scrollbarSliderActiveBackground: 'rgba(42,42,53,0.75)',
  },
}

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
      theme: XTERM_THEME[useTheme.getState().resolved],
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
    // 这里接管滚轮事件自己换算成方向键，实现加速。应用自己接管鼠标上报时原样放行。
    term.attachCustomWheelEventHandler((ev) => {
      if (term.buffer.active.type !== 'alternate') return true
      if (term.modes.mouseTrackingMode !== 'none') return true
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
      term.write(
        `\r\n\x1b[90m[aTerm 诊断] buffer=${term.buffer.active.type} mouse=${term.modes.mouseTrackingMode} ` +
        `appCursor=${term.modes.applicationCursorKeysMode} rows=${term.rows} cols=${term.cols} ` +
        `cellH=${cellH.toFixed(1)} fontSize=${term.options.fontSize}\x1b[0m\r\n`,
      )
    }
    window.addEventListener('keydown', onDiagKeyDown)

    const unsubTheme = useTheme.subscribe((state, prevState) => {
      if (state.resolved !== prevState.resolved) {
        term.options.theme = XTERM_THEME[state.resolved]
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
