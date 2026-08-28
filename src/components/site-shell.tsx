import { Link } from '@tanstack/react-router'
import {
  BookOpenText,
  Braces,
  ChevronDown,
  Files,
  Github,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  TerminalSquare,
  UserRound,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  AuthError,
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
  signup,
  type User,
} from '@netlify/identity'

export function SiteShell({ children, categories }: { children: React.ReactNode; categories: string[] }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="workbench">
      <header className="titlebar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开导航">
          <Menu size={17} />
        </button>
        <Link to="/" className="brand-mark"><Braces size={17} /><span>syntax.garden</span></Link>
        <nav className="top-menu" aria-label="主导航"><span>文件</span><span>编辑</span><span>选择</span><span>查看</span><span>转到</span></nav>
        <div className="title-command"><Search size={14} /><span>搜索文章、标签与灵感</span><kbd>⌘ K</kbd></div>
        <div className="window-actions"><ThemeToggle /><AuthButton /></div>
      </header>

      <aside className="activitybar" aria-label="快捷工具">
        <Link to="/" className="activity active" aria-label="文章"><Files size={22} /></Link>
        <button className="activity" aria-label="搜索"><Search size={21} /></button>
        <a className="activity" href="https://github.com" rel="noreferrer" aria-label="GitHub"><Github size={21} /></a>
        <div className="activity-spacer" />
        <button className="activity" aria-label="账户" onClick={() => window.dispatchEvent(new Event('open-auth'))}><UserRound size={21} /></button>
        <button className="activity" aria-label="设置"><Settings size={21} /></button>
      </aside>

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-mobile-head"><span>EXPLORER</span><button onClick={() => setSidebarOpen(false)}><X size={17} /></button></div>
        <div className="sidebar-title">探索</div>
        <div className="tree-section"><ChevronDown size={14} /><strong>SYNTAX.GARDEN</strong></div>
        <Link to="/" className="tree-item selected" onClick={() => setSidebarOpen(false)}><BookOpenText size={15} /><span>全部文章.md</span></Link>
        <div className="tree-caption">分类</div>
        {categories.map((category) => (
          <Link
            key={category}
            to="/category/$category"
            params={{ category }}
            className="tree-item"
            onClick={() => setSidebarOpen(false)}
          >
            <span className="file-dot" />
            <span>{category}.md</span>
          </Link>
        ))}
        <div className="sidebar-note"><TerminalSquare size={15} /><span>用代码、文字和公式记录思考。</span></div>
      </aside>

      <main className="editor-area">{children}</main>
      <footer className="statusbar"><span><Braces size={13} /> main*</span><span>0 errors</span><span className="status-spacer" /><span>UTF-8</span><span>Markdown</span><span>Ln 27, Col 8</span></footer>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" />}
    </div>
  )
}

function ThemeToggle() {
  const [dark, setDark] = useState(true)

  useEffect(() => setDark(document.documentElement.dataset.theme !== 'light'), [])

  const toggle = () => {
    const nextDark = !dark
    setDark(nextDark)
    document.documentElement.dataset.theme = nextDark ? 'dark' : 'light'
    localStorage.setItem('theme', nextDark ? 'dark' : 'light')
  }

  return <button className="icon-button" onClick={toggle} aria-label="切换主题">{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
}

function AuthButton() {
  const [user, setUser] = useState<User | null>(null)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getUser().then(setUser)
    handleAuthCallback().then((result) => {
      if (result?.user) {
        setUser(result.user)
        setNotice(result.type === 'confirmation' ? '邮箱验证成功，现在可以发表评论。' : '登录成功。')
        setOpen(true)
      }
    }).catch(() => undefined)
    const unsubscribe = onAuthChange((_, nextUser) => setUser(nextUser ?? null))
    const show = () => setOpen(true)
    window.addEventListener('open-auth', show)
    return () => { unsubscribe(); window.removeEventListener('open-auth', show) }
  }, [])

  const initials = useMemo(() => (user?.name || user?.email || '访客').slice(0, 2).toUpperCase(), [user])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') || '')
    const password = String(data.get('password') || '')
    const name = String(data.get('name') || '')
    try {
      if (mode === 'signup') {
        const created = await signup(email, password, { full_name: name })
        if (created.confirmedAt) {
          setUser(created); setNotice('账户已创建，可以发表评论。')
        } else {
          setNotice('验证邮件已发送，请点击邮件中的链接后再评论。')
        }
      } else {
        const loggedIn = await login(email, password)
        setUser(loggedIn); setNotice('欢迎回来，身份验证成功。')
      }
    } catch (caught) {
      setError(caught instanceof AuthError && caught.status === 401 ? '邮箱或密码不正确，或邮箱尚未验证。' : caught instanceof Error ? caught.message : '操作失败，请稍后重试。')
    } finally { setBusy(false) }
  }

  const signOut = async () => { await logout(); setUser(null); setOpen(false) }

  return (
    <>
      <button className="auth-chip" onClick={() => setOpen(true)}><span>{initials}</span><b>{user ? '已验证' : '登录'}</b></button>
      {open && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="auth-modal" role="dialog" aria-modal="true" aria-label="访客身份验证">
            <button className="modal-close" onClick={() => setOpen(false)}><X size={18} /></button>
            <div className="terminal-label">identity.verify()</div>
            <h2>{user ? '邮箱已验证' : mode === 'login' ? '继续这场讨论' : '创建访客身份'}</h2>
            <p>{user ? `当前账户：${user.email}` : '评论区只对完成邮箱验证的访客开放。'}</p>
            {user ? (
              <div className="verified-card"><span className="verified-pulse" /><div><strong>{user.name || user.email}</strong><small>verified contributor</small></div><button onClick={signOut}>退出</button></div>
            ) : (
              <form onSubmit={submit} className="auth-form">
                {mode === 'signup' && <label>显示名称<input name="name" required placeholder="例如：Lin" /></label>}
                <label>邮箱<input name="email" type="email" required placeholder="you@example.com" /></label>
                <label>密码<input name="password" type="password" minLength={8} required placeholder="至少 8 位" /></label>
                {error && <div className="form-message error">{error}</div>}
                {notice && <div className="form-message success">{notice}</div>}
                <button className="primary-button" disabled={busy}>{busy ? '正在连接…' : mode === 'login' ? '验证并登录' : '发送验证邮件'}</button>
                <button type="button" className="text-button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setNotice('') }}>{mode === 'login' ? '没有账户？注册' : '已有账户？登录'}</button>
              </form>
            )}
            {user && notice && <div className="form-message success">{notice}</div>}
          </section>
        </div>
      )}
    </>
  )
}
