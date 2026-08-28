// hooks 安装器的两处前端入口（spec §6）：
// - HooksPromptBar：主页顶部可关闭提示条，只在「未安装」/「已安装但过期」时出现。
// - HooksControl：设置区（侧边栏底部，与主题选择器同一处）的常驻手动入口——提示条被
//   关闭之后，这是唯一还能触发安装/更新/卸载的地方，因此不检查 dismissed。
// 两者都只读/写 store/hooksInstall.ts，不直接调用 ipc（保持"ipc.ts 只做纯 invoke 包装、
// 状态与副作用都在 store 层"的既有分层）。
import { hooksPhase, useHooksInstall } from '../store/hooksInstall'

const PROMPT_TEXT: Record<'notInstalled' | 'outdated', string> = {
  notInstalled: '安装 hooks 后，「等你回答」状态基于真实事件判定，不再依赖启发式猜测。',
  outdated: 'hooks 版本已过期，更新后「等你回答」状态才能继续保持精准。',
}

export function HooksPromptBar() {
  const status = useHooksInstall((s) => s.status)
  const dismissed = useHooksInstall((s) => s.dismissed)
  const pending = useHooksInstall((s) => s.pending)
  const error = useHooksInstall((s) => s.error)
  const phase = hooksPhase(status)

  // phase === null：还没查到状态，宁可不显示也不猜；upToDate：没什么好提示的；
  // dismissed：用户关过，见 store 里 DISMISS_KEY 的持久化说明。
  if (dismissed || phase === null || phase === 'upToDate') return null

  const actionLabel = phase === 'outdated' ? '更新' : '安装'
  return (
    <div className="hooks-prompt">
      <span className="hooks-prompt-text">{PROMPT_TEXT[phase]}</span>
      <span className="hooks-prompt-actions">
        <button
          type="button"
          className="hooks-prompt-install"
          disabled={pending}
          onClick={() => void useHooksInstall.getState().install()}
        >
          {pending ? `${actionLabel}中…` : actionLabel}
        </button>
        <button
          type="button"
          className="hooks-prompt-dismiss"
          aria-label="关闭提示"
          onClick={() => useHooksInstall.getState().dismiss()}
        >
          ×
        </button>
      </span>
      {error && <div className="hooks-prompt-error">{error}</div>}
    </div>
  )
}

const STATE_LABEL: Record<'notInstalled' | 'outdated' | 'upToDate', string> = {
  notInstalled: '未安装',
  outdated: '待更新',
  upToDate: '已安装',
}

export function HooksControl() {
  const status = useHooksInstall((s) => s.status)
  const pending = useHooksInstall((s) => s.pending)
  const error = useHooksInstall((s) => s.error)
  const phase = hooksPhase(status)

  const action = phase === 'notInstalled' ? 'install' : phase === 'outdated' ? 'update' : phase === 'upToDate' ? 'uninstall' : null
  const actionLabel = action === 'install' ? '安装' : action === 'update' ? '更新' : action === 'uninstall' ? '卸载' : ''
  const onClick = () => {
    if (action === 'uninstall') void useHooksInstall.getState().uninstall()
    else if (action) void useHooksInstall.getState().install()
  }

  return (
    <div className="hooks-control">
      <div className="hooks-control-row">
        <span className="hooks-control-label">Hooks：{phase ? STATE_LABEL[phase] : '查询中…'}</span>
        {action && (
          <button type="button" className="hooks-control-action" disabled={pending} onClick={onClick}>
            {pending ? `${actionLabel}中…` : actionLabel}
          </button>
        )}
      </div>
      {error && <div className="hooks-control-error">{error}</div>}
    </div>
  )
}
