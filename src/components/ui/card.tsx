import * as React from 'react'
import { createServerFn } from '@tanstack/react-start'
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import {
  Bold,
  CirclePlus,
  Code2,
  Eye,
  FileDown,
  FileText,
  FolderTree,
  GripVertical,
  Hash,
  Home,
  Italic,
  LayoutDashboard,
  List,
  ListOrdered,
  Lock,
  LockOpen,
  LogOut,
  Newspaper,
  Package,
  Quote,
  Save,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Tags,
  TerminalSquare,
  Trash2,
  Upload,
  UserRound,
  Users,
  Inbox,
  MessageSquareWarning,
  Eraser,
  ImageIcon,
  Menu,
  Pencil,
  X,
} from 'lucide-react'
import { z } from 'zod'

import { cn, pickupCodeFromInput, pickupMarkdown } from '@/lib/utils'
import {
  DEFAULT_SITE_DESCRIPTION,
  DEFAULT_SITE_TITLE,
  attachmentDownloadUrl,
  attachmentUploadUrl,
  estimateReadingTime,
  feedbackFileUrl,
  formatBytes,
  slugify,
  type AdminSettings,
  type AdminStatus,
  type AttachmentPublic,
  type CategoryInfo,
  type PostData,
  type PostLanguage,
  type PostStatus,
} from '@/lib/utils'
import { renderMarkdown } from '@/lib/markdown'
import { StickerTrigger } from '@/components/sticker-picker'
import { ThemeToggle } from '@/components/theme-toggle'
import { LangSwitch } from '@/components/lang-switch'
import { categoryNameFor, useLang, useT } from '@/lib/i18n'
import {
  adminCommentsFn,
  adminSetSignatureFn,
  createUserTagFn,
  deleteUserTagFn,
  feedbackStatusFn,
  issueWarningFn,
  listCommentersFn,
  listFeedbackFn,
  setUserTagsFn,
  updateUserTagFn,
} from '../admin-user-fns'
import { listUserTagsFn } from '../user-fns'
import { UserTagList } from '../user-tag-badge'
import type { UserTag } from '../../../db/index.js'

// =================================================================
// Server Functions（服务端处理；客户端只拿到 fetcher 桩）
// 公开读 server fns（前台用）+ AttachmentPanel 已抽到 ../public-fns.tsx，
// 这里仅保留管理员写操作相关 server fn，避免被前台路由把整个后台 bundle 拖进首屏。
// 注意：public-fns.tsx 与 card.tsx 都会各自通过 await import('../../../db/index.js')
// 动态引服务端代码，客户端 bundle 依然不会包含 db/index 内容。
// =================================================================

import {
  adminStatusFn as _pub_adminStatusFn,
  settingsFn as _pub_settingsFn,
  allCategoriesFn as _pub_allCategoriesFn,
  publishedPostsFn as _pub_publishedPostsFn,
  getPublishedPostFn as _pub_getPublishedPostFn,
  publicServerFns,
} from '../public-fns'

// 公开 fns 已在 public-fns.tsx 声明；此处仍按原名引用 adminStatusFn / settingsFn
// 以保留 admin 门控、设置页的内部调用。
const adminStatusFn = _pub_adminStatusFn
const settingsFn = _pub_settingsFn

// =================================================================
// 管理员端 Server Functions（仅 card.tsx 内部被 UI 调用；不在 publicServerFns 中暴露）
// =================================================================

type PostSaveInput = {
  id?: number | null
  slug: string
  title: string
  summary: string
  content: string
  categories: string[]
  status: PostStatus
  date: string
  language?: PostLanguage
  translationKey?: string | null
}
// 注意：handler 链上不能用 `as unknown as` 断言（会破坏 Start 编译器的链式识别，
// 导致文件被静默跳过编译）。类型用返回值注解表达。
const saveSettingsFn = createServerFn({ method: 'POST' })
  .inputValidator((input: AdminSettings) => input)
  .handler(async ({ data }): Promise<AdminSettings> => {
    const mod = await import('../../../db/index.js')
    return mod.saveAdminSettings(data)
  })

const savePostFn = createServerFn({ method: 'POST' })
  .inputValidator((input: PostSaveInput) => input)
  .handler(async ({ data }): Promise<{ id: number; slug: string }> => {
    const mod = await import('../../../db/index.js')
    return mod.savePost(data)
  })

const deletePostFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({ id: z.number() }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const mod = await import('../../../db/index.js')
    await mod.deletePost(data.id)
    return { ok: true }
  })

const dashboardFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ posts: PostData[]; categories: CategoryInfo[]; attachments: AttachmentPublic[] }> => {
    const mod = await import('../../../db/index.js')
    await mod.requireAdmin()
    const posts = await mod.listDbPosts(true)
    const categories = await mod.listCategoryInfo()
    const attachments = await mod.listAttachmentsAdmin()
    return { posts, categories, attachments }
  },
)

const getPostForEditFn = createServerFn({ method: 'GET' })
  .inputValidator((input) => z.object({ id: z.number() }).parse(input))
  .handler(async ({ data }): Promise<{ post: PostData; attachments: AttachmentPublic[]; categories: CategoryInfo[]; posts: PostData[] }> => {
    const mod = await import('../../../db/index.js')
    await mod.requireAdmin()
    const post = await mod.getDbPostById(data.id)
    if (!post) throw new Error('文章不存在。')
    const attachments = await mod.listAttachmentsAdmin(post.slug)
    const categories = await mod.listCategoryInfo()
    const posts = await mod.listDbPosts(true)
    return { post, attachments, categories, posts }
  })

const getEditorBootstrapFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ categories: CategoryInfo[]; posts: PostData[] }> => {
    const mod = await import('../../../db/index.js')
    await mod.requireAdmin()
    const categories = await mod.listCategoryInfo()
    const posts = await mod.listDbPosts(true)
    return { categories, posts }
  },
)

const listCategoriesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CategoryInfo[]> => {
    const mod = await import('../../../db/index.js')
    await mod.requireAdmin()
    return mod.listCategoryInfo()
  },
)

const createCategoryFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({
    name: z.string().trim().min(1).max(40),
    nameEn: z.string().max(40).optional().nullable(),
    nameRu: z.string().max(40).optional().nullable(),
  }).parse(input))
  .handler(async ({ data }): Promise<{ id: number; name: string }> => {
    const mod = await import('../../../db/index.js')
    return mod.createCategory(data.name, { nameEn: data.nameEn ?? null, nameRu: data.nameRu ?? null })
  })

const saveCategoryFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({
    id: z.number().int().positive().optional().nullable(),
    name: z.string().trim().min(1).max(40),
    nameEn: z.string().max(40).optional().nullable(),
    nameRu: z.string().max(40).optional().nullable(),
  }).parse(input))
  .handler(async ({ data }): Promise<{ id: number; name: string }> => {
    const mod = await import('../../../db/index.js')
    return mod.saveCategory(data)
  })

const deleteCategoryFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({ id: z.number() }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const mod = await import('../../../db/index.js')
    await mod.deleteCategory(data.id)
    return { ok: true }
  })

const setAttachmentPasswordFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({ id: z.number(), password: z.string().max(256).nullable() }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const mod = await import('../../../db/index.js')
    await mod.setAttachmentPassword(data.id, data.password)
    return { ok: true }
  })

const deleteAttachmentFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({ id: z.number() }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const mod = await import('../../../db/index.js')
    await mod.deleteAttachment(data.id)
    return { ok: true }
  })

// 站点内容块（网站简介 / 友情链接）管理员读取
const getSiteContentFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ key: string; lang: string; body: string; updatedAt: string | null }[]> => {
    const mod = await import('../../../db/index.js')
    await mod.requireAdmin()
    return mod.listSiteContent()
  },
)

// 站点内容块保存（key/lang 枚举校验，db 层二次校验管理员身份）
const saveSiteContentFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({
    key: z.enum(['about', 'links']),
    lang: z.enum(['zh', 'en', 'ru']),
    body: z.string().max(20000),
  }).parse(input))
  .handler(async ({ data }): Promise<{ key: string; lang: string; body: string }> => {
    const mod = await import('../../../db/index.js')
    return mod.saveSiteContent(data)
  })

// 保证公开别名不会因 noUnusedLocals 告警（实际已通过同名 const 引用）
void _pub_adminStatusFn; void _pub_settingsFn; void _pub_allCategoriesFn
void _pub_publishedPostsFn; void _pub_getPublishedPostFn

export { publicServerFns }

// =================================================================
// 共享 Hook：管理员门控
// =================================================================
function useAdminStatus(): {
  loading: boolean
  status: AdminStatus | null
  error: string
  refresh: () => Promise<void>
} {
  const t = useT()
  const [status, setStatus] = React.useState<AdminStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const refresh = React.useCallback(async () => {
    setLoading(true); setError('')
    try { setStatus(await adminStatusFn()) } catch (e) { setError(e instanceof Error ? e.message : t('admin.auth.fail')) }
    finally { setLoading(false) }
  }, [t])
  React.useEffect(() => { void refresh() }, [refresh])
  return { loading, status, error, refresh }
}

// =================================================================
// 门控包装（router.tsx 引用）
// =================================================================
export function AdminGateWrap({ children }: { children: React.ReactNode }) {
  const t = useT()
  const { loading, status, error, refresh } = useAdminStatus()
  if (loading) return <div className="admin-loading">{t('admin.gate.checking')}</div>
  if (error) return <div className="admin-error">{t('admin.gate.fail')}{error} <button onClick={() => void refresh()}>{t('admin.retry')}</button></div>
  if (!status) return null
  if (!status.authed) {
    return (
      <div className="admin-gate-card">
        <div className="gate-icon"><UserRound size={48} /></div>
        <h2>{t('admin.gate.login.title')}</h2>
        <p>{t('admin.gate.login.p')}</p>
        <button
          className="primary-button"
          onClick={() => window.dispatchEvent(new Event('open-auth'))}
        >
          {t('admin.gate.login.btn')}
        </button>
        {status.email ? <small>{t('admin.gate.login.current', { email: status.email })}</small> : null}
      </div>
    )
  }
  if (!status.isAdmin) {
    return (
      <div className="admin-gate-card">
        <div className="gate-icon alert"><ShieldAlert size={48} /></div>
        <h2>{t('admin.gate.deny.title')}</h2>
        <p>{t('admin.gate.deny.pre')}<b>{status.email}</b>{t('admin.gate.deny.post')}</p>
        {!status.adminConfigured && (
          <p className="gate-warn">
            {t('admin.gate.deny.warn.a')}<code>ADMIN_EMAILS</code>{t('admin.gate.deny.warn.b')}<code>admin_emails</code>{t('admin.gate.deny.warn.c')}
          </p>
        )}
        <button className="text-button" onClick={() => void refresh()}>{t('admin.gate.refresh')}</button>
      </div>
    )
  }
  return <>{children}</>
}

// =================================================================
// 管理后台 Layout（侧边栏 + 内容区）
// =================================================================
export function AdminLayout() {
  const t = useT()
  const { status } = useAdminStatus()
  // 移动端侧边栏抽屉开关；路由变化后自动关闭
  const [sideOpen, setSideOpen] = React.useState(false)
  const closeOnNav = () => setSideOpen(false)

  return (
    <div className="admin-shell">
      {/* 移动端遮罩层 */}
      {sideOpen && <button className="admin-side-scrim" onClick={() => setSideOpen(false)} aria-label={t('admin.side.scrim')} />}
      <aside className={`admin-side${sideOpen ? ' open' : ''}`}>
        <div className="admin-side-head">
          <div className="brand-mark" style={{ color: 'var(--accent)' }}><TerminalSquare size={18} /><span>admin.panel</span></div>
          <small className="admin-subtitle">{t('admin.subtitle')}</small>
        </div>
        <nav className="admin-nav">
          <Link to="/admin/posts" className="admin-nav-item" onClick={closeOnNav}><LayoutDashboard size={17} /><span>{t('admin.nav.posts')}</span></Link>
          <Link to="/admin/posts/new" className="admin-nav-item" onClick={closeOnNav}><Newspaper size={17} /><span>{t('admin.nav.new')}</span></Link>
          <Link to="/admin/categories" className="admin-nav-item" onClick={closeOnNav}><FolderTree size={17} /><span>{t('admin.nav.categories')}</span></Link>
          <Link to="/admin/users" className="admin-nav-item" onClick={closeOnNav}><Users size={17} /><span>{t('admin.nav.users')}</span></Link>
          <Link to="/admin/feedback" className="admin-nav-item" onClick={closeOnNav}><Inbox size={17} /><span>{t('admin.nav.feedback')}</span></Link>
          <Link to="/admin/content" className="admin-nav-item" onClick={closeOnNav}><FileText size={17} /><span>{t('admin.nav.content')}</span></Link>
          <Link to="/admin/settings" className="admin-nav-item" onClick={closeOnNav}><SettingsIcon size={17} /><span>{t('admin.nav.settings')}</span></Link>
          <a className="admin-nav-item" href="/" target="_blank" rel="noreferrer"><Home size={17} /><span>{t('admin.nav.site')}</span></a>
          <a className="admin-nav-item" href="/rss.xml" target="_blank" rel="noreferrer"><FileDown size={17} /><span>{t('admin.nav.rss')}</span></a>
        </nav>
        <div className="admin-side-foot">
          <div className="mini-user">
            <span>{(status?.email || '?').slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{status?.email || t('admin.guest')}</strong>
              <small>
                <ShieldCheck size={11} /> {t('admin.role')}
              </small>
            </div>
          </div>
          <button className="ghost-button" onClick={() => { closeOnNav(); window.dispatchEvent(new Event('open-auth')) }}>
            <LogOut size={14} /> {t('admin.account')}
          </button>
        </div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar">
          <button className="admin-menu-toggle" onClick={() => setSideOpen((v) => !v)} aria-label={t('admin.toggle.aria')} aria-expanded={sideOpen} title={t('admin.toggle.title')}>
            {sideOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div className="crumbs"><span>~/admin</span><span>/</span><b>{typeof location !== 'undefined' ? location.pathname.replace('/admin', '') || 'dashboard' : 'dashboard'}</b></div>
          <div className="admin-topbar-actions">
            <LangSwitch compact className="admin-icon-btn" />
            <ThemeToggle className="admin-icon-btn" />
            <Link to="/admin/posts/new" className="primary-button small"><CirclePlus size={14} />{t('admin.new.post')}</Link>
          </div>
        </header>
        <div className="admin-content">
          <Outlet />
        </div>
      </section>
    </div>
  )
}

// =================================================================
// 仪表盘：文章列表 + 新建 + 状态/分类徽章 + 删除确认
// =================================================================
export function AdminDashboard() {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  const [data, setData] = React.useState<{ posts: PostData[]; categories: CategoryInfo[]; attachments: AttachmentPublic[] } | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [deleting, setDeleting] = React.useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState<number | null>(null)
  const load = React.useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await dashboardFn()) } catch (e) { setError(e instanceof Error ? e.message : t('admin.load.fail')) }
    finally { setLoading(false) }
  }, [t])
  React.useEffect(() => { void load() }, [load])

  const remove = async (id: number) => {
    setDeleting(id)
    try {
      await deletePostFn({ data: { id } })
      setConfirmDelete(null)
      await load()
    } catch (e) { alert(e instanceof Error ? e.message : t('admin.delete.fail')) }
    finally { setDeleting(null) }
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div>
          <h1>{t('admin.dash.title')}</h1>
          <p>{t('admin.dash.sub')}</p>
        </div>
        <Link to="/admin/posts/new" className="primary-button"><CirclePlus size={16} />{t('admin.new.post')}</Link>
      </div>
      <div className="stat-grid">
        <div className="stat-card tone-1"><span>{t('admin.dash.stat.draft')}</span><b>{data?.posts.filter((p) => p.status === 'draft').length ?? 0}</b></div>
        <div className="stat-card tone-2"><span>{t('admin.dash.stat.published')}</span><b>{data?.posts.filter((p) => p.status === 'published').length ?? 0}</b></div>
        <div className="stat-card tone-3"><span>{t('admin.dash.stat.cats')}</span><b>{data?.categories.length ?? 0}</b></div>
        <div className="stat-card tone-4"><span>{t('admin.dash.stat.atts')}</span><b>{data?.attachments.length ?? 0}</b></div>
      </div>
      {error && <div className="banner error">{error} <button onClick={() => void load()}>{t('admin.retry')}</button></div>}
      {loading && <div className="skeleton-table" />}
      {data && (
        <div className="panel">
          <div className="panel-head"><h3>{t('admin.dash.list.title')} <small>{t('admin.dash.list.note')}</small></h3></div>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>{t('admin.th.id')}</th>
                <th>{t('admin.th.title')}</th>
                <th style={{ width: 180 }}>{t('admin.th.slug')}</th>
                <th style={{ width: 120 }}>{t('admin.th.date')}</th>
                <th style={{ width: 120 }}>{t('admin.th.status')}</th>
                <th style={{ width: 200 }}>{t('admin.th.cats')}</th>
                <th style={{ width: 170 }}>{t('admin.th.read')}</th>
                <th style={{ width: 150 }}>{t('admin.th.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.posts.length === 0 && (
                <tr><td colSpan={8} className="empty-row">{t('admin.dash.empty')}</td></tr>
              )}
              {data.posts.map((post) => (
                <tr key={post.id}>
                  <td className="mono">{post.id}</td>
                  <td className="strong">
                    <Link to="/admin/posts/$id" params={{ id: String(post.id) }} className="row-link">{post.title}</Link>
                    <span className={`badge ${post.language === 'zh' ? 'badge-yellow' : 'badge-blue'}`} style={{ marginLeft: 8 }}>{post.language.toUpperCase()}</span>
                    {post.translationKey && <span className="badge badge-blue" style={{ marginLeft: 6 }} title={t('admin.dash.trans.tip', { key: post.translationKey })}>↔ {t('admin.dash.trans.badge')}</span>}
                    <div className="row-sub">{t('admin.dash.updated')}{post.updatedAt ? new Date(post.updatedAt).toLocaleString(dateLocale) : '—'}</div>
                  </td>
                  <td className="mono small">/{post.slug}</td>
                  <td className="mono small">{post.date}</td>
                  <td><span className={post.status === 'published' ? 'badge badge-green' : 'badge badge-yellow'}>
                    {post.status === 'published' ? t('admin.status.published') : t('admin.status.draft')}
                  </span></td>
                  <td>
                    <div className="chip-row">
                      {post.categories.length === 0 && <em className="muted">{t('admin.dash.uncategorized')}</em>}
                      {post.categories.slice(0, 3).map((c) => (<span className="chip" key={c}><Hash size={11} />{c}</span>))}
                      {post.categories.length > 3 && <span className="chip more">+{post.categories.length - 3}</span>}
                    </div>
                  </td>
                  <td className="small muted">{t('admin.dash.minutes', { n: estimateReadingTime(post.content) })}</td>
                  <td>
                    <div className="row-actions">
                      <Link to="/admin/posts/$id" params={{ id: String(post.id) }} className="row-action primary">{t('admin.act.edit')}</Link>
                      <a className="row-action" target="_blank" rel="noreferrer" href={`/posts/${encodeURIComponent(post.slug)}`}>{t('admin.act.preview')}</a>
                      {confirmDelete === post.id ? (
                        <>
                          <button className="row-action danger" disabled={deleting === post.id} onClick={() => void remove(post.id!)}>
                            {deleting === post.id ? t('admin.busy.deleting') : t('admin.act.confirm.delete')}
                          </button>
                          <button className="row-action" onClick={() => setConfirmDelete(null)}>{t('admin.act.cancel')}</button>
                        </>
                      ) : (
                        <button className="row-action danger" onClick={() => setConfirmDelete(post.id!)}>{t('admin.act.delete')}</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// =================================================================
// 分类管理
// =================================================================
export function CategoryManager() {
  const t = useT()
  const [list, setList] = React.useState<CategoryInfo[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  // id: null = 新建；id: 0 = 静态内置分类（按权威名 upsert 译名，不可改名）
  const [form, setForm] = React.useState<{ id: number | null; name: string; nameEn: string; nameRu: string }>({
    id: null, name: '', nameEn: '', nameRu: '',
  })
  const formRef = React.useRef<HTMLDivElement>(null)
  const load = React.useCallback(async () => {
    setLoading(true)
    try { setList(await listCategoriesFn()) } catch (e) { setError(e instanceof Error ? e.message : t('admin.load.fail')) }
    finally { setLoading(false) }
  }, [t])
  React.useEffect(() => { void load() }, [load])

  const editingBuiltin = form.id === 0
  const isEditing = form.id !== null

  const resetForm = () => setForm({ id: null, name: '', nameEn: '', nameRu: '' })

  const startEdit = (c: CategoryInfo) => {
    setError('')
    setForm({ id: c.id, name: c.name, nameEn: c.nameEn ?? '', nameRu: c.nameRu ?? '' })
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  const submit = async () => {
    if (!form.name.trim()) return
    setBusy(true); setError('')
    try {
      // 内置分类没有行 id：按权威名 upsert（saveCategory 以 null id 处理）
      await saveCategoryFn({
        data: {
          id: form.id && form.id > 0 ? form.id : null,
          name: form.name,
          nameEn: form.nameEn.trim() || null,
          nameRu: form.nameRu.trim() || null,
        },
      })
      resetForm()
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : t('admin.create.fail')) }
    finally { setBusy(false) }
  }

  const remove = async (row: CategoryInfo) => {
    if (row.builtin) { alert(t('admin.cat.builtin.alert')); return }
    if (!confirm(t('admin.cat.confirm', { name: row.name }))) return
    try {
      await deleteCategoryFn({ data: { id: row.id } })
      if (form.id === row.id) resetForm()
      await load()
    } catch (e) { alert(e instanceof Error ? e.message : t('admin.delete.fail')) }
  }

  const langFields: Array<{ key: 'name' | 'nameEn' | 'nameRu'; label: string; placeholder: string; locked?: boolean }> = [
    { key: 'name', label: t('admin.cat.f.zh'), placeholder: t('admin.cat.ph.zh') },
    { key: 'nameEn', label: t('admin.cat.f.en'), placeholder: t('admin.cat.ph.en') },
    { key: 'nameRu', label: t('admin.cat.f.ru'), placeholder: t('admin.cat.ph.ru') },
  ]

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div><h1>{t('admin.cat.title')}</h1><p>{t('admin.cat.sub')}</p></div>
      </div>
      <div className="panel two-col">
        <div ref={formRef}>
          <h3 className="panel-title">{isEditing ? t('admin.cat.edit') : t('admin.cat.add')}</h3>
          <div className="cat-lang-form">
            {langFields.map((f) => (
              <label key={f.key} className="cat-lang-field">
                <span>{f.label}{f.key === 'name' && <em className="cat-required">*</em>}</span>
                <input
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  maxLength={40}
                  readOnly={f.key === 'name' && editingBuiltin}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && f.key !== 'name') void submit() }}
                />
              </label>
            ))}
          </div>
          {editingBuiltin && <p className="muted small mt8">{t('admin.cat.builtin.rename')}</p>}
          {!isEditing && <p className="muted small mt8">{t('admin.cat.limit')}</p>}
          {error && <div className="banner error small">{error}</div>}
          <div className="cat-form-actions">
            <button className="primary-button" onClick={() => void submit()} disabled={busy || !form.name.trim()}>
              {busy ? t('admin.busy.saving') : isEditing ? t('admin.cat.save') : t('admin.cat.create')}
            </button>
            {isEditing && <button className="ghost-button" onClick={resetForm} disabled={busy}>{t('common.cancel')}</button>}
          </div>
        </div>
        <div>
          <h3 className="panel-title">{t('admin.cat.all')} {loading ? `（${t('admin.busy.loading')}）` : t('admin.cat.count', { n: list.length })}</h3>
          {loading ? <div className="skeleton-list" /> : (
            <ul className="category-list">
              {list.map((c) => (
                <li key={`${c.id}-${c.name}`}>
                  <div className="line-main cat-line">
                    <div className="cat-names">
                      <span className="chip"><Tags size={12} />{c.name}</span>
                      <span className={`cat-trans ${c.nameEn ? '' : 'missing'}`} lang="en" title={t('admin.cat.trans.hint')}>{c.nameEn || t('admin.cat.trans.missing')}</span>
                      <span className={`cat-trans ${c.nameRu ? '' : 'missing'}`} lang="ru" title={t('admin.cat.trans.hint')}>{c.nameRu || t('admin.cat.trans.missing')}</span>
                    </div>
                    {c.builtin && <span className="badge badge-gray">builtin</span>}
                    <div className="count-inline">
                      <span>{t('admin.cat.db')}<b>{c.dbCount}</b></span>
                      <span>{t('admin.cat.static')}<b>{c.staticCount}</b></span>
                    </div>
                  </div>
                  <div className="cat-row-actions">
                    <button className="row-action" title={t('admin.cat.edit.tip')} onClick={() => startEdit(c)}>
                      <Pencil size={14} /> {t('admin.cat.edit.btn')}
                    </button>
                    <button
                      className="row-action danger"
                      disabled={c.builtin}
                      title={c.builtin ? t('admin.cat.builtin.tip') : t('admin.cat.delete.tip')}
                      onClick={() => remove(c)}
                    >
                      <Trash2 size={14} /> {t('admin.cat.delete.btn')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// =================================================================
// Markdown 编辑器工具栏
// =================================================================
type Surround = [string, string] | [string]
function applyWrap(textarea: HTMLTextAreaElement, s: Surround, placeholder = '') {
  const start = textarea.selectionStart, end = textarea.selectionEnd
  const before = textarea.value.slice(0, start)
  const selection = textarea.value.slice(start, end) || placeholder
  const after = textarea.value.slice(end)
  const head = s[0]!
  const tail = s[1] ?? ''
  const next = `${before}${head}${selection}${tail}${after}`
  const cursorPos = before.length + head.length + selection.length
  return { value: next, cursor: cursorPos }
}
function applyLinePrefix(textarea: HTMLTextAreaElement, prefix: string, placeholder = '') {
  const start = textarea.selectionStart, end = textarea.selectionEnd
  const before = textarea.value.slice(0, start)
  const selected = textarea.value.slice(start, end) || textarea.value.slice(before.lastIndexOf('\n') + 1, end + 1) || ''
  const after = textarea.value.slice(end)
  const lineStart = before.length - (before.length - before.lastIndexOf('\n') - 1)
  const head = textarea.value.slice(0, lineStart)
  const replaced = `${prefix}${selected || placeholder}`
  const next = `${head}${replaced}${after}`
  return { value: next, cursor: head.length + replaced.length }
}

function useMarkdownEditor(initial: string) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = React.useState(initial)
  React.useEffect(() => { setValue(initial) }, [initial])
  const wrap = (s: Surround, ph?: string) => {
    const el = ref.current
    if (!el) return
    const { value: v, cursor } = applyWrap(el, s, ph)
    setValue(v)
    queueMicrotask(() => { el.focus(); el.setSelectionRange(cursor, cursor) })
  }
  const line = (prefix: string, ph?: string) => {
    const el = ref.current
    if (!el) return
    const { value: v, cursor } = applyLinePrefix(el, prefix, ph)
    setValue(v)
    queueMicrotask(() => { el.focus(); el.setSelectionRange(cursor, cursor) })
  }
  return { ref, value, setValue, wrap, line, insert: (text: string) => {
    const el = ref.current
    if (!el) { setValue((v) => v + text); return }
    const start = el.selectionStart
    const end = el.selectionEnd
    const v = el.value.slice(0, start) + text + el.value.slice(end)
    setValue(v)
    queueMicrotask(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length) })
  } }
}

// 翻译组代表排序：中文原文优先
const POST_LANG_ORDER: Record<PostLanguage, number> = { zh: 0, en: 1, ru: 2 }

// =================================================================
// 文章编辑器页面（新建 / 编辑）
// =================================================================
export function PostEditorPage() {
  const t = useT()
  const lang = useLang()
  const params = useParams({ strict: false }) as { id?: string }
  const editId = params.id ? Number(params.id) : null
  const navigate = useNavigate()
  const [saving, setSaving] = React.useState(false)
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [bootstrap, setBootstrap] = React.useState<{
    id: number | null
    title: string
    slug: string
    summary: string
    content: string
    categories: string[]
    status: PostStatus
    date: string
    language: PostLanguage
    translationKey: string | null
    attachments: AttachmentPublic[]
    categoryOptions: CategoryInfo[]
    allPosts: PostData[]
  }>({
    id: null, title: '', slug: '', summary: '', content: '', categories: [], status: 'draft',
    date: new Date().toISOString().slice(0, 10), language: 'zh', translationKey: null,
    attachments: [], categoryOptions: [], allPosts: [],
  })
  const [preview, setPreview] = React.useState(true)
  const editor = useMarkdownEditor('')

  const flashErr = (e: unknown) => setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.op.fail') })

  // 初始化：编辑模式加载文章详情；新建模式仅拉分类
  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        if (editId && Number.isInteger(editId) && editId > 0) {
          const { post, attachments, categories, posts } = await getPostForEditFn({ data: { id: editId } })
          if (!alive) return
          setBootstrap({
            id: post.id, title: post.title, slug: post.slug, summary: post.summary,
            content: post.content, categories: [...post.categories], status: post.status,
            date: post.date, language: post.language, translationKey: post.translationKey,
            attachments, categoryOptions: categories, allPosts: posts,
          })
          editor.setValue(post.content)
        } else {
          const { categories, posts } = await getEditorBootstrapFn()
          if (!alive) return
          setBootstrap((b) => ({ ...b, categoryOptions: categories, allPosts: posts }))
        }
      } catch (e) { flashErr(e) }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId])

  // 可关联的翻译组：键 = 组内锚点 slug；同一组只展示一个代表（优先中文版）
  const translationGroups = React.useMemo(() => {
    const map = new Map<string, { key: string; title: string; language: PostLanguage; count: number }>()
    for (const p of bootstrap.allPosts) {
      if (p.id === bootstrap.id) continue
      const key = p.translationKey || p.slug
      const exist = map.get(key)
      if (!exist) {
        map.set(key, { key, title: p.title, language: p.language, count: 1 })
      } else {
        exist.count += 1
        // 组代表优先中文，其次当前语言序在前的
        if (p.language === 'zh' || POST_LANG_ORDER[p.language] < POST_LANG_ORDER[exist.language]) {
          exist.title = p.title
          exist.language = p.language
        }
      }
    }
    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title))
  }, [bootstrap.allPosts, bootstrap.id, t])

  const slugFromTitle = () => setBootstrap((b) => ({ ...b, slug: slugify(b.slug || b.title) }))
  const toggleCategory = (name: string) => setBootstrap((b) => ({
    ...b,
    categories: b.categories.includes(name) ? b.categories.filter((c) => c !== name) : [...b.categories, name],
  }))
  const addNewCategory = () => {
    const name = window.prompt(t('admin.cat.prompt'), '')?.trim()
    if (!name) return
    void (async () => {
      try {
        await createCategoryFn({ data: { name, nameEn: null, nameRu: null } })
        setBootstrap((b) => ({
          ...b,
          categories: b.categories.includes(name) ? b.categories : [...b.categories, name],
          categoryOptions: [...b.categoryOptions].sort((a, z) => a.name.localeCompare(z.name)).some((c) => c.name === name)
            ? b.categoryOptions
            : [...b.categoryOptions, { id: 0, name, nameEn: null, nameRu: null, dbCount: 0, staticCount: 0, builtin: false }],
        }))
      } catch (e) { flashErr(e) }
    })()
  }

  const submit = async (nextStatus?: PostStatus) => {
    setSaving(true); setMsg(null)
    try {
      const result = await savePostFn({
        data: {
          id: bootstrap.id,
          slug: bootstrap.slug || slugify(bootstrap.title),
          title: bootstrap.title,
          summary: bootstrap.summary,
          content: editor.value,
          categories: bootstrap.categories,
          status: nextStatus || bootstrap.status,
          date: bootstrap.date,
          language: bootstrap.language,
          translationKey: bootstrap.translationKey,
        },
      })
      setMsg({ kind: 'ok', text: nextStatus === 'published' ? t('admin.editor.published') : t('admin.editor.draft.saved') })
      if (!bootstrap.id) navigate({ to: '/admin/posts/$id', params: { id: String(result.id) } })
      // 重新拉取 attachments（避免状态丢失）
      const attachments = await (async () => {
        try { return (await getPostForEditFn({ data: { id: result.id } })).attachments } catch { return [] }
      })()
      setBootstrap((b) => ({ ...b, id: result.id, slug: result.slug, status: nextStatus || b.status, attachments }))
    } catch (e) { flashErr(e) }
    finally { setSaving(false) }
  }

  return (
    <div className="admin-dashboard editor-root">
      <div className="admin-header">
        <div>
          <h1>{editId ? t('admin.editor.edit.title', { id: editId }) : t('admin.editor.new.title')}</h1>
          <p>{t('admin.editor.desc')}</p>
        </div>
        <div className="header-actions">
          <Link to="/admin/posts" className="ghost-button">{t('admin.editor.back')}</Link>
          <button className="ghost-button" onClick={() => void submit('draft')} disabled={saving}>
            <Save size={14} />{saving ? t('admin.busy.saving') : t('admin.editor.save.draft')}
          </button>
          <button className="primary-button" onClick={() => void submit('published')} disabled={saving}>
            <Save size={14} />{bootstrap.status === 'published' || !editId ? t('admin.editor.publish') : t('admin.editor.republish')}
          </button>
        </div>
      </div>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}

      <div className="panel editor-meta">
        <div className="meta-row">
          <label>
            {t('admin.f.title')} <span className="req">*</span>
            <input
              value={bootstrap.title}
              onChange={(e) => setBootstrap((b) => ({ ...b, title: e.target.value }))}
              placeholder={t('admin.f.title.ph')}
            />
          </label>
          <label style={{ flex: '0 0 280px' }}>
            {t('admin.f.date')}
            <input
              type="date"
              value={bootstrap.date}
              onChange={(e) => setBootstrap((b) => ({ ...b, date: e.target.value }))}
            />
          </label>
          <label style={{ flex: '0 0 220px' }}>
            {t('admin.f.status')}
            <select
              value={bootstrap.status}
              onChange={(e) => setBootstrap((b) => ({ ...b, status: e.target.value as PostStatus }))}
            >
              <option value="draft">{t('admin.status.draft.opt')}</option>
              <option value="published">{t('admin.status.pub.opt')}</option>
            </select>
          </label>
          <label style={{ flex: '0 0 150px' }}>
            {t('admin.f.language')}
            <select
              value={bootstrap.language}
              onChange={(e) => setBootstrap((b) => ({ ...b, language: e.target.value as PostLanguage }))}
            >
              <option value="zh">{t('lang.zh')}</option>
              <option value="en">{t('lang.en')}</option>
              <option value="ru">{t('lang.ru')}</option>
            </select>
          </label>
        </div>
        <div className="meta-row">
          <label>
            {t('admin.f.slug')} <span className="req">*</span>
            <div className="field-inline">
              <span className="prefix">/posts/</span>
              <input value={bootstrap.slug} onChange={(e) => setBootstrap((b) => ({ ...b, slug: slugify(e.target.value) }))} />
              <button type="button" className="ghost-button" onClick={slugFromTitle}>{t('admin.slug.gen')}</button>
            </div>
            <small className="muted">{t('admin.slug.hint')}</small>
          </label>
        </div>
        <div className="meta-row">
          <label style={{ flex: 1 }}>
            {t('admin.f.trans')}
            <select
              value={bootstrap.translationKey ?? ''}
              onChange={(e) => setBootstrap((b) => ({ ...b, translationKey: e.target.value || null }))}
            >
              <option value="">{t('admin.trans.none')}</option>
              {translationGroups.map((g) => (
                <option key={g.key} value={g.key}>
                  《{g.title}》 · {g.language.toUpperCase()}{g.count > 1 ? t('admin.trans.versions', { n: g.count }) : ''}
                </option>
              ))}
              {bootstrap.translationKey && !translationGroups.some((g) => g.key === bootstrap.translationKey) && (
                <option value={bootstrap.translationKey}>{bootstrap.translationKey}</option>
              )}
            </select>
            <small className="muted">{t('admin.trans.hint')}</small>
          </label>
        </div>
        <div className="meta-row">
          <label>
            {t('admin.f.summary')}
            <textarea
              rows={2}
              value={bootstrap.summary}
              onChange={(e) => setBootstrap((b) => ({ ...b, summary: e.target.value }))}
              placeholder={t('admin.f.summary.ph')}
            />
          </label>
        </div>
        <div className="meta-row">
          <label style={{ flex: 1 }}>
            {t('admin.f.cats')} <button type="button" className="row-action" onClick={addNewCategory}>{t('admin.cat.new')}</button>
            <div className="category-options">
              {bootstrap.categoryOptions.map((c) => {
                const localName = categoryNameFor(c.name, lang)
                return (
                  <label key={`${c.id}-${c.name}`} className={bootstrap.categories.includes(c.name) ? 'tag on' : 'tag'}>
                    <input
                      type="checkbox"
                      checked={bootstrap.categories.includes(c.name)}
                      onChange={() => toggleCategory(c.name)}
                    />
                    {c.builtin && <span className="chip-mini">s</span>}
                    {c.name}
                    {localName !== c.name && <span className="tag-trans" title={t('admin.cat.trans.hint')}>· {localName}</span>}
                  </label>
                )
              })}
              {bootstrap.categoryOptions.length === 0 && <em className="muted">{t('admin.editor.cat.empty')}</em>}
            </div>
          </label>
        </div>
      </div>

      <div className="panel editor-body">
        <div className="editor-toolbar">
          <span className="toolbar-label">Markdown · LaTeX · GFM</span>
          <div className="toolbar-buttons">
            <button type="button" title={t('admin.tb.bold')} onClick={() => editor.wrap(['**', '**'], t('admin.tb.in.bold'))}><Bold size={15} /></button>
            <button type="button" title={t('admin.tb.italic')} onClick={() => editor.wrap(['*', '*'], t('admin.tb.in.italic'))}><Italic size={15} /></button>
            <button type="button" title={t('admin.tb.code')} onClick={() => editor.wrap(['`', '`'], t('admin.tb.in.code'))}><Code2 size={15} /></button>
            <button type="button" title={t('admin.tb.h2')} onClick={() => editor.line('## ')}><b>H2</b></button>
            <button type="button" title={t('admin.tb.h3')} onClick={() => editor.line('### ')}><b>H3</b></button>
            <button type="button" title={t('admin.tb.quote')} onClick={() => editor.line('> ')}><Quote size={15} /></button>
            <button type="button" title={t('admin.tb.ul')} onClick={() => editor.line('- ', t('admin.tb.in.item'))}><List size={15} /></button>
            <button type="button" title={t('admin.tb.ol')} onClick={() => editor.line('1. ', t('admin.tb.in.item'))}><ListOrdered size={15} /></button>
            <button type="button" title={t('admin.tb.link')} onClick={() => editor.wrap(['[', '](https://)'], t('admin.tb.in.link'))}>🔗</button>
            <button
              type="button"
              title={t('admin.tb.pickup')}
              onClick={() => {
                const input = window.prompt(t('admin.tb.pickup.prompt'))
                if (!input) return
                const code = pickupCodeFromInput(input)
                if (!code) { window.alert(t('admin.tb.pickup.bad')); return }
                editor.insert(pickupMarkdown(code) + '\n')
              }}
            ><Package size={15} /></button>
            <button type="button" title={t('admin.tb.image')} onClick={() => editor.wrap(['![', '](https://)'], t('admin.tb.in.img'))}><ImageIcon size={15} /></button>
            <button type="button" title={t('admin.tb.codeblock')} onClick={() => editor.wrap(['\n```ts\n', '\n```\n'], t('admin.tb.in.cb'))}>{'{ }'}</button>
            <StickerTrigger onInsert={(code) => editor.insert(code)} />
            <span className="toolbar-spacer" />
            <button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(!preview)}>
              <Eye size={14} /> {preview ? t('admin.preview.off') : t('admin.preview.on')}
            </button>
          </div>
        </div>
        <div className="editor-split">
          <textarea
            ref={editor.ref}
            value={editor.value}
            onChange={(e) => editor.setValue(e.target.value)}
            placeholder={t('admin.editor.ph')}
            className="md-textarea"
            spellCheck={false}
          />
          {preview && (
            <div className="md-preview-pane">
              <div className="preview-head">{t('admin.preview.head', { n: estimateReadingTime(editor.value) })}</div>
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(editor.value || t('admin.preview.empty')) }}
              />
            </div>
          )}
        </div>
      </div>

      {bootstrap.id ? (
        <AttachmentManager
          postSlug={bootstrap.slug}
          attachments={bootstrap.attachments}
          onChange={(next) => setBootstrap((b) => ({ ...b, attachments: next }))}
        />
      ) : (
        <div className="panel muted small muted-pad">
          <FileDown size={16} /> {t('admin.editor.attach.hint')}
        </div>
      )}
    </div>
  )
}

// =================================================================
// 后台：某文章附件管理（上传 + 改密 + 解锁 + 删除 + 下载次数）
// =================================================================
function AttachmentManager({
  postSlug,
  attachments: initial,
  onChange,
}: {
  postSlug: string
  attachments: AttachmentPublic[]
  onChange: (next: AttachmentPublic[]) => void
}) {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [upError, setUpError] = React.useState('')
  const [upPassword, setUpPassword] = React.useState('')
  const [passwordEdits, setPasswordEdits] = React.useState<Record<number, string>>({})
  const [busyId, setBusyId] = React.useState<number | null>(null)

  const triggerPick = () => fileRef.current?.click()
  const doUpload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    setUploading(true); setUpError('')
    const form = new FormData()
    form.append('file', file)
    form.append('postSlug', postSlug)
    if (upPassword) form.append('password', upPassword)
    try {
      const response = await fetch(attachmentUploadUrl(), { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || t('admin.upload.fail'))
      const row = data.attachment as AttachmentPublic
      onChange([...initial, row])
      if (fileRef.current) fileRef.current.value = ''
      setUpPassword('')
    } catch (e) { setUpError(e instanceof Error ? e.message : t('admin.upload.fail')) }
    finally { setUploading(false) }
  }
  const setPassword = async (att: AttachmentPublic) => {
    const pwd = passwordEdits[att.id] ?? ''
    setBusyId(att.id)
    try {
      await setAttachmentPasswordFn({ data: { id: att.id, password: pwd || null } })
      onChange(initial.map((a) => a.id === att.id ? { ...a, locked: !!pwd } : a))
      setPasswordEdits((m) => ({ ...m, [att.id]: '' }))
    } catch (e) { alert(e instanceof Error ? e.message : t('admin.modify.fail')) }
    finally { setBusyId(null) }
  }
  const remove = async (att: AttachmentPublic) => {
    if (!confirm(t('admin.am.delete.confirm', { name: att.filename }))) return
    setBusyId(att.id)
    try {
      await deleteAttachmentFn({ data: { id: att.id } })
      onChange(initial.filter((a) => a.id !== att.id))
    } catch (e) { alert(e instanceof Error ? e.message : t('admin.delete.fail')) }
    finally { setBusyId(null) }
  }

  return (
    <div className="panel attachments-panel">
      <div className="panel-head between">
        <h3>{t('admin.am.title')} <small>{t('admin.am.note')}</small></h3>
      </div>
      <div className="upload-row">
        <input ref={fileRef} type="file" onChange={() => void doUpload()} style={{ display: 'none' }} />
        <label className="pwd-label">
          {t('admin.am.pwd.label')}
          <input type="password" value={upPassword} onChange={(e) => setUpPassword(e.target.value)} placeholder={t('admin.am.pwd.ph')} />
        </label>
        <span className="spacer" />
        <button className="ghost-button" onClick={triggerPick} disabled={uploading}>
          <Upload size={15} /> {uploading ? t('admin.busy.uploading') : t('admin.am.upload')}
        </button>
      </div>
      {upError && <div className="banner error small">{upError}</div>}
      <ul className="attach-list">
        {initial.length === 0 && <li className="empty-row small">{t('admin.am.empty')}</li>}
        {initial.map((att) => (
          <li key={att.id} className="attach-row">
            <div className="attach-main">
              <div className="attach-icon"><GripVertical size={18} /></div>
              <div className="attach-meta">
                <strong>{att.filename}</strong>
                <div className="attach-sub">
                  <span>{formatBytes(att.sizeBytes)}</span>
                  <span>· {att.mimeType || 'application/octet-stream'}</span>
                  <span>{t('admin.am.downloads', { n: att.downloads })}</span>
                  <span>{t('admin.am.uploaded', { date: new Date(att.createdAt).toLocaleDateString(dateLocale) })}</span>
                  <span className={att.locked ? 'chip lock' : 'chip unlock'}>
                    {att.locked ? <><Lock size={12} />{t('admin.am.locked')}</> : <><LockOpen size={12} />{t('admin.am.public')}</>}
                  </span>
                </div>
              </div>
            </div>
            <div className="attach-actions">
              <input
                type="password"
                placeholder={att.locked ? t('admin.am.ph.locked') : t('admin.am.ph.open')}
                value={passwordEdits[att.id] ?? ''}
                onChange={(e) => setPasswordEdits((m) => ({ ...m, [att.id]: e.target.value }))}
              />
              <button className="row-action primary" disabled={busyId === att.id} onClick={() => setPassword(att)}>
                {busyId === att.id ? t('admin.busy.processing') : att.locked ? t('admin.am.unlock') : t('admin.am.lock')}
              </button>
              <a className="row-action" href={attachmentDownloadUrl(att.id)} target="_blank" rel="noreferrer"><FileDown size={13} />{t('admin.am.download')}</a>
              <button className="row-action danger" disabled={busyId === att.id} onClick={() => remove(att)}>
                <Trash2 size={13} />{t('admin.act.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// =================================================================
// 站点设置
// =================================================================
export function SettingsPanel() {
  const t = useT()
  const [data, setData] = React.useState<AdminSettings>({
    siteTitle: DEFAULT_SITE_TITLE, siteDescription: DEFAULT_SITE_DESCRIPTION, customCss: '', adminEmails: '', bannedWords: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  React.useEffect(() => {
    void (async () => {
      try {
        const res = await settingsFn()
        if (res.isAdmin && res.admin) setData(res.admin)
        else setMsg({ kind: 'err', text: res.isAdmin ? t('admin.set.load.err') : t('admin.set.notadmin') })
      } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.load.fail') }) }
      finally { setLoading(false) }
    })()
  }, [t])
  const submit = async () => {
    setSaving(true); setMsg(null)
    try { const r = await saveSettingsFn({ data }); setData(r); setMsg({ kind: 'ok', text: t('admin.set.saved') }) }
    catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.set.save.fail') }) }
    finally { setSaving(false) }
  }
  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div><h1>{t('admin.set.title')}</h1><p>{t('admin.set.sub')}</p></div>
        <button className="primary-button" onClick={() => void submit()} disabled={saving}>
          <Save size={14} />{saving ? t('admin.busy.saving') : t('admin.set.save')}
        </button>
      </div>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
      {loading ? <div className="skeleton-list" /> : (
        <div className="panel settings-grid">
          <label>
            {t('admin.set.f.title')}
            <input value={data.siteTitle} onChange={(e) => setData({ ...data, siteTitle: e.target.value })} />
          </label>
          <label>
            {t('admin.set.f.desc')}
            <textarea rows={2} value={data.siteDescription} onChange={(e) => setData({ ...data, siteDescription: e.target.value })} />
          </label>
          <label>
            {t('admin.set.f.admins')}
            <textarea rows={2} value={data.adminEmails} onChange={(e) => setData({ ...data, adminEmails: e.target.value })}
              placeholder="you@example.com, editor@example.com" />
          </label>
          <label>
            {t('admin.set.f.banned')}
            <textarea rows={3} value={data.bannedWords} onChange={(e) => setData({ ...data, bannedWords: e.target.value })}
              placeholder={t('admin.set.banned.ph')} />
          </label>
          <label className="full">
            {t('admin.set.f.css.a')}<code>{`<style>`}</code>{t('admin.set.f.css.b')}<code>{`<head>`}</code>{t('admin.set.f.css.c')}
            <textarea
              rows={16}
              spellCheck={false}
              className="mono-textarea"
              value={data.customCss}
              onChange={(e) => setData({ ...data, customCss: e.target.value })}
              placeholder={t('admin.set.css.ph')}
            />
            {data.customCss && (
              <details><summary>{t('admin.set.css.preview')}</summary>
                <style>{data.customCss}</style>
              </details>
            )}
          </label>
        </div>
      )}
    </div>
  )
}

// =================================================================
// 站点内容：网站简介(about) + 友情链接(links)，三语 Markdown
// 编辑体验与文章编辑器一致（工具条 + 分屏预览）
// =================================================================
type SiteContentBlockKey = 'about' | 'links'
type SiteContentBlockLang = 'zh' | 'en' | 'ru'

export function SiteContentEditor() {
  const t = useT()
  const lang = useLang()
  const [blocks, setBlocks] = React.useState<Record<string, string>>({})
  const [key, setKey] = React.useState<SiteContentBlockKey>('about')
  const [blockLang, setBlockLang] = React.useState<SiteContentBlockLang>('zh')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [preview, setPreview] = React.useState(true)
  const [savedAt, setSavedAt] = React.useState<Record<string, string>>({})
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const taRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    let alive = true
    getSiteContentFn()
      .then((rows) => {
        if (!alive) return
        const next: Record<string, string> = {}
        for (const r of rows) next[`${r.key}_${r.lang}`] = r.body
        setBlocks(next)
      })
      .catch((e) => setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.load.fail') }))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [t])

  const id = `${key}_${blockLang}`
  const value = blocks[id] ?? ''
  const setValue = (v: string) => setBlocks((b) => ({ ...b, [id]: v }))

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      await saveSiteContentFn({ data: { key, lang: blockLang, body: value } })
      setSavedAt((m) => ({ ...m, [id]: new Date().toISOString() }))
      setMsg({ kind: 'ok', text: t('admin.content.saved') })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.content.save.fail') })
    } finally { setSaving(false) }
  }

  // 工具条：选区包裹（加粗/斜体/代码/链接）与行首前缀（标题/引用/列表）
  const wrapSel = (pair: [string, string], ph: string) => {
    const ta = taRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const sel = value.slice(start, end) || ph
    setValue(value.slice(0, start) + pair[0] + sel + pair[1] + value.slice(end))
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + pair[0].length, start + pair[0].length + sel.length)
    })
  }
  const linePrefix = (prefix: string, ph: string) => {
    const ta = taRef.current
    if (!ta) return
    const start = ta.selectionStart
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const sel = value.slice(lineStart, ta.selectionEnd) || ph
    setValue(value.slice(0, lineStart) + prefix + value.slice(lineStart))
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(lineStart + prefix.length, lineStart + prefix.length + sel.length)
    })
  }

  const blockKeys: SiteContentBlockKey[] = ['about', 'links']
  const blockLangs: SiteContentBlockLang[] = ['zh', 'en', 'ru']
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'

  return (
    <div className="admin-dashboard editor-root">
      <div className="admin-header">
        <div>
          <h1>{t('admin.content.title')}</h1>
          <p>{t('admin.content.desc')}</p>
        </div>
        <div className="header-actions">
          <button className="primary-button" onClick={() => void save()} disabled={saving || loading}>
            <Save size={14} />{saving ? t('admin.busy.saving') : t('admin.content.save')}
          </button>
        </div>
      </div>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}

      <div className="panel content-switch">
        <div className="content-switch-row">
          <span className="toolbar-label">{t('admin.content.block')}</span>
          <div className="content-seg">
            {blockKeys.map((k) => (
              <button key={k} type="button" className={key === k ? 'on' : ''} onClick={() => setKey(k)}>
                {t(`admin.content.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="content-switch-row">
          <span className="toolbar-label">{t('admin.content.lang')}</span>
          <div className="content-seg">
            {blockLangs.map((l) => (
              <button key={l} type="button" className={blockLang === l ? 'on' : ''} onClick={() => setBlockLang(l)}>
                {t(`lang.${l}`)}
              </button>
            ))}
          </div>
          {savedAt[id] && <small className="muted content-saved-at">
            {t('admin.content.saved.at', { time: new Date(savedAt[id]).toLocaleString(dateLocale, { dateStyle: 'short', timeStyle: 'short' }) })}
          </small>}
        </div>
        <small className="muted">{t(`admin.content.${key}.hint`)}</small>
      </div>

      {loading ? <div className="skeleton-list" /> : (
        <div className="panel editor-body">
          <div className="editor-toolbar">
            <span className="toolbar-label">Markdown · GFM</span>
            <div className="toolbar-buttons">
              <button type="button" title={t('admin.tb.bold')} onClick={() => wrapSel(['**', '**'], t('admin.tb.in.bold'))}><Bold size={15} /></button>
              <button type="button" title={t('admin.tb.italic')} onClick={() => wrapSel(['*', '*'], t('admin.tb.in.italic'))}><Italic size={15} /></button>
              <button type="button" title={t('admin.tb.code')} onClick={() => wrapSel(['`', '`'], t('admin.tb.in.code'))}><Code2 size={15} /></button>
              <button type="button" title={t('admin.tb.h2')} onClick={() => linePrefix('## ', t('admin.tb.in.title'))}><b>H2</b></button>
              <button type="button" title={t('admin.tb.h3')} onClick={() => linePrefix('### ', t('admin.tb.in.title'))}><b>H3</b></button>
              <button type="button" title={t('admin.tb.quote')} onClick={() => linePrefix('> ', t('admin.tb.in.quote'))}><Quote size={15} /></button>
              <button type="button" title={t('admin.tb.ul')} onClick={() => linePrefix('- ', t('admin.tb.in.item'))}><List size={15} /></button>
              <button type="button" title={t('admin.tb.ol')} onClick={() => linePrefix('1. ', t('admin.tb.in.item'))}><ListOrdered size={15} /></button>
              <button type="button" title={t('admin.tb.link')} onClick={() => wrapSel(['[', '](https://)'], t('admin.tb.in.link'))}>🔗</button>
              <span className="toolbar-spacer" />
              <button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(!preview)}>
                <Eye size={14} /> {preview ? t('admin.preview.off') : t('admin.preview.on')}
              </button>
            </div>
          </div>
          <div className="editor-split">
            <textarea
              ref={taRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t(`admin.content.${key}.ph`)}
              className="md-textarea"
              spellCheck={false}
            />
            {preview && (
              <div className="md-preview-pane">
                <div className="preview-head">{t('admin.preview.head', { n: estimateReadingTime(value) })}</div>
                <div
                  className="markdown-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(value || t('admin.preview.empty')) }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// =================================================================
// 用户管理：评论者列表 + 个签改/删 + 发警告
// =================================================================
type CommenterRow = Awaited<ReturnType<typeof listCommentersFn>>[number]

export function UserManager() {
  const t = useT()
  const [rows, setRows] = React.useState<CommenterRow[] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [query, setQuery] = React.useState('')
  // 正在操作的用户 userId → 草稿个签 / 警告内容
  const [sigDrafts, setSigDrafts] = React.useState<Record<string, string>>({})
  const [warnDrafts, setWarnDrafts] = React.useState<Record<string, string>>({})
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // 身份标签
  const [tagDefs, setTagDefs] = React.useState<UserTag[]>([])
  const [tagFilter, setTagFilter] = React.useState<number | null>(null)
  const [tagMgrOpen, setTagMgrOpen] = React.useState(false)
  const [tagDrafts, setTagDrafts] = React.useState<Record<string, number[]>>({})

  const load = React.useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [list, tags] = await Promise.all([listCommentersFn(), listUserTagsFn().catch(() => [] as UserTag[])])
      setRows(list)
      setTagDefs(tags)
      // 从评论区"管理用户"链接跳入时，聚焦目标用户
      const focus = new URLSearchParams(window.location.search).get('focus')
      if (focus) {
        document.getElementById(`commenter-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    } catch (e) { setError(e instanceof Error ? e.message : t('admin.load.fail')) }
    finally { setLoading(false) }
  }, [t])
  React.useEffect(() => { void load() }, [load])

  const setSig = async (row: CommenterRow, clear = false) => {
    const sig = clear ? '' : (sigDrafts[row.userId] ?? row.signature)
    if (!clear && sig.trim().length < 1) { setMsg({ kind: 'err', text: t('admin.sig.empty.err') }); return }
    setBusyId(row.userId); setMsg(null)
    try {
      const r = await adminSetSignatureFn({ data: { userId: row.userId, signature: sig } })
      setRows((list) => list?.map((x) => x.userId === row.userId ? { ...x, signature: r.signature, signatureUpdatedBy: r.updatedBy } : x) ?? null)
      setMsg({ kind: 'ok', text: clear ? t('admin.sig.cleared') : t('admin.sig.updated') })
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.op.fail') }) }
    finally { setBusyId(null) }
  }

  const warn = async (row: CommenterRow) => {
    const message = (warnDrafts[row.userId] || '').trim()
    if (message.length < 2) { setMsg({ kind: 'err', text: t('admin.warn.need') }); return }
    setBusyId(row.userId); setMsg(null)
    try {
      await issueWarningFn({ data: { userId: row.userId, message } })
      setWarnDrafts((m) => ({ ...m, [row.userId]: '' }))
      setRows((list) => list?.map((x) => x.userId === row.userId ? { ...x, warningCount: x.warningCount + 1 } : x) ?? null)
      setMsg({ kind: 'ok', text: t('admin.warn.sent', { name: row.displayName || row.email }) })
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.op.fail') }) }
    finally { setBusyId(null) }
  }

  const applyTags = async (row: CommenterRow) => {
    const ids = Array.from(new Set(tagDrafts[row.userId] ?? row.tags))
    setBusyId(row.userId); setMsg(null)
    try {
      await setUserTagsFn({ data: { userId: row.userId, tagIds: ids } })
      setRows((list) => list?.map((x) => x.userId === row.userId ? { ...x, tags: ids } : x) ?? null)
      setTagDrafts((m) => { const n = { ...m }; delete n[row.userId]; return n })
      setMsg({ kind: 'ok', text: t('admin.tags.updated') })
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.op.fail') }) }
    finally { setBusyId(null) }
  }

  const filtered = React.useMemo(() => {
    if (!rows) return []
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (q && !r.email.toLowerCase().includes(q) && !r.displayName.toLowerCase().includes(q)) return false
      if (tagFilter != null && !r.tags.includes(tagFilter)) return false
      return true
    })
  }, [rows, query, tagFilter])

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div><h1>{t('admin.users.title')}</h1><p>{t('admin.users.sub')}</p></div>
        <button className="ghost-button" onClick={() => void load()} disabled={loading}>{loading ? t('admin.busy.loading') : t('admin.users.refresh')}</button>
      </div>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
      {error && <div className="banner error">{error}</div>}
      <div className="panel">
        <div className="admin-filter-row">
          <input placeholder={t('admin.users.filter.ph')} value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={tagFilter ?? ''} onChange={(e) => setTagFilter(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('admin.users.alltags')}</option>
            {tagDefs.map((tagDef) => <option key={tagDef.id} value={tagDef.id}>{tagDef.name}</option>)}
          </select>
          <button className="ghost-button" onClick={() => setTagMgrOpen((v) => !v)}>{tagMgrOpen ? t('admin.users.tagmgr.collapse') : t('admin.users.tagmgr')}</button>
        </div>
        {tagMgrOpen && (
          <TagManager tagDefs={tagDefs} setTagDefs={setTagDefs} onMsg={setMsg} setBusyId={setBusyId} />
        )}
        {loading ? <div className="skeleton-list" /> : filtered.length === 0 ? (
          <p className="admin-empty">{t('admin.users.empty')}</p>
        ) : (
          <ul className="commenter-list">
            {filtered.map((row) => (
              <li key={row.userId} id={`commenter-${row.userId}`} className="commenter-card">
                <div className="commenter-head">
                  <div className="commenter-avatar">{(row.displayName || row.email || '?').slice(0, 2).toUpperCase()}</div>
                  <div className="commenter-meta">
                    <strong>{row.displayName || t('admin.users.noname')}</strong>
                    <small>{row.email || t('admin.users.nomail')}</small>
                    <div className="commenter-stats">
                      <span>{t('admin.users.comments', { n: row.commentCount })}</span>
                      <span className={row.warningCount > 0 ? 'warn-count' : ''}>{t('admin.users.warnings', { n: row.warningCount })}</span>
                    </div>
                  </div>
                </div>
                {tagDefs.length > 0 && (
                  <div className="commenter-tags">
                    <div className="commenter-tags-head">
                      <span>{t('admin.users.tags')}</span>
                      {row.tags.length > 0 && <UserTagList tagIds={row.tags} tags={tagDefs} />}
                    </div>
                    <div className="commenter-tag-picker">
                      {tagDefs.map((tagDef) => {
                        const sel = (tagDrafts[row.userId] ?? row.tags).includes(tagDef.id)
                        return (
                          <label key={tagDef.id} className={`tag-chip ${sel ? 'on' : ''}`} style={{ '--tag-color': tagDef.color } as React.CSSProperties}>
                            <input type="checkbox" checked={sel} onChange={() => {
                              const cur = tagDrafts[row.userId] ?? row.tags
                              setTagDrafts((m) => ({ ...m, [row.userId]: sel ? cur.filter((x) => x !== tagDef.id) : [...cur, tagDef.id] }))
                            }} />
                            {tagDef.name}
                          </label>
                        )
                      })}
                    </div>
                    <button className="ghost-button small" disabled={busyId === row.userId} onClick={() => void applyTags(row)}>
                      <Save size={13} />{t('admin.users.apply.tags')}
                    </button>
                  </div>
                )}
                <div className="commenter-sig">
                  <label>
                    {t('admin.users.sig.label', { mod: row.signatureUpdatedBy ? t('admin.users.sig.mod', { by: row.signatureUpdatedBy }) : '' })}
                    <textarea
                      rows={2}
                      value={sigDrafts[row.userId] ?? row.signature}
                      placeholder={t('admin.users.sig.ph')}
                      onChange={(e) => setSigDrafts((m) => ({ ...m, [row.userId]: e.target.value }))}
                    />
                  </label>
                  {((sigDrafts[row.userId] ?? row.signature) || '').trim() && (
                    <div className="commenter-sig-preview">
                      <span>{t('admin.users.preview')}</span>
                      <div className="comment-signature markdown-body compact"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(sigDrafts[row.userId] ?? row.signature) }} />
                    </div>
                  )}
                  <div className="commenter-actions">
                    <button className="primary-button small" disabled={busyId === row.userId} onClick={() => void setSig(row)}>
                      <Save size={13} />{t('admin.users.sig.save')}
                    </button>
                    {(sigDrafts[row.userId] ?? row.signature) && (
                      <button className="ghost-button small" disabled={busyId === row.userId} onClick={() => { setSigDrafts((m) => ({ ...m, [row.userId]: '' })); void setSig(row, true) }}>
                        <Eraser size={13} />{t('admin.users.sig.clear')}
                      </button>
                    )}
                  </div>
                </div>
                <div className="commenter-warn">
                  <label>
                    {t('admin.warn.label')}
                    <textarea
                      rows={2}
                      value={warnDrafts[row.userId] ?? ''}
                      placeholder={t('admin.warn.ph')}
                      onChange={(e) => setWarnDrafts((m) => ({ ...m, [row.userId]: e.target.value }))}
                    />
                  </label>
                  <button className="danger-button small" disabled={busyId === row.userId || (warnDrafts[row.userId] || '').trim().length < 2} onClick={() => void warn(row)}>
                    <MessageSquareWarning size={13} />{t('admin.warn.send')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AdminCommentSearch rows={rows ?? []} />
    </div>
  )
}

// =================================================================
// 管理员评论搜索：范围（自己 / 所有人 / 指定人）+ 正文关键词
// =================================================================
function AdminCommentSearch({ rows }: { rows: CommenterRow[] }) {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  const [open, setOpen] = React.useState(false)
  const [scope, setScope] = React.useState<'mine' | 'all' | 'user'>('all')
  const [targetUserId, setTargetUserId] = React.useState('')
  const [keyword, setKeyword] = React.useState('')
  const [list, setList] = React.useState<Awaited<ReturnType<typeof adminCommentsFn>>>([])
  const [loading, setLoading] = React.useState(false)

  const run = React.useCallback(async () => {
    setLoading(true)
    try {
      const data = await adminCommentsFn({ data: { scope, userId: scope === 'user' ? targetUserId : undefined, keyword } })
      setList(data)
    } catch { setList([]) }
    finally { setLoading(false) }
  }, [scope, targetUserId, keyword])

  return (
    <div className="panel admin-comment-search">
      <button className="ghost-button" onClick={() => setOpen((v) => !v)}>{open ? t('admin.cs.collapse') : t('admin.cs.toggle')}</button>
      {open && (
        <div className="comment-search-body">
          <div className="admin-filter-row">
            <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="mine">{t('admin.cs.mine')}</option>
              <option value="all">{t('admin.cs.all')}</option>
              <option value="user">{t('admin.cs.user')}</option>
            </select>
            {scope === 'user' && (
              <select value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}>
                <option value="">{t('admin.cs.select')}</option>
                {rows.map((r) => <option key={r.userId} value={r.userId}>{t('admin.cs.user.opt', { name: r.displayName || r.email, n: r.commentCount })}</option>)}
              </select>
            )}
            <input placeholder={t('admin.cs.ph')} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            <button className="primary-button small" onClick={() => void run()}>{loading ? t('admin.busy.searching') : t('admin.cs.search')}</button>
          </div>
          {list.length === 0 ? (
            <p className="admin-empty">{loading ? t('admin.busy.loading') : t('admin.cs.empty')}</p>
          ) : (
            <ul className="admin-comments-list">
              {list.map((c) => (
                <li key={c.id} className="admin-comment-item">
                  <Link to="/posts/$slug" params={{ slug: c.postSlug }} className="admin-comment-post">{c.postTitle}</Link>
                  <span className="admin-comment-who">{c.userName}</span>
                  <p className="admin-comment-body">{c.body}</p>
                  <time>{new Date(c.createdAt).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// =================================================================
// 身份标签定义管理：增 / 删 / 改（名称 / 颜色 / 特效）
// =================================================================
const TAG_EFFECTS: UserTag['effect'][] = ['solid', 'glow', 'gradient', 'outline']

function TagManager({ tagDefs, setTagDefs, onMsg, setBusyId }: {
  tagDefs: UserTag[]
  setTagDefs: React.Dispatch<React.SetStateAction<UserTag[]>>
  onMsg: (m: { kind: 'ok' | 'err'; text: string } | null) => void
  setBusyId: (id: string | null) => void
}) {
  const t = useT()
  const [name, setName] = React.useState('')
  const [color, setColor] = React.useState('#7c3aed')
  const [effect, setEffect] = React.useState<UserTag['effect']>('solid')

  const create = async () => {
    setBusyId('tag-new'); onMsg(null)
    try {
      const created = await createUserTagFn({ data: { name, color, effect } })
      setTagDefs((list) => [...list, created])
      setName('')
      onMsg({ kind: 'ok', text: t('admin.tag.created', { name: created.name }) })
    } catch (e) { onMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.create.fail') }) }
    finally { setBusyId(null) }
  }

  const update = async (id: number, patch: { name?: string; color?: string; effect?: UserTag['effect'] }) => {
    setBusyId(`tag-${id}`); onMsg(null)
    try {
      const updated = await updateUserTagFn({ data: { id, ...patch } })
      setTagDefs((list) => list.map((x) => x.id === id ? updated : x))
      onMsg({ kind: 'ok', text: t('admin.tag.updated') })
    } catch (e) { onMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.update.fail') }) }
    finally { setBusyId(null) }
  }

  const remove = async (tag: UserTag) => {
    if (!window.confirm(t('admin.tag.confirm', { name: tag.name }))) return
    setBusyId(`tag-${tag.id}`); onMsg(null)
    try {
      await deleteUserTagFn({ data: { id: tag.id } })
      setTagDefs((list) => list.filter((x) => x.id !== tag.id))
      onMsg({ kind: 'ok', text: t('admin.tag.deleted') })
    } catch (e) { onMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.delete.fail') }) }
    finally { setBusyId(null) }
  }

  return (
    <div className="tag-manager">
      <div className="tag-manager-create">
        <input placeholder={t('admin.tag.ph')} value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title={t('admin.tag.color')} />
        <select value={effect} onChange={(e) => setEffect(e.target.value as UserTag['effect'])}>
          {TAG_EFFECTS.map((eff) => <option key={eff} value={eff}>{t(`admin.effect.${eff}`)}</option>)}
        </select>
        <span className="user-tag-list"><span className={`user-tag user-tag-${effect}`} style={{ '--tag-color': color } as React.CSSProperties}>{t('admin.tag.preview')}</span></span>
        <button className="primary-button small" disabled={!name.trim()} onClick={() => void create()}>{t('admin.cat.create')}</button>
      </div>
      <div className="tag-manager-list">
        {tagDefs.map((tag) => (
          <div key={tag.id} className="tag-manager-row">
            <UserTagList tagIds={[tag.id]} tags={tagDefs} />
            <input value={tag.name} maxLength={20} onChange={(e) => void update(tag.id, { name: e.target.value })} />
            <input type="color" value={tag.color} onChange={(e) => void update(tag.id, { color: e.target.value })} />
            <select value={tag.effect} onChange={(e) => void update(tag.id, { effect: e.target.value as UserTag['effect'] })}>
              {TAG_EFFECTS.map((eff) => <option key={eff} value={eff}>{t(`admin.effect.${eff}`)}</option>)}
            </select>
            <button className="ghost-button small danger" onClick={() => void remove(tag)}>{t('admin.act.delete')}</button>
          </div>
        ))}
        {tagDefs.length === 0 && <p className="admin-empty">{t('admin.tag.empty')}</p>}
      </div>
    </div>
  )
}

// =================================================================
// 反馈处理：列表 + 附件下载 + 状态流转
// =================================================================
type FeedbackRow = Awaited<ReturnType<typeof listFeedbackFn>>[number]

export function FeedbackManager() {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  const statusLabel = (s: string) => t(`admin.fb.status.${s}`)
  const [rows, setRows] = React.useState<FeedbackRow[] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [filter, setFilter] = React.useState<'all' | 'open' | 'resolved' | 'dismissed'>('open')
  const [busyId, setBusyId] = React.useState<number | null>(null)
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true); setError('')
    try { setRows(await listFeedbackFn()) }
    catch (e) { setError(e instanceof Error ? e.message : t('admin.load.fail')) }
    finally { setLoading(false) }
  }, [t])
  React.useEffect(() => { void load() }, [load])

  const setStatus = async (row: FeedbackRow, status: 'resolved' | 'dismissed' | 'open') => {
    setBusyId(row.id); setMsg(null)
    try {
      await feedbackStatusFn({ data: { id: row.id, status } })
      setRows((list) => list?.map((x) => x.id === row.id
        ? { ...x, status, resolvedAt: status === 'resolved' ? new Date().toISOString() : x.resolvedAt }
        : x) ?? null)
      setMsg({ kind: 'ok', text: t('admin.fb.marked', { id: row.id, status: statusLabel(status) }) })
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('admin.op.fail') }) }
    finally { setBusyId(null) }
  }

  const filtered = React.useMemo(() => {
    if (!rows) return []
    return filter === 'all' ? rows : rows.filter((r) => r.status === filter)
  }, [rows, filter])

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div><h1>{t('admin.fb.title')}</h1><p>{t('admin.fb.sub')}</p></div>
        <div className="admin-filter-tabs">
          {(['open', 'resolved', 'dismissed', 'all'] as const).map((s) => (
            <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(s)}>
              {s === 'all' ? t('admin.fb.all') : statusLabel(s)}
              {s !== 'all' && rows && <em>{rows.filter((r) => r.status === s).length}</em>}
            </button>
          ))}
        </div>
      </div>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
      {error && <div className="banner error">{error}</div>}
      <div className="panel">
        {loading ? <div className="skeleton-list" /> : filtered.length === 0 ? (
          <p className="admin-empty">{filter === 'open' ? t('admin.fb.empty.open') : t('admin.fb.empty')}</p>
        ) : (
          <ul className="feedback-list">
            {filtered.map((row) => (
              <li key={row.id} className={`feedback-card status-${row.status}`}>
                <div className="feedback-head">
                  <strong>#{row.id} {row.subject}</strong>
                  <span className={`feedback-status ${row.status}`}>{statusLabel(row.status) || row.status}</span>
                  <time>{new Date(row.createdAt).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                </div>
                <div className="feedback-from">{t('admin.fb.from')}{row.email}</div>
                <div className="feedback-body markdown-body compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(row.body) }} />
                {row.attachments.length > 0 && (
                  <ul className="feedback-attachments">
                    {row.attachments.map((a) => (
                      <li key={a.id}>
                        <FileDown size={13} />
                        <a href={feedbackFileUrl(a.id)} target="_blank" rel="noreferrer">{a.filename}</a>
                        <em>{formatBytes(a.sizeBytes)}</em>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="feedback-actions">
                  {row.status !== 'resolved' && (
                    <button className="primary-button small" disabled={busyId === row.id} onClick={() => void setStatus(row, 'resolved')}>{t('admin.fb.resolve')}</button>
                  )}
                  {row.status !== 'dismissed' && (
                    <button className="ghost-button small" disabled={busyId === row.id} onClick={() => void setStatus(row, 'dismissed')}>{t('admin.fb.dismiss')}</button>
                  )}
                  {row.status !== 'open' && (
                    <button className="ghost-button small" disabled={busyId === row.id} onClick={() => void setStatus(row, 'open')}>{t('admin.fb.reopen')}</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// =================================================================
// 兼容导出：原 shadcn Card* 组件（避免历史引用）
// =================================================================
function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('bg-panel border border-[color:var(--line)] rounded-xl p-6', className)} {...props} />
}
export { Card }
