import { useEffect, useRef } from 'react'
import { useSettings } from '../store/settings'

// 应用内设置浮层的容器。四个内容分区（外观 / 终端 / 项目与会话 / Hooks）本任务只留
// 占位——分别由后续任务把 <AppearanceSection />（Task 3）、<TerminalSection /> /
// <ProjectsSection /> / <HooksSection />（Task 4，三个合并一个任务，组件都放在
// src/components/settings/ 目录）挂进来，替换掉下面对应的占位 div。这里只负责浮层
// 本身：开关、遮罩、Esc/点遮罩关闭、焦点管理。
export function SettingsPanel() {
  const open = useSettings((s) => s.open)
  const closeSettings = useSettings((s) => s.closeSettings)
  const panelRef = useRef<HTMLDivElement>(null)
  // 打开浮层那一刻，记下当时持有焦点的元素（触发按钮），关闭时把焦点还给它——
  // 键盘/屏幕阅读器用户不会因为打开设置而丢失原本的焦点位置。
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // Esc 关闭：只在打开时监听 window 的 keydown，关闭后立即移除，避免面板不在时
  // 仍然全局吃 Esc 键。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, closeSettings])

  // 焦点管理：打开时把焦点移进面板本身（面板加 tabIndex={-1} 使其可聚焦）；
  // 关闭时把焦点还给打开它的那个元素。
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null
      panelRef.current?.focus()
    } else {
      previouslyFocusedRef.current?.focus()
      previouslyFocusedRef.current = null
    }
  }, [open])

  if (!open) return null

  return (
    <div className="settings-scrim" onClick={closeSettings}>
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-panel-header">
          <span className="settings-panel-title">设置</span>
          <button
            type="button"
            className="settings-panel-close"
            aria-label="关闭设置"
            onClick={closeSettings}
          >
            ×
          </button>
        </div>
        <div className="settings-panel-body">
          {/* Task 3：外观分区——<AppearanceSection />（主题模式 + 主题选择器迁入） */}
          <section className="settings-section" aria-label="外观" />
          {/* Task 4：终端分区——<TerminalSection />（滚动速度等） */}
          <section className="settings-section" aria-label="终端" />
          {/* Task 4：项目与会话分区——<ProjectsSection />（隐藏项目 / 已移除会话） */}
          <section className="settings-section" aria-label="项目与会话" />
          {/* Task 4：Hooks 分区——<HooksSection />（hooks 安装器迁入） */}
          <section className="settings-section" aria-label="Hooks" />
        </div>
      </div>
    </div>
  )
}
