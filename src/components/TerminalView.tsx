import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { ptyResize, ptyWrite } from '../ipc'
import { attachPty } from '../ptyBuffer'
import { useTheme } from '../store/theme'

const XTERM_THEME: Record<'dark' | 'light', ITheme> = {
  dark: { background: '#15161e', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#3d59a166' },
  light: { background: '#ffffff', foreground: '#2a2a35', cursor: '#2a2a35', selectionBackground: '#3d59a133' },
}

export function TerminalView({ ptyId, active }: { ptyId: string; active: boolean }) {
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const el = elRef.current!
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: XTERM_THEME[useTheme.getState().resolved],
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
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

    const unsubTheme = useTheme.subscribe((state, prevState) => {
      if (state.resolved !== prevState.resolved) {
        term.options.theme = XTERM_THEME[state.resolved]
      }
    })

    const detach = attachPty(
      ptyId,
      (bytes) => term.write(bytes),
      () => term.write('\r\n\x1b[90m[进程已退出，可关闭此标签]\x1b[0m\r\n'),
    )

    const ro = new ResizeObserver(() => {
      if (el.clientWidth === 0) return // 隐藏时跳过
      fit.fit()
      void ptyResize(ptyId, term.cols, term.rows)
    })
    ro.observe(el)
    return () => { ro.disconnect(); detach(); unsubTheme(); term.dispose() }
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
