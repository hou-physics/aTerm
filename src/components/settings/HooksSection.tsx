import { hooksPhase, useHooksInstall } from '../../store/hooksInstall'

// 从 src/components/HooksInstall.tsx 的 HooksControl 整体复制而来——不 import。
// Task 5 会删掉 HooksControl（设置区手动入口迁到这里之后就是死代码），若这里
// import 它，Task 5 一删这个分区就跟着炸；HooksPromptBar（主页顶部提示条）不受
// 影响、本文件不碰它，也不碰 HooksInstall.tsx。行为/文案/状态标签与原 HooksControl
// 逐字不变，只是 class 名换成 hooks-section-* 前缀，避免与将被删除的 .hooks-control
// 系列 CSS 耦合。
const STATE_LABEL: Record<'notInstalled' | 'outdated' | 'upToDate', string> = {
  notInstalled: '未安装',
  outdated: '待更新',
  upToDate: '已安装',
}

export function HooksSection() {
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
    <div className="hooks-section">
      <div className="hooks-section-row">
        <span className="hooks-section-label">Hooks：{phase ? STATE_LABEL[phase] : '查询中…'}</span>
        {action && (
          <button type="button" className="hooks-section-action" disabled={pending} onClick={onClick}>
            {pending ? `${actionLabel}中…` : actionLabel}
          </button>
        )}
      </div>
      {error && <div className="hooks-section-error">{error}</div>}
    </div>
  )
}
