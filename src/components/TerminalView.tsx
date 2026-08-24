import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ptyResize, ptyWrite } from '../ipc'
import { attachPty } from '../ptyBuffer'

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
      theme: { background: '#15161e', foreground: '#c0caf5' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    term.onData((d) => { void ptyWrite(ptyId, d) })

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
    return () => { ro.disconnect(); detach(); term.dispose() }
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
