import { hooksPhase, useHooksInstall } from '../../store/hooksInstall'
import { SettingCard } from './SettingCard'
import { SettingRow } from './SettingRow'

// 从 src/components/HooksInstall.tsx 的 HooksControl 整体复制而来——不 import。
// Task 5 会删掉 HooksControl（设置区手动入口迁到这里之后就是死代码），若这里
// import 它，Task 5 一删这个分区就跟着炸；HooksPromptBar（主页顶部提示条）不受
// 影响、本文件不碰它，也不碰 HooksInstall.tsx。行为/状态标签与原 HooksControl
// 逐字不变（v3-2c 只改呈现：换成 SettingCard/SettingRow，class 名换成
// hooks-section-* 前缀，避免与已被删除的 .hooks-control 系列 CSS 耦合）。
const STATE_LABEL: Record<'notInstalled' | 'outdated' | 'upToDate', string> = {
  notInstalled: '未安装',
  outdated: '待更新',
  upToDate: '已安装',
}

// 与 HooksInstall.tsx 的 PROMPT_TEXT.notInstalled 同一句话（那份文案是按 phase
// 区分的提示条文案，这里是常驻说明，不随 phase 变化——不管当前是哪个 phase，
// "装好之后状态怎么判定"这句话本身都成立，沿用同一措辞保持全仓库术语一致）。
const DESCRIPTION = '安装后，「等你回答」状态基于真实事件判定，不再依赖启发式猜测。'

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
      <SettingCard title="Hooks">
        <SettingRow
          label="Hooks"
          description={DESCRIPTION}
          control={
            <>
              <span className="hooks-section-status">{phase ? STATE_LABEL[phase] : '查询中…'}</span>
              {action && (
                <button type="button" className="hooks-section-action" disabled={pending} onClick={onClick}>
                  {pending ? `${actionLabel}中…` : actionLabel}
                </button>
              )}
            </>
          }
        />
        {error && <div className="hooks-section-error">{error}</div>}
      </SettingCard>
    </div>
  )
}
