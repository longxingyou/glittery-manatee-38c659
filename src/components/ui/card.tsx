import * as React from 'react'
import { createServerFn } from '@tanstack/react-start'
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import {
  Bold,
  CirclePlus,
  Code2,
  Eye,
  FileDown,
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
  ImageIcon,
} from 'lucide-react'
import { z } from 'zod'

import { cn } from '@/lib/utils'
import {
  DEFAULT_SITE_DESCRIPTION,
  DEFAULT_SITE_TITLE,
  attachmentDownloadUrl,
  attachmentUploadUrl,
  estimateReadingTime,
  formatBytes,
  slugify,
  type AdminSettings,
  type AdminStatus,
  type AttachmentPublic,
  type CategoryInfo,
  type PostData,
  type PostStatus,
} from '@/lib/utils'
import { renderMarkdown } from '@/lib/markdown'

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
  allCategoryNamesFn as _pub_allCategoryNamesFn,
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
  .handler(async ({ data }): Promise<{ post: PostData; attachments: AttachmentPublic[]; categories: CategoryInfo[] }> => {
    const mod = await import('../../../db/index.js')
    await mod.requireAdmin()
    const post = await mod.getDbPostById(data.id)
    if (!post) throw new Error('文章不存在。')
    const attachments = await mod.listAttachmentsAdmin(post.slug)
    const categories = await mod.listCategoryInfo()
    return { post, attachments, categories }
  })

const getEditorBootstrapFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ categories: CategoryInfo[] }> => {
    const mod = await import('../../../db/index.js')
    await mod.requireAdmin()
    const categories = await mod.listCategoryInfo()
    return { categories }
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
  .inputValidator((input) => z.object({ name: z.string().trim().min(1).max(40) }).parse(input))
  .handler(async ({ data }): Promise<{ id: number; name: string }> => {
    const mod = await import('../../../db/index.js')
    return mod.createCategory(data.name)
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

// 保证公开别名不会因 noUnusedLocals 告警（实际已通过同名 const 引用）
void _pub_adminStatusFn; void _pub_settingsFn; void _pub_allCategoryNamesFn
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
  const [status, setStatus] = React.useState<AdminStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const refresh = React.useCallback(async () => {
    setLoading(true); setError('')
    try { setStatus(await adminStatusFn()) } catch (e) { setError(e instanceof Error ? e.message : '鉴权查询失败。') }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void refresh() }, [refresh])
  return { loading, status, error, refresh }
}

// =================================================================
// 门控包装（router.tsx 引用）
// =================================================================
export function AdminGateWrap({ children }: { children: React.ReactNode }) {
  const { loading, status, error, refresh } = useAdminStatus()
  if (loading) return <div className="admin-loading">正在校验管理员权限…</div>
  if (error) return <div className="admin-error">校验失败：{error} <button onClick={() => void refresh()}>重试</button></div>
  if (!status) return null
  if (!status.authed) {
    return (
      <div className="admin-gate-card">
        <div className="gate-icon"><UserRound size={48} /></div>
        <h2>请先登录</h2>
        <p>管理后台只对已验证的管理员开放。点击下方按钮使用站点的邮箱登录窗口。</p>
        <button
          className="primary-button"
          onClick={() => window.dispatchEvent(new Event('open-auth'))}
        >
          打开登录窗口
        </button>
        {status.email ? <small>当前登录邮箱：{status.email}（权限不足？）</small> : null}
      </div>
    )
  }
  if (!status.isAdmin) {
    return (
      <div className="admin-gate-card">
        <div className="gate-icon alert"><ShieldAlert size={48} /></div>
        <h2>不在管理员名单</h2>
        <p>当前邮箱 <b>{status.email}</b> 不在管理员列表中。</p>
        {!status.adminConfigured && (
          <p className="gate-warn">
            站点尚未配置管理员邮箱。请先通过环境变量 <code>ADMIN_EMAILS</code> 配置至少一个管理员邮箱，
            或直接修改 settings 表的 <code>admin_emails</code> 字段后再来。
          </p>
        )}
        <button className="text-button" onClick={() => void refresh()}>刷新权限</button>
      </div>
    )
  }
  return <>{children}</>
}

// =================================================================
// 管理后台 Layout（侧边栏 + 内容区）
// =================================================================
export function AdminLayout() {
  const { status } = useAdminStatus()
  return (
    <div className="admin-shell">
      <aside className="admin-side">
        <div className="admin-side-head">
          <div className="brand-mark" style={{ color: 'var(--accent)' }}><TerminalSquare size={18} /><span>admin.panel</span></div>
          <small className="admin-subtitle">// Syntax Garden 管理控制台</small>
        </div>
        <nav className="admin-nav">
          <Link to="/admin/posts" className="admin-nav-item"><LayoutDashboard size={17} /><span>文章仪表盘</span></Link>
          <Link to="/admin/posts/new" className="admin-nav-item"><Newspaper size={17} /><span>新建文章</span></Link>
          <Link to="/admin/categories" className="admin-nav-item"><FolderTree size={17} /><span>分类管理</span></Link>
          <Link to="/admin/settings" className="admin-nav-item"><SettingsIcon size={17} /><span>站点设置</span></Link>
          <a className="admin-nav-item" href="/" target="_blank" rel="noreferrer"><Home size={17} /><span>查看站点</span></a>
          <a className="admin-nav-item" href="/rss.xml" target="_blank" rel="noreferrer"><FileDown size={17} /><span>RSS 订阅源</span></a>
        </nav>
        <div className="admin-side-foot">
          <div className="mini-user">
            <span>{(status?.email || '?').slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{status?.email || '未登录'}</strong>
              <small>
                <ShieldCheck size={11} /> 管理员
              </small>
            </div>
          </div>
          <button className="ghost-button" onClick={() => window.dispatchEvent(new Event('open-auth'))}>
            <LogOut size={14} /> 账户面板
          </button>
        </div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar">
          <div className="crumbs"><span>~/admin</span><span>/</span><b>{typeof location !== 'undefined' ? location.pathname.replace('/admin', '') || 'dashboard' : 'dashboard'}</b></div>
          <div className="admin-topbar-actions">
            <Link to="/admin/posts/new" className="primary-button small"><CirclePlus size={14} />新建文章</Link>
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
  const [data, setData] = React.useState<{ posts: PostData[]; categories: CategoryInfo[]; attachments: AttachmentPublic[] } | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [deleting, setDeleting] = React.useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState<number | null>(null)
  const load = React.useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await dashboardFn()) } catch (e) { setError(e instanceof Error ? e.message : '加载失败。') }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])

  const remove = async (id: number) => {
    setDeleting(id)
    try {
      await deletePostFn({ data: { id } })
      setConfirmDelete(null)
      await load()
    } catch (e) { alert(e instanceof Error ? e.message : '删除失败。') }
    finally { setDeleting(null) }
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div>
          <h1>文章仪表盘</h1>
          <p>在 Markdown 里记下你的想法，然后让它们被人读到。</p>
        </div>
        <Link to="/admin/posts/new" className="primary-button"><CirclePlus size={16} />新建文章</Link>
      </div>
      <div className="stat-grid">
        <div className="stat-card tone-1"><span>草稿</span><b>{data?.posts.filter((p) => p.status === 'draft').length ?? 0}</b></div>
        <div className="stat-card tone-2"><span>已发布（数据库）</span><b>{data?.posts.filter((p) => p.status === 'published').length ?? 0}</b></div>
        <div className="stat-card tone-3"><span>分类</span><b>{data?.categories.length ?? 0}</b></div>
        <div className="stat-card tone-4"><span>附件</span><b>{data?.attachments.length ?? 0}</b></div>
      </div>
      {error && <div className="banner error">{error} <button onClick={() => void load()}>重试</button></div>}
      {loading && <div className="skeleton-table" />}
      {data && (
        <div className="panel">
          <div className="panel-head"><h3>文章列表 <small>（仅显示存于数据库的文章；content/posts 静态稿不会出现在此处）</small></h3></div>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>#</th>
                <th>标题</th>
                <th style={{ width: 180 }}>路径 slug</th>
                <th style={{ width: 120 }}>日期</th>
                <th style={{ width: 120 }}>状态</th>
                <th style={{ width: 200 }}>分类</th>
                <th style={{ width: 170 }}>阅读</th>
                <th style={{ width: 150 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.posts.length === 0 && (
                <tr><td colSpan={8} className="empty-row">还没有任何文章。点击右上角「新建文章」开始记录吧。</td></tr>
              )}
              {data.posts.map((post) => (
                <tr key={post.id}>
                  <td className="mono">{post.id}</td>
                  <td className="strong">
                    <Link to="/admin/posts/$id" params={{ id: String(post.id) }} className="row-link">{post.title}</Link>
                    <div className="row-sub">更新：{post.updatedAt ? new Date(post.updatedAt).toLocaleString('zh-CN') : '—'}</div>
                  </td>
                  <td className="mono small">/{post.slug}</td>
                  <td className="mono small">{post.date}</td>
                  <td><span className={post.status === 'published' ? 'badge badge-green' : 'badge badge-yellow'}>
                    {post.status === 'published' ? '已发布' : '草稿'}
                  </span></td>
                  <td>
                    <div className="chip-row">
                      {post.categories.length === 0 && <em className="muted">未分类</em>}
                      {post.categories.slice(0, 3).map((c) => (<span className="chip" key={c}><Hash size={11} />{c}</span>))}
                      {post.categories.length > 3 && <span className="chip more">+{post.categories.length - 3}</span>}
                    </div>
                  </td>
                  <td className="small muted">{estimateReadingTime(post.content)} 分钟</td>
                  <td>
                    <div className="row-actions">
                      <Link to="/admin/posts/$id" params={{ id: String(post.id) }} className="row-action primary">编辑</Link>
                      <a className="row-action" target="_blank" rel="noreferrer" href={`/posts/${encodeURIComponent(post.slug)}`}>预览</a>
                      {confirmDelete === post.id ? (
                        <>
                          <button className="row-action danger" disabled={deleting === post.id} onClick={() => void remove(post.id!)}>
                            {deleting === post.id ? '…删除中' : '确认删除'}
                          </button>
                          <button className="row-action" onClick={() => setConfirmDelete(null)}>取消</button>
                        </>
                      ) : (
                        <button className="row-action danger" onClick={() => setConfirmDelete(post.id!)}>删除</button>
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
  const [list, setList] = React.useState<CategoryInfo[]>([])
  const [loading, setLoading] = React.useState(true)
  const [name, setName] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const load = React.useCallback(async () => {
    setLoading(true)
    try { setList(await listCategoriesFn()) } catch (e) { setError(e instanceof Error ? e.message : '加载失败。') }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])
  const create = async () => {
    setBusy(true); setError('')
    try { await createCategoryFn({ data: { name } }); setName(''); await load() }
    catch (e) { setError(e instanceof Error ? e.message : '创建失败。') }
    finally { setBusy(false) }
  }
  const remove = async (row: CategoryInfo) => {
    if (row.builtin) { alert('此分类由静态 Markdown 文章衍生，不可删除；删除对应静态文件即可。'); return }
    if (!confirm(`删除分类「${row.name}」？（该分类会从所有数据库文章中自动摘除，静态文章不受影响）`)) return
    try { await deleteCategoryFn({ data: { id: row.id } }); await load() }
    catch (e) { alert(e instanceof Error ? e.message : '删除失败。') }
  }
  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div><h1>分类管理</h1><p>分类可以被新建、删除；静态文章衍生出来的分类被标记为 builtin，不可在此删除。</p></div>
      </div>
      <div className="panel two-col">
        <div>
          <h3 className="panel-title">新增分类</h3>
          <div className="inline-form">
            <input placeholder="例如：算法、随笔、旅行…" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="primary-button" onClick={() => void create()} disabled={busy || !name.trim()}>{busy ? '创建中…' : '创建'}</button>
          </div>
          {error && <div className="banner error small">{error}</div>}
          <p className="muted small mt8">限制：≤ 40 字符。同名分类不会被重复创建。</p>
        </div>
        <div>
          <h3 className="panel-title">全部分类 {loading ? '（加载中…）' : `（${list.length}）`}</h3>
          {loading ? <div className="skeleton-list" /> : (
            <ul className="category-list">
              {list.map((c) => (
                <li key={`${c.id}-${c.name}`}>
                  <div className="line-main">
                    <span className="chip"><Tags size={12} />{c.name}</span>
                    {c.builtin && <span className="badge badge-gray">builtin</span>}
                    <div className="count-inline">
                      <span>DB文章：<b>{c.dbCount}</b></span>
                      <span>静态文章：<b>{c.staticCount}</b></span>
                    </div>
                  </div>
                  <button
                    className="row-action danger"
                    disabled={c.builtin}
                    title={c.builtin ? '静态衍生分类不可删除' : '删除分类'}
                    onClick={() => remove(c)}
                  >
                    <Trash2 size={14} /> 删除
                  </button>
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
function applyLinePrefix(textarea: HTMLTextAreaElement, prefix: string) {
  const start = textarea.selectionStart, end = textarea.selectionEnd
  const before = textarea.value.slice(0, start)
  const selected = textarea.value.slice(start, end) || textarea.value.slice(before.lastIndexOf('\n') + 1, end + 1) || ''
  const after = textarea.value.slice(end)
  const lineStart = before.length - (before.length - before.lastIndexOf('\n') - 1)
  const head = textarea.value.slice(0, lineStart)
  const replaced = `${prefix}${selected || '列表项'}`
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
  const line = (prefix: string) => {
    const el = ref.current
    if (!el) return
    const { value: v, cursor } = applyLinePrefix(el, prefix)
    setValue(v)
    queueMicrotask(() => { el.focus(); el.setSelectionRange(cursor, cursor) })
  }
  return { ref, value, setValue, wrap, line }
}

// =================================================================
// 文章编辑器页面（新建 / 编辑）
// =================================================================
export function PostEditorPage() {
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
    attachments: AttachmentPublic[]
    categoryOptions: CategoryInfo[]
  }>({
    id: null, title: '', slug: '', summary: '', content: '', categories: [], status: 'draft',
    date: new Date().toISOString().slice(0, 10), attachments: [], categoryOptions: [],
  })
  const [preview, setPreview] = React.useState(true)
  const editor = useMarkdownEditor('')

  const flashErr = (e: unknown) => setMsg({ kind: 'err', text: e instanceof Error ? e.message : '操作失败。' })

  // 初始化：编辑模式加载文章详情；新建模式仅拉分类
  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        if (editId && Number.isInteger(editId) && editId > 0) {
          const { post, attachments, categories } = await getPostForEditFn({ data: { id: editId } })
          if (!alive) return
          setBootstrap({
            id: post.id, title: post.title, slug: post.slug, summary: post.summary,
            content: post.content, categories: [...post.categories], status: post.status,
            date: post.date, attachments, categoryOptions: categories,
          })
          editor.setValue(post.content)
        } else {
          const { categories } = await getEditorBootstrapFn()
          if (!alive) return
          setBootstrap((b) => ({ ...b, categoryOptions: categories }))
        }
      } catch (e) { flashErr(e) }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId])

  const slugFromTitle = () => setBootstrap((b) => ({ ...b, slug: slugify(b.slug || b.title) }))
  const toggleCategory = (name: string) => setBootstrap((b) => ({
    ...b,
    categories: b.categories.includes(name) ? b.categories.filter((c) => c !== name) : [...b.categories, name],
  }))
  const addNewCategory = () => {
    const name = window.prompt('分类名（≤ 40 字符）：', '')?.trim()
    if (!name) return
    void (async () => {
      try {
        await createCategoryFn({ data: { name } })
        setBootstrap((b) => ({
          ...b,
          categories: b.categories.includes(name) ? b.categories : [...b.categories, name],
          categoryOptions: [...b.categoryOptions].sort((a, z) => a.name.localeCompare(z.name)).some((c) => c.name === name)
            ? b.categoryOptions
            : [...b.categoryOptions, { id: 0, name, dbCount: 0, staticCount: 0, builtin: false }],
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
        },
      })
      setMsg({ kind: 'ok', text: nextStatus === 'published' ? '已发布！' : '已保存为草稿。' })
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
          <h1>{editId ? `编辑文章 #${editId}` : '新建文章'}</h1>
          <p>支持标准 Markdown（GFM）与 LaTeX 公式 $E=mc^2$；你可以随时保存为草稿或发布。</p>
        </div>
        <div className="header-actions">
          <Link to="/admin/posts" className="ghost-button">返回列表</Link>
          <button className="ghost-button" onClick={() => void submit('draft')} disabled={saving}>
            <Save size={14} />{saving ? '保存中…' : '保存草稿'}
          </button>
          <button className="primary-button" onClick={() => void submit('published')} disabled={saving}>
            <Save size={14} />{bootstrap.status === 'published' || !editId ? '发布文章' : '改为已发布并保存'}
          </button>
        </div>
      </div>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}

      <div className="panel editor-meta">
        <div className="meta-row">
          <label>
            标题 <span className="req">*</span>
            <input
              value={bootstrap.title}
              onChange={(e) => setBootstrap((b) => ({ ...b, title: e.target.value }))}
              placeholder="给这篇文章一个清晰的标题"
            />
          </label>
          <label style={{ flex: '0 0 280px' }}>
            发布日期
            <input
              type="date"
              value={bootstrap.date}
              onChange={(e) => setBootstrap((b) => ({ ...b, date: e.target.value }))}
            />
          </label>
          <label style={{ flex: '0 0 220px' }}>
            状态
            <select
              value={bootstrap.status}
              onChange={(e) => setBootstrap((b) => ({ ...b, status: e.target.value as PostStatus }))}
            >
              <option value="draft">草稿（仅管理员可见）</option>
              <option value="published">已发布（全站可见）</option>
            </select>
          </label>
        </div>
        <div className="meta-row">
          <label>
            路径 slug（文章 URL 的后半段） <span className="req">*</span>
            <div className="field-inline">
              <span className="prefix">/posts/</span>
              <input value={bootstrap.slug} onChange={(e) => setBootstrap((b) => ({ ...b, slug: slugify(e.target.value) }))} />
              <button type="button" className="ghost-button" onClick={slugFromTitle}>按标题生成</button>
            </div>
            <small className="muted">允许字母、数字、下划线、连字符、中文；空格会自动转换为下划线。静态 Markdown 的路径不能被覆盖。</small>
          </label>
        </div>
        <div className="meta-row">
          <label>
            摘要（≤ 1000 字，会出现在文章列表卡片和 RSS 描述中）
            <textarea
              rows={2}
              value={bootstrap.summary}
              onChange={(e) => setBootstrap((b) => ({ ...b, summary: e.target.value }))}
              placeholder="用 1-2 句话概括这篇文章。"
            />
          </label>
        </div>
        <div className="meta-row">
          <label style={{ flex: 1 }}>
            分类 <button type="button" className="row-action" onClick={addNewCategory}>+ 新建分类</button>
            <div className="category-options">
              {bootstrap.categoryOptions.map((c) => (
                <label key={`${c.id}-${c.name}`} className={bootstrap.categories.includes(c.name) ? 'tag on' : 'tag'}>
                  <input
                    type="checkbox"
                    checked={bootstrap.categories.includes(c.name)}
                    onChange={() => toggleCategory(c.name)}
                  />
                  {c.builtin && <span className="chip-mini">s</span>}
                  {c.name}
                </label>
              ))}
              {bootstrap.categoryOptions.length === 0 && <em className="muted">还没有分类，点「+ 新建分类」添加一个。</em>}
            </div>
          </label>
        </div>
      </div>

      <div className="panel editor-body">
        <div className="editor-toolbar">
          <span className="toolbar-label">Markdown · LaTeX · GFM</span>
          <div className="toolbar-buttons">
            <button type="button" title="粗体 **text**" onClick={() => editor.wrap(['**', '**'], '粗体文字')}><Bold size={15} /></button>
            <button type="button" title="斜体 *text*" onClick={() => editor.wrap(['*', '*'], '斜体文字')}><Italic size={15} /></button>
            <button type="button" title="行内代码 `code`" onClick={() => editor.wrap(['`', '`'], '代码')}><Code2 size={15} /></button>
            <button type="button" title="二级标题 ## " onClick={() => editor.line('## ')}><b>H2</b></button>
            <button type="button" title="三级标题 ### " onClick={() => editor.line('### ')}><b>H3</b></button>
            <button type="button" title="引用块 > " onClick={() => editor.line('> ')}><Quote size={15} /></button>
            <button type="button" title="无序列表 - " onClick={() => editor.line('- ')}><List size={15} /></button>
            <button type="button" title="有序列表 1. " onClick={() => editor.line('1. ')}><ListOrdered size={15} /></button>
            <button type="button" title="链接 [text](url)" onClick={() => editor.wrap(['[', '](https://)'], '链接文字')}>🔗</button>
            <button type="button" title="图片 ![alt](url)" onClick={() => editor.wrap(['![', '](https://)'], '图注')}><ImageIcon size={15} /></button>
            <button type="button" title="代码块 ```" onClick={() => editor.wrap(['\n```ts\n', '\n```\n'], '// 在这里写代码')}>{'{ }'}</button>
            <span className="toolbar-spacer" />
            <button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(!preview)}>
              <Eye size={14} /> {preview ? '关闭预览' : '开启预览'}
            </button>
          </div>
        </div>
        <div className="editor-split">
          <textarea
            ref={editor.ref}
            value={editor.value}
            onChange={(e) => editor.setValue(e.target.value)}
            placeholder={'# 开始写下你的第一篇想法\n\n支持 **Markdown**、$E=mc^2$ 公式与 `代码`。'}
            className="md-textarea"
            spellCheck={false}
          />
          {preview && (
            <div className="md-preview-pane">
              <div className="preview-head">实时预览 · {estimateReadingTime(editor.value)} 分钟</div>
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(editor.value || '*还没有内容，试试在左侧输入 `# Hello`*') }}
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
          <FileDown size={16} /> 保存文章后即可在此上传附件与设置密码锁。
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
      if (!response.ok) throw new Error(data.error || '上传失败')
      const row = data.attachment as AttachmentPublic
      onChange([...initial, row])
      if (fileRef.current) fileRef.current.value = ''
      setUpPassword('')
    } catch (e) { setUpError(e instanceof Error ? e.message : '上传失败。') }
    finally { setUploading(false) }
  }
  const setPassword = async (att: AttachmentPublic) => {
    const pwd = passwordEdits[att.id] ?? ''
    setBusyId(att.id)
    try {
      await setAttachmentPasswordFn({ data: { id: att.id, password: pwd || null } })
      onChange(initial.map((a) => a.id === att.id ? { ...a, locked: !!pwd } : a))
      setPasswordEdits((m) => ({ ...m, [att.id]: '' }))
    } catch (e) { alert(e instanceof Error ? e.message : '修改失败。') }
    finally { setBusyId(null) }
  }
  const remove = async (att: AttachmentPublic) => {
    if (!confirm(`删除附件「${att.filename}」？此操作不可撤销。`)) return
    setBusyId(att.id)
    try {
      await deleteAttachmentFn({ data: { id: att.id } })
      onChange(initial.filter((a) => a.id !== att.id))
    } catch (e) { alert(e instanceof Error ? e.message : '删除失败。') }
    finally { setBusyId(null) }
  }

  return (
    <div className="panel attachments-panel">
      <div className="panel-head between">
        <h3>附件 · 下载 · 密码锁 <small>（每个文件 ≤ 4 MB；二进制直接存入数据库，Netlify 中国大陆用户无需 Blobs 服务）</small></h3>
      </div>
      <div className="upload-row">
        <input ref={fileRef} type="file" onChange={() => void doUpload()} style={{ display: 'none' }} />
        <label className="pwd-label">
          为新附件设置密码（留空 = 公开）：
          <input type="password" value={upPassword} onChange={(e) => setUpPassword(e.target.value)} placeholder="可选" />
        </label>
        <span className="spacer" />
        <button className="ghost-button" onClick={triggerPick} disabled={uploading}>
          <Upload size={15} /> {uploading ? '上传中…' : '选择文件并上传'}
        </button>
      </div>
      {upError && <div className="banner error small">{upError}</div>}
      <ul className="attach-list">
        {initial.length === 0 && <li className="empty-row small">还没有附件。</li>}
        {initial.map((att) => (
          <li key={att.id} className="attach-row">
            <div className="attach-main">
              <div className="attach-icon"><GripVertical size={18} /></div>
              <div className="attach-meta">
                <strong>{att.filename}</strong>
                <div className="attach-sub">
                  <span>{formatBytes(att.sizeBytes)}</span>
                  <span>· {att.mimeType || 'application/octet-stream'}</span>
                  <span>· 已下载 <b>{att.downloads}</b> 次</span>
                  <span>· 上传于 {new Date(att.createdAt).toLocaleDateString('zh-CN')}</span>
                  <span className={att.locked ? 'chip lock' : 'chip unlock'}>
                    {att.locked ? <><Lock size={12} />已加密</> : <><LockOpen size={12} />公开</>}
                  </span>
                </div>
              </div>
            </div>
            <div className="attach-actions">
              <input
                type="password"
                placeholder={att.locked ? '修改密码，留空 = 移除锁' : '设置密码以加锁'}
                value={passwordEdits[att.id] ?? ''}
                onChange={(e) => setPasswordEdits((m) => ({ ...m, [att.id]: e.target.value }))}
              />
              <button className="row-action primary" disabled={busyId === att.id} onClick={() => setPassword(att)}>
                {busyId === att.id ? '…处理中' : att.locked ? '改密/解锁' : '上锁'}
              </button>
              <a className="row-action" href={attachmentDownloadUrl(att.id)} target="_blank" rel="noreferrer"><FileDown size={13} />下载</a>
              <button className="row-action danger" disabled={busyId === att.id} onClick={() => remove(att)}>
                <Trash2 size={13} />删除
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
  const [data, setData] = React.useState<AdminSettings>({
    siteTitle: DEFAULT_SITE_TITLE, siteDescription: DEFAULT_SITE_DESCRIPTION, customCss: '', adminEmails: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  React.useEffect(() => {
    void (async () => {
      try {
        const res = await settingsFn()
        if (res.isAdmin && res.admin) setData(res.admin)
        else setMsg({ kind: 'err', text: res.isAdmin ? '设置加载异常。' : '当前账户非管理员，无法修改设置。' })
      } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : '加载失败。' }) }
      finally { setLoading(false) }
    })()
  }, [])
  const submit = async () => {
    setSaving(true); setMsg(null)
    try { const r = await saveSettingsFn({ data }); setData(r); setMsg({ kind: 'ok', text: '设置已保存。' }) }
    catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : '保存失败。' }) }
    finally { setSaving(false) }
  }
  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div><h1>站点设置</h1><p>这里的改变会立即生效，包括站点标题、描述与全站 CSS 注入。</p></div>
        <button className="primary-button" onClick={() => void submit()} disabled={saving}>
          <Save size={14} />{saving ? '保存中…' : '保存设置'}
        </button>
      </div>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
      {loading ? <div className="skeleton-list" /> : (
        <div className="panel settings-grid">
          <label>
            站点标题
            <input value={data.siteTitle} onChange={(e) => setData({ ...data, siteTitle: e.target.value })} />
          </label>
          <label>
            站点描述（会在首页 hero 与 RSS 中出现）
            <textarea rows={2} value={data.siteDescription} onChange={(e) => setData({ ...data, siteDescription: e.target.value })} />
          </label>
          <label>
            管理员邮箱（用逗号、分号或空格分隔；环境变量 ADMIN_EMAILS 会一并生效）
            <textarea rows={2} value={data.adminEmails} onChange={(e) => setData({ ...data, adminEmails: e.target.value })}
              placeholder="you@example.com, editor@example.com" />
          </label>
          <label className="full">
            自定义 CSS（会以 <code>{`<style>`}</code> 注入到 <code>{`<head>`}</code>；使用 CSS 变量保持主题统一；≤ 100 KB）
            <textarea
              rows={16}
              spellCheck={false}
              className="mono-textarea"
              value={data.customCss}
              onChange={(e) => setData({ ...data, customCss: e.target.value })}
              placeholder={
`/* 例子：改变标题栏颜色 */
.titlebar { background: linear-gradient(90deg, var(--chrome), #131e2e); }
/* 例子：重新着色主题强调色 */
:root { --accent: #4fd1c5; --accent-2: #7c9aff; }`
              }
            />
            {data.customCss && (
              <details><summary>预览 CSS 注入效果（仅当前标签页临时应用）</summary>
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
// 兼容导出：原 shadcn Card* 组件（避免历史引用）
// =================================================================
function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('bg-panel border border-[color:var(--line)] rounded-xl p-6', className)} {...props} />
}
export { Card }
