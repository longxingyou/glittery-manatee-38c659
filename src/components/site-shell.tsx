import { Link, useLocation } from '@tanstack/react-router'
import {
  BookOpenText,
  Braces,
  CalendarDays,
  ChevronDown,
  Files,
  Github,
  Menu,
  Rss,
  Search,
  Settings,
  ShieldCheck,
  TerminalSquare,
  UserRound,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AuthRequestError,
  consumeUrlAuthParams,
  getUser,
  login,
  logout,
  onAuthChange,
  requestPasswordReset,
  resendConfirmation,
  resetPassword,
  signup,
  type AuthUser,
} from '@/lib/auth-client'

import { publishedPostsFn } from './public-fns'
import { GamesMenu } from './games-menu'
import { ThemeToggle } from './theme-toggle'
import { UserPanel } from './user-panel'
import { LangSwitch } from './lang-switch'
import { useT, useLang, useCatName } from '@/lib/i18n'
import { myCommentsFn } from './user-fns'
import { adminCommentsFn } from './admin-user-fns'
import { foldPostsForLang, type CategoryLabel, type PostData } from '@/lib/utils'

export function SiteShell({ children, categories }: { children: React.ReactNode; categories: CategoryLabel[] }) {
  const t = useT()
  const lang = useLang()
  const catName = useCatName()
  // 侧边栏选中项跟随当前路由：蓝色选中框随分区移动（文章详情归入「全部文章」）
  const { pathname } = useLocation()
  const decodedPath = (() => { try { return decodeURIComponent(pathname) } catch { return pathname } })()
  const activeAll = decodedPath === '/' || decodedPath.startsWith('/posts/')
  const activeArchive = decodedPath === '/archive' || decodedPath.startsWith('/archive/')
  const activeAdmin = decodedPath === '/admin' || decodedPath.startsWith('/admin/')
  const activeCat = (name: string) => decodedPath === `/category/${name}`
  // 侧边栏分类按当前语言的展示名排序（链接仍用权威中文名）
  const sortedCategories = useMemo(() => {
    const locale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en'
    return [...categories].sort((a, b) => catName(a.name).localeCompare(catName(b.name), locale))
  }, [categories, catName, lang])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [adminBadge, setAdminBadge] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [gamesOpen, setGamesOpen] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  // 用户未读警告数（用户中心打开后由面板广播），显示为齿轮红点
  const [warningCount, setWarningCount] = useState(0)

  // 同步当前登录用户（供搜索面板的评论搜索判断身份）
  useEffect(() => {
    getUser().then((u) => u && setUser(u))
    const unsubscribe = onAuthChange((nextUser) => setUser(nextUser ?? null))
    return () => { unsubscribe() }
  }, [])

  // ⌘K / Ctrl+K 打开搜索命令面板，Esc 关闭
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((v) => !v)
      } else if (event.key === 'Escape') {
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 根据服务端 adminStatus 判定是否为管理员（登录态变化时重新探测）
  useEffect(() => {
    let alive = true
    const probe = async () => {
      try {
        const res = await fetch('/api/comments?action=adminStatus', { credentials: 'same-origin' })
        const data = await res.json()
        if (alive) setAdminBadge(!!data?.status?.isAdmin)
      } catch {
        // 忽略网络失败，安全回退不显示
      }
    }
    void probe()
    return onAuthChange(() => { void probe() })
  }, [])

  // 用户中心广播未读警告数 → 齿轮红点；登出时清零
  useEffect(() => {
    const onWarnings = (e: Event) => {
      const n = Number((e as CustomEvent<number>).detail)
      setWarningCount(Number.isFinite(n) && n > 0 ? Math.min(n, 99) : 0)
    }
    const unsub = onAuthChange((next) => { if (!next) setWarningCount(0) })
    window.addEventListener('user-warnings', onWarnings)
    return () => { unsub(); window.removeEventListener('user-warnings', onWarnings) }
  }, [])

  return (
    <div className="workbench">
      <header className="titlebar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label={t('shell.openNav')} title={t('shell.openNav.title')}>
          <Menu size={17} />
        </button>
        <button type="button" className="brand-mark brand-glyph" onClick={() => setGamesOpen(true)} aria-label={t('shell.games.aria')} title={t('shell.games.title')}>
          <Braces size={17} />
        </button>
        <Link to="/" className="brand-mark brand-name" title={t('shell.home.title')}><span>syntax.garden</span></Link>
        <nav className="top-menu" aria-label="Main navigation"><span>{t('shell.menu.file')}</span><span>{t('shell.menu.edit')}</span><span>{t('shell.menu.select')}</span><span>{t('shell.menu.view')}</span><span>{t('shell.menu.go')}</span></nav>
        <button type="button" className="title-command" onClick={() => setSearchOpen(true)} aria-label={t('shell.search.aria')} title={t('shell.search.title')}>
          <Search size={14} /><span>{t('shell.search.cmd')}</span><kbd>⌘ K</kbd>
        </button>
        {/* 手机端：activitybar 与 title-command 均隐藏，用图标按钮补齐搜索入口 */}
        <button type="button" className="icon-button phone-only" onClick={() => setSearchOpen(true)} aria-label={t('shell.search.posts')} title={t('shell.search.posts')}>
          <Search size={16} />
        </button>
        <div className="window-actions">
          {adminBadge && (
            <Link to="/admin" className="admin-chip icon-button" title={t('shell.admin')} style={{ color: 'var(--accent)' }}>
              <ShieldCheck size={16} />
            </Link>
          )}
          {/* 手机端：用户中心齿轮（含未读警告红点），桌面端入口在 activitybar */}
          <button
            type="button"
            className="icon-button phone-only icon-button-badge"
            aria-label={t('user.center')}
            title={t('shell.usercenter.title')}
            onClick={() => window.dispatchEvent(new Event('open-user-panel'))}
          >
            <Settings size={16} />
            {warningCount > 0 && <span className="activity-badge">{warningCount}</span>}
          </button>
          <LangSwitch />
          <ThemeToggle /><AuthButton />
        </div>
      </header>

      <aside className="activitybar" aria-label={t('shell.activitybar')}>
        <Link to="/" className="activity active" aria-label={t('shell.activity.posts')} title={t('shell.activity.posts')}><Files size={22} /></Link>
        <button type="button" className="activity" aria-label={t('shell.activity.search')} title={t('shell.search.posts')} onClick={() => setSearchOpen(true)}><Search size={21} /></button>
        <a className="activity" href="/rss.xml" aria-label="RSS" title={t('shell.activity.rss')} target="_blank" rel="noreferrer"><Rss size={21} /></a>
        <a className="activity" href="https://github.com" rel="noreferrer" aria-label="GitHub" title="GitHub"><Github size={21} /></a>
        {adminBadge && (
          <Link to="/admin" className="activity" aria-label={t('shell.admin')} title={t('shell.admin')} style={{ color: 'var(--accent)' }}>
            <ShieldCheck size={21} />
          </Link>
        )}
        <div className="activity-spacer" />
        <button className="activity" aria-label={t('shell.activity.account')} title={t('shell.activity.account.title')} onClick={() => window.dispatchEvent(new Event('open-auth'))}><UserRound size={21} /></button>
        <button className="activity" aria-label={t('user.center')} title={t('shell.usercenter.title')}
          onClick={() => window.dispatchEvent(new Event('open-user-panel'))}>
          <Settings size={21} />
          {warningCount > 0 && <span className="activity-badge">{warningCount}</span>}
        </button>
      </aside>

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-mobile-head"><span>EXPLORER</span><button onClick={() => setSidebarOpen(false)}><X size={17} /></button></div>
        <div className="sidebar-title">{t('shell.explorer')}</div>
        <div className="tree-section"><ChevronDown size={14} /><strong>ThoracicTag4669</strong></div>
        <Link to="/" className={`tree-item${activeAll ? ' selected' : ''}`} onClick={() => setSidebarOpen(false)}><BookOpenText size={15} /><span>{t('shell.allposts.file')}</span></Link>
        <Link to="/archive" className={`tree-item${activeArchive ? ' selected' : ''}`} onClick={() => setSidebarOpen(false)}><CalendarDays size={15} /><span>{t('shell.archive.file')}</span></Link>
        {adminBadge && (
          <Link to="/admin" className={`tree-item${activeAdmin ? ' selected' : ''}`} onClick={() => setSidebarOpen(false)} style={{ color: 'var(--accent)' }}>
            <ShieldCheck size={15} /><span>{t('shell.admin.file')}</span>
          </Link>
        )}
        <div className="tree-caption">{t('shell.categories')}</div>
        {sortedCategories.map((category) => (
          <Link
            key={category.name}
            to="/category/$category"
            params={{ category: category.name }}
            className={`tree-item${activeCat(category.name) ? ' selected' : ''}`}
            onClick={() => setSidebarOpen(false)}
          >
            <span className="file-dot" />
            <span>{catName(category.name)}.md</span>
          </Link>
        ))}
        <div className="tree-caption">{t('shell.subscribe')}</div>
        <a className="tree-item" href="/rss.xml" target="_blank" rel="noreferrer" onClick={() => setSidebarOpen(false)}>
          <Rss size={15} /><span>{t('shell.rss.file')}</span>
        </a>
        <div className="sidebar-note"><TerminalSquare size={15} /><span>{t('shell.tagline')}</span></div>
      </aside>

      <main className="editor-area">{children}</main>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} user={user} isAdmin={adminBadge} />
      <GamesMenu open={gamesOpen} onClose={() => setGamesOpen(false)} />
      <UserPanel />
      <footer className="statusbar"><span><Braces size={13} /> main*</span><span>0 errors</span><span className="status-spacer" /><span>UTF-8</span><span>Markdown</span>
        <a className="status-host" href="https://workers.cloudflare.com" target="_blank" rel="noreferrer" title={t('shell.cf.title')}>
          <CloudflareGlyph /> {t('shell.cf.powered')}
        </a>
      </footer>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label={t('shell.closeNav')} />}
    </div>
  )
}

function CloudflareGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.5 15.5v.3c0 1-1.2 1.7-2.3 1.3l-7.4-3.1c-.4-.2-.5-.7-.2-1 .1-.2.4-.3.6-.2l7.4 3.1c.2.1.4 0 .4-.2v-.1H15c-.3 0-.5-.2-.5-.5s.2-.5.5-.5h2.1c.3 0 .5.2.5.5zM17.3 13.2h-2.6c-.3 0-.5-.2-.5-.5s.2-.5.5-.5h2.6c.4 0 .7-.1.9-.3l.1-.1c.1-.2.1-.4 0-.6l-4.9-9.8c-.1-.2-.3-.3-.5-.3s-.4.1-.5.3L7.7 11.2l-2.8-1.2c-.2-.1-.4-.1-.5.1-.1.2-.1.4 0 .5l3.5 3.3c-2.2.3-3.9.9-3.9 1.9 0 1.2 2.7 2 6.1 2s6.1-.9 6.1-2c0-.6-.7-1.1-1.8-1.5l2.2 0c.3 0 .5-.2.5-.5s-.2-.6-.4-.6z" />
    </svg>
  )
}

type AuthMode = 'login' | 'signup' | 'forgot' | 'reset' | 'confirmSent'

// 登录弹框宿主：监听 window 'open-auth' 事件并渲染弹框本体（不含触发 chip）。
// 独立于 SiteShell 存在——后台 /admin 路由不渲染 SiteShell，但门禁页的
// 「打开登录窗口」按钮也派发 open-auth，因此 __root 的 admin 分支同样挂载本宿主。
export function AuthModalHost() {
  const t = useT()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<AuthMode>('login')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmEmail, setConfirmEmail] = useState('')
  const [confirmNoticeType, setConfirmNoticeType] = useState<'success' | 'error'>('success')
  const [resendCountdown, setResendCountdown] = useState(0)
  const lastCredentialsRef = useRef<{ email: string; password: string }>({ email: '', password: '' })
  const resetTokenRef = useRef<string>('')

  useEffect(() => {
    getUser().then(setUser)
    // 邮件验证回跳（/?notice=…）与找回密码回跳（/?reset-token=…）
    const { notice: bootNotice, resetToken } = consumeUrlAuthParams()
    if (bootNotice) { setNotice(bootNotice); setOpen(true) }
    if (resetToken) { resetTokenRef.current = resetToken; setMode('reset'); setError(''); setOpen(true) }
    const unsubscribe = onAuthChange((nextUser) => setUser(nextUser ?? null))
    const show = () => setOpen(true)
    window.addEventListener('open-auth', show)
    return () => { unsubscribe(); window.removeEventListener('open-auth', show) }
  }, [])

  // 重发验证邮件冷却倒计时
  useEffect(() => {
    if (resendCountdown <= 0) return
    const timer = setTimeout(() => setResendCountdown((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCountdown])

  const switchMode = (next: AuthMode) => {
    setMode(next)
    setError('')
    setNotice('')
    setConfirmEmail('')
    setResendCountdown(0)
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') || '')
    const password = String(data.get('password') || '')
    const name = String(data.get('name') || '')
    try {
      if (mode === 'signup') {
        const created = await signup(email, password, name || undefined)
        if (created.user) {
          setNotice(created.autoConfirmed ? t('auth.created.auto') : t('auth.welcome'))
        } else {
          lastCredentialsRef.current = { email, password }
          setConfirmEmail(email)
          setConfirmNoticeType('success')
          setMode('confirmSent')
          setNotice(t('auth.confirm.sent', { email }))
          setResendCountdown(60)
        }
      } else if (mode === 'login') {
        const loggedIn = await login(email, password)
        setUser(loggedIn)
        // 关闭弹框：登录成功后身份已显示在 chip；若在后台门禁页，
        // AdminGateWrap 会经 onAuthChange 自动刷新进入仪表盘
        setOpen(false)
      } else if (mode === 'forgot') {
        const message = await requestPasswordReset(email)
        setNotice(message)
      } else if (mode === 'reset') {
        const resetTo = await resetPassword(resetTokenRef.current, password)
        setUser(resetTo); setNotice(t('auth.password.reset.auto'))
      }
    } catch (caught) {
      if (caught instanceof AuthRequestError && caught.data?.needConfirm) {
        lastCredentialsRef.current = { email, password }
        setConfirmEmail(email)
        setConfirmNoticeType('error')
        setMode('confirmSent')
        setNotice(t('auth.need.confirm'))
        setResendCountdown(0)
      } else {
        setError(caught instanceof Error ? caught.message : t('auth.op.fail'))
      }
    } finally { setBusy(false) }
  }

  const handleResend = async () => {
    if (resendCountdown > 0) return
    const { email, password } = lastCredentialsRef.current
    if (!email || !password) return
    setBusy(true); setError('')
    try {
      const result = await resendConfirmation(email, password)
      if (result.user) {
        setUser(result.user); setNotice(t('auth.created.auto'))
      } else {
        setConfirmNoticeType('success')
        setNotice(t('auth.resend.sent', { email }))
        setResendCountdown(60)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('auth.op.fail'))
    } finally { setBusy(false) }
  }

  const signOut = async () => { await logout(); setUser(null); setOpen(false) }

  const titleByMode: Record<AuthMode, string> = {
    login: t('auth.title.login'),
    signup: t('auth.title.signup'),
    forgot: t('auth.title.forgot'),
    reset: t('auth.title.reset'),
    confirmSent: t('auth.title.confirmSent'),
  }

  return (
    <>
      {open && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="auth-modal" role="dialog" aria-modal="true" aria-label={t('auth.modal.aria')}>
            <button className="modal-close" onClick={() => setOpen(false)} aria-label={t('common.close')} title={t('common.close')}><X size={18} /></button>
            <div className="auth-modal-body">
            <div className="terminal-label">identity.verify()</div>
            <h2>{user ? t('auth.email.verified') : titleByMode[mode]}</h2>
            <p>{user ? t('auth.current', { email: user.email }) : t('auth.only.verified')}</p>
            {user ? (
              <div className="verified-card"><span className="verified-pulse" /><div><strong>{user.name || user.email}</strong><small>verified contributor</small></div><button onClick={signOut}>{t('auth.signout')}</button></div>
            ) : mode === 'confirmSent' ? (
              <>
                {notice && <div className={`form-message ${confirmNoticeType}`}>{notice}</div>}
                {confirmEmail && <div className="confirm-email-hint">{confirmEmail}</div>}
                {error && <div className="form-message error">{error}</div>}
                <button type="button" className="primary-button" onClick={handleResend} disabled={busy || resendCountdown > 0}>
                  {resendCountdown > 0 ? t('auth.resend.cooldown', { n: resendCountdown }) : busy ? t('auth.connecting') : t('auth.resend')}
                </button>
                <button type="button" className="text-button" onClick={() => switchMode('login')}>{t('auth.back.login')}</button>
              </>
            ) : (
              <form onSubmit={submit} className="auth-form">
                {mode === 'signup' && <label>{t('auth.name')}<input name="name" maxLength={20} placeholder={t('auth.name.ph')} /></label>}
                {mode !== 'reset' && <label>{t('auth.email')}<input name="email" type="email" required placeholder="you@example.com" /></label>}
                {mode !== 'forgot' && <label>{t('auth.password')}<input name="password" type="password" minLength={8} required placeholder={mode === 'reset' ? t('auth.password.new.ph') : t('auth.password.ph')} /></label>}
                {error && <div className="form-message error">{error}</div>}
                {notice && <div className="form-message success">{notice}</div>}
                <button className="primary-button" disabled={busy}>
                  {busy
                    ? t('auth.connecting')
                    : mode === 'login'
                      ? t('auth.btn.login')
                      : mode === 'signup'
                        ? t('auth.btn.signup')
                        : mode === 'forgot'
                          ? t('auth.btn.forgot')
                          : t('auth.btn.reset')}
                </button>
                {mode === 'login' && (
                  <div className="auth-form-links">
                    <button type="button" className="text-button" onClick={() => switchMode('forgot')}>{t('auth.forgot.q')}</button>
                    <button type="button" className="text-button" onClick={() => switchMode('signup')}>{t('auth.no.account')}</button>
                  </div>
                )}
                {(mode === 'signup' || mode === 'forgot' || mode === 'reset') && (
                  <button type="button" className="text-button" onClick={() => switchMode('login')}>{t('auth.have.account')}</button>
                )}
              </form>
            )}
            {user && notice && <div className="form-message success">{notice}</div>}
            </div>
          </section>
        </div>
      )}
    </>
  )
}

// 顶栏触发 chip：仅负责展示当前身份并派发 open-auth；弹框状态由 AuthModalHost 持有。
function AuthButton() {
  const t = useT()
  const [user, setUser] = useState<AuthUser | null>(null)
  useEffect(() => {
    let alive = true
    getUser().then((u) => { if (alive) setUser(u) })
    const unsub = onAuthChange((u) => { if (alive) setUser(u ?? null) })
    return () => { alive = false; unsub() }
  }, [])
  const initials = (user?.name || user?.email || t('common.guest')).slice(0, 2).toUpperCase()
  return (
    <>
      <button className="auth-chip" onClick={() => window.dispatchEvent(new Event('open-auth'))} title={user ? t('auth.chip.in', { email: user.email }) : t('auth.chip.out')}>
        <span>{initials}</span><b>{user ? t('auth.verified') : t('auth.login')}</b>
      </button>
      <AuthModalHost />
    </>
  )
}

// =================================================================
// 搜索命令面板（⌘K）：文本 / 正则 双模式
// 匹配范围：标题 + 摘要 + 原始 Markdown/KaTeX 源码（post.content 是
// content-collections / 数据库中的原样 Markdown，例如公式源码 `x^2`，
// 而不是渲染后的 x²）。因此输入 `x^2`（文本模式）即可命中公式。
// =================================================================

type SearchMode = 'text' | 'regex'

type SearchHit = {
  post: PostData
  field: 'title' | 'summary' | 'content'
  snippet: string
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function snippetFor(re: RegExp, text: string) {
  const m = re.exec(text)
  if (!m) return ''
  const start = Math.max(0, m.index - 36)
  const end = Math.min(text.length, m.index + m[0].length + 44)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '')
}

type CommentHit = Awaited<ReturnType<typeof myCommentsFn>>[number]

function SearchPalette({ open, onClose, user, isAdmin }: { open: boolean; onClose: () => void; user: AuthUser | null; isAdmin: boolean }) {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('text')
  const [scope, setScope] = useState<'posts' | 'comments'>('posts')
  const [commentScope, setCommentScope] = useState<'mine' | 'all'>('mine')
  const [posts, setPosts] = useState<PostData[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [commentHits, setCommentHits] = useState<CommentHit[] | null>(null)
  const [commentLoading, setCommentLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 评论搜索（走服务器 myCommentsFn / adminCommentsFn）
  useEffect(() => {
    if (!open || scope !== 'comments' || (!user && !isAdmin)) { setCommentHits(null); return }
    let alive = true
    const kw = query.trim()
    setCommentLoading(true)
    const run = async () => {
      try {
        const data = isAdmin
          ? await adminCommentsFn({ data: { scope: commentScope, keyword: kw } })
          : await myCommentsFn({ data: { keyword: kw } })
        if (alive) setCommentHits(data)
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : t('search.err.comments'))
      } finally {
        if (alive) setCommentLoading(false)
      }
    }
    const debounce = setTimeout(run, 220)
    return () => { alive = false; clearTimeout(debounce) }
  }, [open, scope, query, commentScope, user, isAdmin, t])

  // 面板首次打开时拉取文章（含原始 content），之后缓存在内存中
  useEffect(() => {
    if (!open || posts) return
    publishedPostsFn()
      .then(setPosts)
      .catch((e) => setLoadError(e instanceof Error ? e.message : t('search.err.posts')))
  }, [open, posts, t])

  useEffect(() => {
    if (!open) return
    setLoadError('')
    // 三重聚焦：立即 + 首帧渲染后 + 兜底定时器。
    // 点击触发按钮后浏览器先把焦点给按钮，且面板首次布局完成前 focus 可能被覆盖，
    // 单次 focus 在部分场景下会失效，这里确保输入框在任何情况下都拿到焦点。
    inputRef.current?.focus()
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    const t = setTimeout(() => inputRef.current?.focus(), 120)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [open])

  // 搜索范围同样按当前语言折叠：同一篇文章只命中当前语言版本
  const visiblePosts = useMemo(() => (posts ? foldPostsForLang(posts, lang) : null), [posts, lang])

  const results = useMemo<{ hits: SearchHit[]; regexError: boolean }>(() => {
    const q = query.trim()
    if (!q || !visiblePosts) return { hits: [], regexError: false }
    let re: RegExp
    if (mode === 'regex') {
      try {
        re = new RegExp(q, 'i')
      } catch {
        return { hits: [], regexError: true }
      }
    } else {
      re = new RegExp(escapeRegExp(q), 'i')
    }
    const hits: SearchHit[] = []
    for (const post of visiblePosts) {
      const raw = post.content || ''
      if (re.test(post.title)) hits.push({ post, field: 'title', snippet: snippetFor(re, raw || post.summary || '') })
      else if (raw && re.test(raw)) hits.push({ post, field: 'content', snippet: snippetFor(re, raw) })
      else if (post.summary && re.test(post.summary)) hits.push({ post, field: 'summary', snippet: snippetFor(re, post.summary) })
      if (hits.length >= 50) break
    }
    return { hits, regexError: false }
  }, [query, mode, visiblePosts])

  if (!open) return null

  const emptyQuery = query.trim() === ''
  const recent = visiblePosts?.slice(0, 8) ?? []

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="search-palette" role="dialog" aria-modal="true" aria-label={t('shell.search.posts')}>
        <div className="terminal-label">workbench.search()</div>
        <div className="search-row">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={scope === 'posts' ? t('search.ph.posts') : (user || isAdmin) ? t('search.ph.comments') : t('search.ph.comments.guest')}
            aria-label={t('search.kw.aria')}
            disabled={scope === 'comments' && !user && !isAdmin}
          />
          <button type="button" className={`search-mode ${scope === 'posts' ? 'on' : ''}`} onClick={() => setScope('posts')}>{t('search.tab.posts')}</button>
          <button type="button" className={`search-mode ${scope === 'comments' ? 'on' : ''}`} onClick={() => setScope('comments')}>{t('search.tab.comments')}</button>
          {scope === 'posts' && (
            <>
              <button type="button" className={`search-mode ${mode === 'text' ? 'on' : ''}`} onClick={() => setMode('text')}>{t('search.mode.text')}</button>
              <button type="button" className={`search-mode ${mode === 'regex' ? 'on' : ''}`} onClick={() => setMode('regex')}>{t('search.mode.regex')}</button>
            </>
          )}
          {scope === 'comments' && isAdmin && (
            <select value={commentScope} onChange={(e) => setCommentScope(e.target.value as 'mine' | 'all')} className="search-comment-scope">
              <option value="mine">{t('search.scope.mine')}</option>
              <option value="all">{t('search.scope.all')}</option>
            </select>
          )}
        </div>
        <p className="search-hint">
          {scope === 'posts'
            ? mode === 'text'
              ? <>{t('search.hint.text.a')}<code>x^2</code>{t('search.hint.text.b')}</>
              : <>{t('search.hint.regex.a')}<code>{'x\\^2'}</code>{t('search.hint.regex.b')}<code>{'\\b[a-z]+\\^\\{2\\}'}</code>{t('search.hint.regex.c')}</>
            : (!user && !isAdmin)
              ? <>{t('search.hint.comments.guest')}</>
              : isAdmin
                ? <>{t('search.hint.comments.admin')}</>
                : <>{t('search.hint.comments.user')}</>}
        </p>
        {loadError && <div className="banner error small">{loadError}</div>}
        {results.regexError && <div className="banner error small">{t('search.regex.invalid')}</div>}
        {scope === 'posts' ? (
          <>
            <ul className="search-results">
              {(emptyQuery ? recent.map((post) => ({ post, field: 'title' as const, snippet: '' })) : results.hits).map((hit) => (
                <li key={hit.post.slug}>
                  <Link to="/posts/$slug" params={{ slug: hit.post.slug }} onClick={onClose}>
                    <strong>{hit.post.title}</strong>
                    <span className="search-hit-meta">
                      {hit.post.date}
                      {!emptyQuery && <b className="search-hit-field">{hit.field === 'title' ? t('search.field.title') : hit.field === 'summary' ? t('search.field.summary') : t('search.field.content')}</b>}
                      {hit.snippet && <em>{hit.snippet}</em>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {!emptyQuery && !results.regexError && results.hits.length === 0 && !loadError && (
              <p className="search-empty">{t('search.empty.posts')}</p>
            )}
            {emptyQuery && recent.length > 0 && <p className="search-empty">{t('search.recent')}</p>}
          </>
        ) : (
          <>
            <ul className="search-results">
              {(commentHits ?? []).map((c) => (
                <li key={c.id} className="search-comment-item">
                  <Link to="/posts/$slug" params={{ slug: c.postSlug }} onClick={onClose}>
                    <strong>{c.postTitle}</strong>
                    <span className="search-hit-meta">
                      {new Date(c.createdAt).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })}
                      {isAdmin && commentScope === 'all' && <b className="search-hit-field">{c.userName}</b>}
                      <em>{c.body}</em>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {commentLoading && <p className="search-empty">{t('search.comments.searching')}</p>}
            {!commentLoading && commentHits && commentHits.length === 0 && !loadError && (
              <p className="search-empty">{t('search.empty.comments')}</p>
            )}
            {!user && !isAdmin && <p className="search-empty">{t('search.comments.guest')}</p>}
          </>
        )}
      </section>
    </div>
  )
}
