import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

// 设置页专用的自定义下拉——原生 <select> 画不出色块预览，这里自己写一个"触发器
// 按钮 + 内联展开列表"的组合，不引入任何第三方下拉/popover 库（硬约束）。
//
// 无障碍走 WAI-ARIA「collapsible listbox button」这一套（不是 combobox）：触发器
// 是 <button aria-haspopup="listbox" aria-expanded>，焦点全程留在触发器上不挪进
// 列表——展开后用 aria-activedescendant 指向当前高亮项的 id，↑↓ 只改这个指针，
// 列表本身的每一项都不是可 Tab 到的独立焦点目标（不用 <button> 画选项，用
// role="option" 的 <div>）。这样设置浮层的 Tab 焦点陷阱
// （SettingsPanel.tsx 的 FOCUSABLE_SELECTOR 只认 `button:not([disabled])` 等）
// 不会因为一个下拉展开就多出 28 个可 Tab 停靠点，行为等价于原生 <select>：
// Tab 整体跳过这一个控件，不会钻进选项列表里。
//
// 点外面收起：照搬本仓库既有 idiom（ContextMenu.tsx / TabBar.tsx PlusMenu /
// SettingsPanel.tsx 遮罩三处共用的写法）——document 上 capture 阶段监听
// pointerdown，用 ref.contains() 判断是否点在控件外部，且用 setTimeout(0) 把
// 监听器的注册推迟到下一个宏任务，避免"展开这次 pointerdown 本身"被当场当成
// "点了外面"立刻自关。
//
// 列表内联渲染在组件内部、不 portal 到 document.body：设置浮层的 Tab 焦点陷阱靠
// `getFocusableElements(panel)` 在面板 DOM 子树里现查，portal 出去的节点不在这棵
// 子树里，会跑到陷阱抓不到的地方——即便列表本身不放可 Tab 元素，portal 仍然是
// 明确禁止的（见任务契约），这里不走那条路。

export type SettingSelectOption = {
  id: string
  label: string
  /** 可选色块预览颜色（如 [bg, fg, ansi1, ansi2, ansi4]）；不传时该项只显示文字
   *  ——主题模式的三个选项（默认/双主题跟随系统/手动选定）没有色块可预览。 */
  swatches?: string[]
}

export type SettingSelectProps = {
  /** 触发器的可访问名称，与所在 SettingRow 的可见 label 文案保持一致（如"浅色
   *  主题"），与 TerminalSection 的滑块 aria-label 同一惯例——控件自己的无障碍
   *  名称不依赖"恰好挨着一段可见文字"这种脆弱关联。 */
  ariaLabel: string
  options: SettingSelectOption[]
  value: string
  onChange: (id: string) => void
  /** 原生 disabled：SettingRow 的 disabled 只管呈现，控件禁不禁用是调用方自己的
   *  责任，见 SettingRow.tsx 顶部契约注释。这里透传给触发器的原生 <button disabled>。 */
  disabled?: boolean
}

function Swatches({ colors }: { colors: string[] }) {
  return (
    <span className="setting-select-swatches">
      {colors.map((c, i) => (
        // 色块取自主题数据（Theme.bg/fg/ansi[i]），不是硬编码样式色值——数据不是
        // 样式，与 ThemeRow 原版做法一致（见 AppearanceSection.tsx 改造前的
        // ThemeRow/PREVIEW_ANSI_INDEXES 注释）。
        <span key={i} className="setting-select-swatch" style={{ background: c }} />
      ))}
    </span>
  )
}

export function SettingSelect({ ariaLabel, options, value, onChange, disabled = false }: SettingSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const domId = useId()

  const selectedIndex = Math.max(0, options.findIndex((o) => o.id === value))
  const selected = options[selectedIndex]

  // 调用方切换 disabled（比如切主题模式导致这一行不再适用）时，若这个下拉当时
  // 恰好展开着，强制收起——禁用态的控件不该还挂着一个打开的列表。
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  const openList = () => {
    setActiveIndex(selectedIndex)
    setOpen(true)
  }

  const commit = (index: number) => {
    const opt = options[index]
    if (!opt) return
    if (opt.id !== value) onChange(opt.id)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      // Enter/Space 展开——原生 <button> 在真实浏览器里对这两个键本就会触发
      // click（默认行为），这里显式处理是为了不依赖那层"按键→合成 click"的
      // 翻译在测试环境（fireEvent.keyDown）里是否存在，两套调用路径最终都落到
      // 同一个 openList()。
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openList()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => Math.min(options.length - 1, i + 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => Math.max(0, i - 1))
        break
      case 'Enter':
        e.preventDefault()
        commit(activeIndex)
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        break
      default:
        break
    }
  }

  const activeOptionDomId = `${domId}-option-${activeIndex}`

  return (
    <div className="setting-select" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="setting-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-activedescendant={open ? activeOptionDomId : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onTriggerKeyDown}
      >
        {selected?.swatches && <Swatches colors={selected.swatches} />}
        <span className="setting-select-trigger-label">{selected?.label ?? ''}</span>
        <span className="setting-select-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="setting-select-list" role="listbox" aria-label={ariaLabel}>
          {options.map((opt, i) => (
            <div
              key={opt.id}
              id={`${domId}-option-${i}`}
              role="option"
              aria-selected={opt.id === value}
              className={i === activeIndex ? 'setting-select-option active' : 'setting-select-option'}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => commit(i)}
            >
              {opt.swatches && <Swatches colors={opt.swatches} />}
              <span className="setting-select-option-label">{opt.label}</span>
              {opt.id === value && (
                <span className="setting-select-option-check" aria-hidden="true">✓</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
