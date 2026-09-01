import { useEffect, useRef } from 'react'
import { useSettings } from '../store/settings'
import { AppearanceSection } from './settings/AppearanceSection'

// 应用内设置浮层的容器。四个内容分区（外观 / 终端 / 项目与会话 / Hooks）本任务只留
// 占位——分别由后续任务把 <AppearanceSection />（Task 3）、<TerminalSection /> /
// <ProjectsSection /> / <HooksSection />（Task 4，三个合并一个任务，组件都放在
// src/components/settings/ 目录）挂进来，替换掉下面对应的占位 div。这里只负责浮层
// 本身：开关、遮罩、Esc/点遮罩关闭、焦点管理（含 Tab 焦点陷阱）。

// R1 修复 A：aria-modal="true" 是在向读屏软件承诺"背景内容已失活"，光有属性、Tab 仍
// 能跑到浮层背后是说谎。Task 3/4 马上要往四个空分区里塞真正的交互控件，届时"Tab 能
// 摸到侧栏"会变成"Tab 能摸到终端"，现在补最省事。选择器与 user-event 自身
// getTabDestination 所用的 FOCUSABLE_SELECTOR 同一思路（可见、非 disabled 的常见可
// 聚焦元素），但排除 tabIndex=-1——面板容器自己就是 tabIndex=-1，只用来接收初始焦点，
// 不应被算作 Tab 序列里的一员。
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(', ')

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

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

  // R1 修复 A：Tab 焦点陷阱。与上面的 Esc 效应分开写、互不影响——上面那段已经过评审，
  // 不改动。这里只处理 Tab/Shift+Tab：面板内没有可聚焦元素时钳在面板容器本身；正向
  // Tab 停在最后一个（或唯一一个）元素上时绕回第一个；Shift+Tab 停在第一个元素（或
  // 焦点还停在面板容器本身——刚打开、还没 Tab 过的那一瞬间）上时绕回最后一个。
  // getFocusableElements 在每次按键时现查 DOM，不是挂载时缓存一份列表——Task 3/4
  // 往分区里塞控件之后，陷阱范围自动跟着扩大，不需要再改这段。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = getFocusableElements(panel)
      if (focusable.length === 0) {
        // 边界 1：面板内没有可聚焦元素（当前四个分区都还是空占位，唯一可能触发这条
        // 路径的方式是关闭按钮本身也不在了）。什么都不做等于放任浏览器把焦点带出
        // 面板，所以钳回面板容器自身，不抛异常、不死循环。
        e.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      // 边界 2：只有一个可聚焦元素时 first === last，下面两个分支都会把焦点重新
      // 设置成它自己——等效于"停在原地"，不是特殊情况，不需要单独分支。
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || active === panel) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || active === panel) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  // R1 修复 B：遮罩关闭改用 pointerdown + contains() 判断，照抄 ContextMenu.tsx 的
  // idiom（三处既有浮层统一写法）。原来的 click + stopPropagation 拦不住"面板内
  // mousedown、拖到遮罩上 mouseup"——两者落在不同元素时，浏览器合成的 click 事件
  // target 是二者的最近公共祖先（也就是遮罩本身），这个 click 不是从面板冒泡上来的，
  // stopPropagation 对它完全无效，真实后果是拖选文字划出面板边缘就会把整个面板关掉。
  // pointerdown 只看"这次按下动作起点在不在面板内"，从机制上就不受这个影响。
  //
  // setTimeout 0 把监听器注册推迟一个 tick：打开浮层的那次 pointerdown（比如齿轮
  // 按钮）不该被这段新装上的监听器当场按"面板外点击"处理掉——与 ContextMenu.tsx
  // 同一注释、同一理由。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) closeSettings()
    }
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, closeSettings])

  if (!open) return null

  return (
    <div className="settings-scrim">
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
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
          <section className="settings-section" aria-label="外观">
            <AppearanceSection />
          </section>
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
