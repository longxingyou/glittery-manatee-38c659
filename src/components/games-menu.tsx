import { createPortal } from 'react-dom'
import { ArrowUpRight, Gamepad2, X } from 'lucide-react'
import * as React from 'react'
import { useT } from '@/lib/i18n'

/**
 * 彩蛋：标题栏「{}」图标唤起的小游戏中心。
 * 游戏全部以 iframe 内嵌第三方页面；若对方站点禁止被嵌入（X-Frame-Options / CSP），
 * 提供「在新标签打开」兜底入口。
 */
interface GameDef {
  id: string
  nameKey?: string
  descKey: string
  url: string
  /** 对方站点发送 X-Frame-Options 禁止内嵌：不渲染 iframe，直接给「新标签打开」引导 */
  noEmbed?: boolean
}

const GAMES: GameDef[] = [
  { id: 'chemiss', nameKey: 'games.chemiss.name', descKey: 'games.chemiss.desc', url: 'https://bil812.github.io/Chemiss/' },
  { id: 'tetris', nameKey: 'games.tetris.name', descKey: 'games.tetris.desc', url: 'https://chvin.github.io/react-tetris/' },
  // play2048.co 用 frame-ancestors 'self' 禁止第三方嵌入，改用无此限制的 2048.org
  { id: '2048', descKey: 'games.2048.desc', url: 'https://www.2048.org/' },
  // sudoku.com 发送 X-Frame-Options: SAMEORIGIN，只能新标签页打开
  { id: 'sudoku', nameKey: 'games.sudoku.name', descKey: 'games.sudoku.desc', url: 'https://sudoku.com/zh/', noEmbed: true },
]

/** 游戏显示名（2048 直接用 id） */
function gameName(g: GameDef, t: (k: string) => string): string {
  return g.nameKey ? t(g.nameKey) : g.id
}

/** 允许被 frame-src 嵌入的域名（与安全头中间件中的 CSP 保持一致） */
export const GAME_FRAME_HOSTS = GAMES.map((g) => new URL(g.url).host)

/** 注入 <link rel="dns-prefetch|preconnect">（幂等），加速第三方游戏站首次连接 */
function ensureWarmLink(rel: string, href: string) {
  if (typeof document === 'undefined') return
  const marker = `${rel}:${href}`
  if (document.querySelector(`link[data-sg-warm="${marker}"]`)) return
  const link = document.createElement('link')
  link.rel = rel
  link.href = href
  link.setAttribute('data-sg-warm', marker)
  document.head.appendChild(link)
}

function warmGameHosts(activeUrl: string) {
  // 全部候选域名先做廉价的 DNS 预解析，当前游戏域名升级为完整预连接
  for (const g of GAMES) ensureWarmLink('dns-prefetch', new URL(g.url).origin)
  ensureWarmLink('preconnect', new URL(activeUrl).origin)
}

export function GamesMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [activeId, setActiveId] = React.useState(GAMES[0]!.id)
  // 每次选中切换都换一个 key，强制 iframe 重新加载并重置超时检测
  const [frameKey, setFrameKey] = React.useState(0)
  const [loaded, setLoaded] = React.useState(false)
  const [suspectBlocked, setSuspectBlocked] = React.useState(false)
  const active = GAMES.find((g) => g.id === activeId) ?? GAMES[0]!

  // loadedRef：让超时定时器读到“最新”的加载状态。
  // 旧实现闭包捕获挂载时的 loaded=false：慢网下 iframe 超过 6s 才 load 成功，
  // 定时器仍按旧值弹出“在新标签页打开”遮罩且不再消失 —— 即线上反馈的遮挡 bug。
  const loadedRef = React.useRef(false)
  const timerRef = React.useRef<number | null>(null)
  const clearBlockTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [open, onClose])

  // 打开时预热第三方游戏站点连接（DNS/TLS 提前握手），切换游戏时预连新站
  React.useEffect(() => {
    if (!open) return
    warmGameHosts(active.url)
  }, [open, active.url])

  // 关闭时彻底复位：清掉超时、重置状态，避免下次打开闪现旧遮罩
  React.useEffect(() => {
    if (!open) {
      clearBlockTimer()
      loadedRef.current = false
      setLoaded(false)
      setSuspectBlocked(false)
    }
  }, [open, clearBlockTimer])

  // 卸载兜底清理
  React.useEffect(() => clearBlockTimer, [clearBlockTimer])

  const pick = (id: string) => {
    if (id === activeId) return
    clearBlockTimer()
    loadedRef.current = false
    setActiveId(id)
    setLoaded(false)
    setSuspectBlocked(false)
    setFrameKey((k) => k + 1)
  }

  if (!open) return null

  // X-Frame-Options 拦截时多数浏览器不会触发 iframe 的 load 事件；超时后提示用户外部打开。
  // ref 卸载（切游戏/关弹窗）时清除对应定时器，杜绝迟到的误报。
  const handleFrameMount = (el: HTMLIFrameElement | null) => {
    clearBlockTimer()
    if (!el) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      // 以 ref 为准：哪怕 load 在第 6 秒后才完成，也绝不弹遮罩
      if (!loadedRef.current) setSuspectBlocked(true)
    }, 6000)
  }

  const handleFrameLoad = () => {
    loadedRef.current = true
    clearBlockTimer()
    setLoaded(true)
    setSuspectBlocked(false)
  }

  return createPortal(
    <div className="modal-backdrop games-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="games-modal" role="dialog" aria-modal="true" aria-label={t('games.center')}>
        <header className="games-head">
          {/* 彩蛋：点击弹窗头部的 🎮 图标跳转到作者主站 */}
          <a
            className="brand-mark"
            style={{ color: 'var(--accent)' }}
            href="https://叫我.mom"
            aria-label={t('games.brand.link')}
            title={t('games.brand.link')}
          >
            <Gamepad2 size={15} /><span>arcade.secret</span>
          </a>
          <div className="games-tabs" role="tablist">
            {GAMES.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={g.id === activeId}
                title={t(g.descKey)}
                className={`games-tab${g.id === activeId ? ' on' : ''}`}
                onClick={() => pick(g.id)}
              >
                {gameName(g, t)}
              </button>
            ))}
          </div>
          <div className="games-head-actions">
            <a className="games-ext" href={active.url} target="_blank" rel="noreferrer" title={t('games.newtab.title')}>
              {t('games.newtab')} <ArrowUpRight size={13} />
            </a>
            <button type="button" className="modal-close" onClick={onClose} aria-label={t('games.close.aria')} title={t('common.close')}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="games-stage">
          {!active.noEmbed && (
            <iframe
              key={`${active.id}-${frameKey}`}
              ref={handleFrameMount}
              src={active.url}
              title={gameName(active, t)}
              className="games-frame"
              loading="lazy"
              allow="fullscreen; autoplay; gamepad"
              onLoad={handleFrameLoad}
            />
          )}
          {!active.noEmbed && !loaded && !suspectBlocked && (
            <div className="games-loading" aria-live="polite">
              <span className="games-spinner" aria-hidden="true" />
              <p>{t('games.loading')}</p>
            </div>
          )}
          {(active.noEmbed || suspectBlocked) && (
            <div className="games-blocked-hint">
              <p>{t('games.blocked')}</p>
              <a href={active.url} target="_blank" rel="noreferrer" className="primary-button small">
                {t('games.open.name', { name: gameName(active, t) })}
              </a>
              {!active.noEmbed && (
                <button type="button" className="ghost-button" onClick={() => setSuspectBlocked(false)}>
                  {t('games.blocked.dismiss')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
