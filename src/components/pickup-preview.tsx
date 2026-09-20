import { createPortal } from 'react-dom'
import { ArrowUpRight, Package, X } from 'lucide-react'
import * as React from 'react'
import { useT } from '@/lib/i18n'
import { pickupCodeFromUrl } from '@/lib/utils'

/**
 * 取件卡片预览：文章/评论中的 a.pickup-link（月品木子 ?q= 二字口令链接）
 * 点击后不直接跳转，而是弹出站内预览层用 iframe 加载该站解析口令；
 * 关闭/切换时清理超时定时器，杜绝迟到的误报（同彩蛋遮罩的教训）。
 * markdown 渲染产出的是静态 HTML（dangerouslySetInnerHTML），
 * 故用 document 级事件委托拦截点击；无 JS 时 <a href> 正常跳转降级。
 */
export function PickupPreviewHost() {
  const t = useT()
  const [preview, setPreview] = React.useState<{ href: string; code: string } | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [slow, setSlow] = React.useState(false)

  // loadedRef：6 秒定时器读最新加载状态，避免迟到的 onLoad 后仍误报
  const loadedRef = React.useRef(false)
  const timerRef = React.useRef<number | null>(null)
  const clearSlowTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 事件委托：拦截所有取件卡片点击（SSR HTML 直接可用，无需逐卡片挂载）
  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a.pickup-link') as HTMLAnchorElement | null
      if (!anchor) return
      const href = anchor.getAttribute('href')
      const code = href ? pickupCodeFromUrl(href) : null
      if (!href || !code) return
      e.preventDefault()
      loadedRef.current = false
      setLoaded(false)
      setSlow(false)
      setPreview({ href, code })
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // 慢加载检测：iframe 挂载后 6s 仍未 load 则提示可新标签打开
  const handleFrameMount = React.useCallback((el: HTMLIFrameElement | null) => {
    clearSlowTimer()
    if (!el) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (!loadedRef.current) setSlow(true)
    }, 6000)
  }, [clearSlowTimer])

  const close = React.useCallback(() => {
    clearSlowTimer()
    loadedRef.current = false
    setPreview(null)
    setLoaded(false)
    setSlow(false)
  }, [clearSlowTimer])

  React.useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [preview, close])

  if (!preview) return null

  return createPortal(
    <div
      className="modal-backdrop pickup-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
    >
      <div className="pickup-modal" role="dialog" aria-modal="true" aria-label={t('pickup.preview.title')}>
        <header className="pickup-head">
          <div className="pickup-title">
            <Package size={15} />
            <b>{t('pickup.preview.title')}</b>
            <span className="pickup-title-code">{preview.code}</span>
          </div>
          <div className="pickup-head-actions">
            <a className="games-ext" href={preview.href} target="_blank" rel="noreferrer">
              {t('pickup.preview.open')} <ArrowUpRight size={13} />
            </a>
            <button type="button" className="modal-close" onClick={close} aria-label={t('pickup.preview.close.aria')}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="pickup-stage">
          <iframe
            key={preview.href}
            ref={handleFrameMount}
            src={preview.href}
            title={t('pickup.preview.title')}
            className="pickup-frame"
            onLoad={() => { loadedRef.current = true; clearSlowTimer(); setLoaded(true); setSlow(false) }}
          />
          {!loaded && !slow && (
            <div className="games-loading" aria-live="polite">
              <span className="games-spinner" aria-hidden="true" />
              <p>{t('pickup.preview.loading')}</p>
            </div>
          )}
          {slow && !loaded && (
            <div className="games-blocked-hint">
              <p>{t('pickup.preview.slow')}</p>
              <a href={preview.href} target="_blank" rel="noreferrer" className="primary-button small">
                {t('pickup.preview.open')}
              </a>
              <button type="button" className="ghost-button" onClick={close}>
                {t('common.close')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
