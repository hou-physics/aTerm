// hooks 安装器的前端入口（spec §6）：
// - HooksPromptBar：主页顶部可关闭提示条，只在「未安装」/「已安装但过期」时出现。
// 设置区的常驻手动入口原本也在本文件（HooksControl），Task 5 把它迁到了设置浮层
// 的 settings/HooksSection.tsx（整体复制，不 import 本文件），旧的 HooksControl
// 因此在这里删除——迁移前后行为/文案/状态标签逐字不变，见 HooksSection.tsx 顶部
// 注释。本组件只读/写 store/hooksInstall.ts，不直接调用 ipc（保持"ipc.ts 只做纯
// invoke 包装、状态与副作用都在 store 层"的既有分层）。
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
