import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'

/**
 * 深色 / 浅色主题切换按钮。
 * 主题状态挂在 <html data-theme="dark|light">，持久化到 localStorage('theme')，
 * 全站（含管理后台）共享；首屏前的初始主题由 __root.tsx 内联脚本设定，避免闪烁。
 */
export function ThemeToggle({ className = 'icon-button' }: { className?: string }) {
  const t = useT()
  const [dark, setDark] = useState(true)

  useEffect(() => setDark(document.documentElement.dataset.theme !== 'light'), [])

  const toggle = () => {
    const nextDark = !dark
    setDark(nextDark)
    document.documentElement.dataset.theme = nextDark ? 'dark' : 'light'
    try {
      localStorage.setItem('theme', nextDark ? 'dark' : 'light')
    } catch {
      /* 隐私模式 / 存储被禁时仅本次会话生效 */
    }
  }

  return (
    <button type="button" className={className} onClick={toggle} aria-label={t('theme.toggle')} title={t('theme.toggle.title')}>
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  )
}
