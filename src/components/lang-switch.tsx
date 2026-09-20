import { Check, Languages } from 'lucide-react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { LANGS, useI18n, type Lang } from '@/lib/i18n'

/**
 * 语言切换器：地球图标按钮 + 下拉菜单（中 / EN / RU）。
 * - 桌面与手机通用，菜单项为大点击区域；
 * - 通过 Portal 挂到 body，避免标题栏 overflow 裁剪；
 * - 点击外部、Escape 或选择后关闭；
 * - compact: true 时仅显示图标（用于标题栏/后台 topbar）。
 */
export function LangSwitch({
  compact = true,
  className = '',
}: {
  compact?: boolean
  className?: string
}) {
  const { lang, setLang } = useI18n()
  const [open, setOpen] = React.useState(false)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [coords, setCoords] = React.useState({ top: 0, right: 0 })

  const openMenu = () => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setCoords({ top: rect.bottom + 6, right: window.innerWidth - rect.right })
    setOpen(true)
  }

  React.useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const pick = (code: Lang) => {
    setLang(code)
    setOpen(false)
  }

  const currentShort = LANGS.find((l) => l.code === lang)?.short ?? ''

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`icon-button lang-switch-btn ${open ? 'on' : ''} ${className}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Change language"
        title="Language · 语言 · Язык"
      >
        <Languages size={compact ? 16 : 17} />
        {!compact && <span className="lang-switch-short">{currentShort}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="lang-menu"
            role="listbox"
            aria-label="选择语言 / Select language"
            style={{ top: coords.top, right: coords.right }}
          >
            {LANGS.map((l) => (
              <button
                key={l.code}
                type="button"
                role="option"
                aria-selected={l.code === lang}
                className={`lang-option${l.code === lang ? ' on' : ''}`}
                onClick={() => pick(l.code)}
              >
                <span className="lang-option-label">{l.label}</span>
                <span className="lang-option-short">{l.short}</span>
                {l.code === lang && <Check size={14} className="lang-option-check" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
