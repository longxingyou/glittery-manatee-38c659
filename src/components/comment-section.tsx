import { getUser, onAuthChange, type AuthUser } from '@/lib/auth-client'
import {
  CheckCircle2,
  Eye,
  MessageSquareText,
  Package,
  Pencil,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '@/lib/markdown'
import { useMermaidLazy } from '@/lib/use-mermaid'
import { listUserTagsFn } from '@/components/user-fns'
import { UserTagList } from '@/components/user-tag-badge'
import { StickerTrigger } from '@/components/sticker-picker'
import { useT, useLang } from '@/lib/i18n'
import type { UserTag } from '../../db/index.js'

type CommentItem = {
  id: number
  parentId: number | null
  userName: string
  body: string
  createdAt: string
  editedAt: string | null
  status: string
  likes: number
  // 服务端计算的“是否为当前访客本人”，用于编辑/删除按钮可见性（邮箱不离开服务端）
  mine: boolean
  // 个性签名（Markdown 源，经 renderMarkdown 消毒后渲染）
  signature: string
  // 身份标签 id 列表（外显装饰）
  tags: number[]
  // 仅管理员视角携带：评论者身份 id，用于跳转用户管理
  userKey?: string
}

type Me = { email: string | null; isAdmin: boolean }

// 超过该字符数的评论默认折叠，可展开阅读全文
const LONG_BODY = 600

function fmtDate(value: string, locale: string) {
  return new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

/** 在 textarea 光标处插入文本，并恢复焦点 */
function insertAtCursor(ta: HTMLTextAreaElement | null, text: string, setter: (v: string) => void) {
  if (!ta) { setter(text); return }
  const start = ta.selectionStart
  const end = ta.selectionEnd
  const before = ta.value.slice(0, start)
  const after = ta.value.slice(end)
  setter(before + text + after)
  requestAnimationFrame(() => {
    ta.focus()
    const pos = start + text.length
    ta.setSelectionRange(pos, pos)
  })
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const openAuth = () => window.dispatchEvent(new Event('open-auth'))

export function CommentSection({ postSlug }: { postSlug: string }) {
  const t = useT()
  const [comments, setComments] = useState<CommentItem[]>([])
  const [user, setUser] = useState<AuthUser | null>(null)
  // 服务端身份（读取 sg_auth cookie），决定编辑/删除权限按钮
  const [me, setMe] = useState<Me>({ email: null, isAdmin: false })
  // 身份标签定义（评论昵称右侧外显装饰；所有视角可见）
  const [tags, setTags] = useState<UserTag[]>([])
  const [body, setBody] = useState('')
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [preview, setPreview] = useState(false)
  const [notice, setNotice] = useState('')
  const [sending, setSending] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // 排序：默认发布日期 旧 → 新
  const [sortKey, setSortKey] = useState<'createdAt' | 'editedAt'>('createdAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // 评论搜索：文本 / 正则双模式 + 匹配范围（内容 / 用户名 / 邮箱）
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'text' | 'regex'>('text')
  const [scopes, setScopes] = useState({ content: true, name: true, email: true })
  // 邮箱匹配在服务端完成（邮箱不下发到前台）：保存命中的评论 id 集合
  const [emailMatchIds, setEmailMatchIds] = useState<Set<number>>(new Set())

  // 折叠与日期切换状态按评论 id 记忆，列表刷新后不丢失
  const [collapsedMap, setCollapsedMap] = useState<Record<number, boolean>>({})
  const [dateModeMap, setDateModeMap] = useState<Record<number, 'created' | 'edited'>>({})

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/comments?post=${encodeURIComponent(postSlug)}`)
      const data = await response.json()
      setComments(data.comments || [])
      setLoaded(true)
    } catch { setLoaded(true); setNotice(t('comments.err.load')) }
  }, [postSlug, t])

  useEffect(() => {
    setLoaded(false)
    setCollapsedMap({})
    setDateModeMap({})
    void load()
    getUser().then(setUser).catch(() => setUser(null))
    const probe = async () => {
      try {
        const res = await fetch('/api/comments?action=adminStatus', { credentials: 'same-origin' })
        const data = await res.json()
        setMe({ email: data?.status?.email ?? null, isAdmin: !!data?.status?.isAdmin })
      } catch { setMe({ email: null, isAdmin: false }) }
    }
    void probe()
    listUserTagsFn().then(setTags).catch(() => setTags([]))
    return onAuthChange((nextUser) => {
      setUser(nextUser ?? null)
      void probe()
    })
  }, [load, postSlug])

  useMermaidLazy(sectionRef, [comments])

  const flash = (msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice((n) => (n === msg ? '' : n)), 3000)
  }

  const reload = async (msg?: string) => {
    await load()
    if (msg) flash(msg)
  }

  const submit = async () => {
    if (!me.email) { openAuth(); return }
    if (body.trim().length < 2) return
    setSending(true); setNotice(t('comments.submitting'))
    try {
      const response = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postSlug, body }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || t('comments.err.submit'))
      setBody(''); setPreview(false)
      await reload(t('comments.published'))
    } catch (error) { setNotice(error instanceof Error ? error.message : t('comments.err.submit')) }
    finally { setSending(false) }
  }

  const handleReply = async (parentId: number, text: string) => {
    const response = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postSlug, body: text, parentId }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || t('comments.err.reply'))
    await reload(t('comments.reply.published'))
  }

  const handleEdited = async (id: number, text: string) => {
    const response = await fetch('/api/comments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, body: text }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || t('comments.err.edit'))
    await reload(t('comments.updated'))
  }

  const handleDeleted = async (id: number, cascade: boolean) => {
    const response = await fetch(`/api/comments?id=${id}${cascade ? '&cascade=1' : ''}`, { method: 'DELETE' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || t('comments.err.delete'))
    await reload(cascade ? t('comments.deleted.cascade') : t('comments.deleted.keep'))
  }

  // ---------- 评论树 + 搜索过滤 + 排序 ----------

  const topLevel = useMemo(() => comments.filter((c) => c.parentId == null), [comments])

  const repliesOf = useMemo(() => {
    const map = new Map<number, CommentItem[]>()
    for (const c of comments) {
      if (c.parentId == null) continue
      const list = map.get(c.parentId) || []
      list.push(c)
      map.set(c.parentId, list)
    }
    return map
  }, [comments])

  const regexError = useMemo(() => {
    const q = query.trim()
    if (!q || searchMode !== 'regex') return false
    try { new RegExp(q, 'i'); return false } catch { return true }
  }, [query, searchMode])

  const matcher = useMemo(() => {
    const q = query.trim()
    if (!q || regexError) return null
    return new RegExp(searchMode === 'regex' ? q : escapeRegExp(q), 'i')
  }, [query, searchMode, regexError])

  const matches = useCallback((c: CommentItem) => {
    if (!matcher) return true
    if (scopes.content && matcher.test(c.body)) return true
    if (scopes.name && matcher.test(c.userName)) return true
    // 邮箱匹配由服务端完成（邮箱不下发到前台）
    if (scopes.email && emailMatchIds.has(c.id)) return true
    return false
  }, [matcher, scopes, emailMatchIds])

  // 邮箱范围搜索：防抖 250ms 请求服务端匹配，回传命中的评论 id
  useEffect(() => {
    const q = query.trim()
    if (!scopes.email || !q || regexError) {
      setEmailMatchIds((prev) => (prev.size ? new Set() : prev))
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ post: postSlug, emailQ: q, emailMode: searchMode })
      fetch(`/api/comments?${params.toString()}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : { emailMatchIds: [] }))
        .then((data) => setEmailMatchIds(new Set(Array.isArray(data.emailMatchIds) ? data.emailMatchIds : [])))
        .catch(() => { /* 已取消或网络抖动：保留上一次结果 */ })
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, searchMode, scopes.email, regexError, postSlug])

  const hitCount = useMemo(() => (matcher ? comments.filter(matches).length : 0), [comments, matches, matcher])

  const keyTime = useCallback(
    (c: CommentItem) => new Date(sortKey === 'editedAt' ? (c.editedAt ?? c.createdAt) : c.createdAt).getTime(),
    [sortKey],
  )

  const visibleTop = useMemo(() => {
    const list = matcher ? topLevel.filter((c) => matches(c) || (repliesOf.get(c.id) || []).some(matches)) : topLevel
    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => (keyTime(a) - keyTime(b)) * dir || a.id - b.id)
  }, [topLevel, matcher, matches, repliesOf, sortDir, keyTime])

  const visibleReplies = useCallback(
    (parent: CommentItem) => {
      const all = repliesOf.get(parent.id) || []
      const list = matcher && !matches(parent) ? all.filter(matches) : all
      // 回复与顶层评论使用同一套排序控件（默认发布日期 旧 → 新）
      const dir = sortDir === 'asc' ? 1 : -1
      return [...list].sort((a, b) => (keyTime(a) - keyTime(b)) * dir || a.id - b.id)
    },
    [repliesOf, matcher, matches, sortDir, keyTime],
  )

  const isCollapsed = useCallback(
    (c: CommentItem) => collapsedMap[c.id] ?? c.body.length > LONG_BODY,
    [collapsedMap],
  )
  const toggleCollapse = useCallback(
    (c: CommentItem) => setCollapsedMap((m) => ({ ...m, [c.id]: !(m[c.id] ?? c.body.length > LONG_BODY) })),
    [],
  )
  const getDateMode = useCallback(
    (c: CommentItem): 'created' | 'edited' => dateModeMap[c.id] ?? 'edited',
    [dateModeMap],
  )
  const toggleDate = useCallback(
    (c: CommentItem) => setDateModeMap((m) => ({ ...m, [c.id]: (m[c.id] ?? 'edited') === 'edited' ? 'created' : 'edited' })),
    [],
  )

  const publishedCount = comments.filter((c) => c.status === 'published').length

  return (
    <section ref={sectionRef} className="comments-section">
      <div className="comments-heading"><div><MessageSquareText size={19} /><h2>{t('comments.heading')}</h2><span>{publishedCount}</span></div><p><ShieldCheck size={14} /> {t('comments.verified.only')}</p></div>

      {comments.length > 0 && (
        <div className="comment-toolbar">
          <div className="comment-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('comments.search.ph.full')}
              aria-label={t('comments.search.aria')}
            />
            <button type="button" className={`search-mode ${searchMode === 'text' ? 'on' : ''}`} onClick={() => setSearchMode('text')}>{t('search.mode.text')}</button>
            <button type="button" className={`search-mode ${searchMode === 'regex' ? 'on' : ''}`} onClick={() => setSearchMode('regex')}>{t('search.mode.regex')}</button>
            {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('search.clear')} title={t('search.clear')}><X size={13} /></button>}
          </div>
          {regexError && <div className="banner error small">{t('search.regex.invalid')}</div>}
          <div className="comment-toolbar-row">
            <div className="comment-sort">
              <span>{t('comments.sort')}</span>
              <button type="button" className="chip-toggle on" onClick={() => setSortKey((k) => (k === 'createdAt' ? 'editedAt' : 'createdAt'))}>
                {sortKey === 'createdAt' ? t('comments.sort.created') : t('comments.sort.edited')}
              </button>
              <button type="button" className="chip-toggle on" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>
                {sortDir === 'asc' ? t('comments.sort.asc') : t('comments.sort.desc')}
              </button>
            </div>
            <div className="comment-sort">
              <span>{t('comments.match')}</span>
              {(['content', 'name', 'email'] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  className={`chip-toggle ${scopes[scope] ? 'on' : ''}`}
                  onClick={() => setScopes((s) => ({ ...s, [scope]: !s[scope] }))}
                >
                  {scope === 'content' ? t('comments.scope.content') : scope === 'name' ? t('comments.scope.name') : t('comments.scope.email')}
                </button>
              ))}
            </div>
            {query && !regexError && <span className="comment-hit-count">{t('comments.hits', { n: hitCount })}</span>}
          </div>
        </div>
      )}

      <div className="comment-list">
        {visibleTop.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            replies={visibleReplies(comment)}
            me={me}
            tags={tags}
            isCollapsed={isCollapsed}
            toggleCollapse={toggleCollapse}
            getDateMode={getDateMode}
            toggleDate={toggleDate}
            onReply={handleReply}
            onEdited={handleEdited}
            onDeleted={handleDeleted}
          />
        ))}
        {notice && <div className="comment-status">{notice}</div>}
        {loaded && visibleTop.length === 0 && (
          <div className="comment-status">{comments.length ? t('comments.no.match') : t('comments.empty')}</div>
        )}
        {!loaded && <div className="comment-status">{t('comments.loading')}</div>}
      </div>

      <div className="comment-editor">
        <div className="comment-editor-head"><span>{me.email || user ? `${me.email || user?.email} · ${t('comments.verified.suffix')}` : t('comments.guest.verification')}</span><div className="comment-editor-tools"><StickerTrigger onInsert={(code) => insertAtCursor(bodyRef.current, code, setBody)} /><button onClick={() => setPreview(!preview)}><Eye size={14} />{preview ? t('comments.edit.tab') : t('comments.preview')}</button></div></div>
        {preview ? <div className="comment-preview markdown-body compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(body || `*${t('comments.preview.body')}*`) }} /> : <textarea ref={bodyRef} value={body} onChange={(event) => setBody(event.target.value)} placeholder={t('comments.editor.ph')} rows={6} />}
        <div className="comment-pickup-tip"><Package size={12} /><span>{t('comments.pickup.tip')}</span></div>
        <div className="comment-editor-foot"><span>{t('comments.foot')}</span><button onClick={submit} disabled={sending || body.trim().length < 2}>{me.email || user ? <><Send size={14} />{sending ? t('comments.publishing') : t('comments.publish')}</> : t('comments.verify')}</button></div>
      </div>
    </section>
  )
}

// =================================================================
// 单条评论卡片（顶层与回复复用）：回复 / 编辑 / 删除（管理员级联）、
// 长评折叠、发表/编辑日期点击切换
// =================================================================

type CommentCardProps = {
  comment: CommentItem
  replies: CommentItem[]
  me: Me
  tags: UserTag[]
  isCollapsed: (c: CommentItem) => boolean
  toggleCollapse: (c: CommentItem) => void
  getDateMode: (c: CommentItem) => 'created' | 'edited'
  toggleDate: (c: CommentItem) => void
  onReply: (parentId: number, text: string) => Promise<void>
  onEdited: (id: number, text: string) => Promise<void>
  onDeleted: (id: number, cascade: boolean) => Promise<void>
}

function CommentCard({ comment: c, replies, me, tags, isCollapsed, toggleCollapse, getDateMode, toggleDate, onReply, onEdited, onDeleted }: CommentCardProps) {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  const isDeleted = c.status !== 'published'
  // 本人判定由服务端以 mine 布尔下发（不再比较邮箱明文）
  const canModerate = !isDeleted && !!me.email && (me.isAdmin || c.mine)
  const long = !isDeleted && c.body.length > LONG_BODY
  const collapsed = long && isCollapsed(c)
  // 被编辑过的评论默认显示最后编辑日期，点击可在 发表/编辑 之间切换
  const dateMode = getDateMode(c)

  const [replyOpen, setReplyOpen] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const [replyBusy, setReplyBusy] = useState(false)
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const [actionError, setActionError] = useState('')
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const editRef = useRef<HTMLTextAreaElement>(null)

  const submitReply = async () => {
    if (!me.email) { openAuth(); return }
    if (replyBody.trim().length < 2) return
    setReplyBusy(true); setActionError('')
    try {
      // 回复只有一层：对回复卡片点“回复”时，仍归属到其顶层评论
      await onReply(c.parentId ?? c.id, replyBody)
      setReplyBody(''); setReplyOpen(false)
    } catch (error) { setActionError(error instanceof Error ? error.message : t('comments.err.reply')) }
    finally { setReplyBusy(false) }
  }

  const saveEdit = async () => {
    if (editBody.trim().length < 2) return
    setEditBusy(true)
    try {
      await onEdited(c.id, editBody)
      setEditing(false)
    } catch (error) { setActionError(error instanceof Error ? error.message : t('comments.err.edit')) }
    finally { setEditBusy(false) }
  }

  const remove = async (cascade: boolean) => {
    try { await onDeleted(c.id, cascade) } catch (error) { setActionError(error instanceof Error ? error.message : t('comments.err.delete')) }
  }

  const askDelete = () => {
    if (me.isAdmin && replies.length > 0) {
      const cascade = window.confirm(t('comments.del.confirm.cascade'))
      if (cascade) { void remove(true); return }
      if (window.confirm(t('comments.del.confirm.only'))) void remove(false)
      return
    }
    if (window.confirm(replies.length > 0 ? t('comments.del.confirm.keep') : t('comments.del.confirm.simple'))) void remove(false)
  }

  return (
    <article className={`comment ${isDeleted ? 'deleted' : ''}`}>
      <div className="comment-avatar">{isDeleted ? <Trash2 size={13} /> : c.userName.slice(0, 2).toUpperCase()}</div>
      <div className="comment-body">
        <header>
          <strong>{isDeleted ? t('comments.deleted.name') : c.userName}</strong>
          {!isDeleted && c.tags.length > 0 && <UserTagList tagIds={c.tags} tags={tags} />}
          {!isDeleted && <CheckCircle2 size={13} />}
          {!isDeleted && c.editedAt && <span className="edited-chip">{t('comments.edited')}</span>}
          {!isDeleted && (dateMode === 'edited' && c.editedAt ? (
            <button className="comment-date-btn editable" title={t('comments.date.to.created')} onClick={() => toggleDate(c)}>{t('comments.date.edited.at')} {fmtDate(c.editedAt, dateLocale)}</button>
          ) : c.editedAt ? (
            <button className="comment-date-btn editable" title={t('comments.date.to.edited')} onClick={() => toggleDate(c)}>{t('comments.date.published.at')} {fmtDate(c.createdAt, dateLocale)}</button>
          ) : (
            <time className="comment-date-btn">{t('comments.date.published.at')} {fmtDate(c.createdAt, dateLocale)}</time>
          ))}
        </header>

        {!isDeleted && c.signature.trim() && (
          <div
            className="comment-signature markdown-body compact"
            title={c.signature}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(c.signature) }}
          />
        )}

        {isDeleted ? (
          <div className="comment-deleted">{t('comments.deleted.placeholder')}</div>
        ) : (
          <>
            <div className={collapsed ? 'comment-collapse collapsed' : 'comment-collapse'}>
              <div className="markdown-body compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
            </div>
            {long && <button className="comment-expand" onClick={() => toggleCollapse(c)}>{collapsed ? t('comments.expand.full') : t('comments.collapse')}</button>}
            {editing ? (
              <div className="comment-inline-editor">
                <textarea ref={editRef} value={editBody} onChange={(event) => setEditBody(event.target.value)} rows={5} autoFocus />
                <div className="comment-inline-editor-foot">
                  <StickerTrigger onInsert={(code) => insertAtCursor(editRef.current, code, setEditBody)} />
                  <button type="button" className="ghost" onClick={() => { setEditing(false); setEditBody('') }}>{t('common.cancel')}</button>
                  <button type="button" className="primary" disabled={editBusy || editBody.trim().length < 2} onClick={() => void saveEdit()}>{editBusy ? t('comments.saving') : t('comments.save.edit')}</button>
                </div>
              </div>
            ) : (
              <div className="comment-actions">
                <button type="button" onClick={() => (me.email ? setReplyOpen((v) => !v) : openAuth())}><MessageSquareText size={11} />{t('comments.reply')}</button>
                {canModerate && <button type="button" onClick={() => { setEditBody(c.body); setEditing(true); setReplyOpen(false) }}><Pencil size={11} />{t('comments.edit')}</button>}
                {canModerate && <button type="button" className="danger" onClick={askDelete}><Trash2 size={11} />{t('comments.delete')}</button>}
                {me.isAdmin && !c.mine && c.userKey && (
                  <a className="comment-admin-link" href={`/admin/users?focus=${encodeURIComponent(c.userKey)}`} title={t('comments.manage.title')}>
                    <ShieldCheck size={11} />{t('comments.manage')}
                  </a>
                )}
              </div>
            )}
            {actionError && <div className="comment-inline-error">{actionError}</div>}
            {replyOpen && !editing && (
              <div className="comment-inline-editor">
                <div className="comment-inline-hint">{t('comments.reply.hint', { name: c.userName })}</div>
                <textarea ref={replyRef} value={replyBody} onChange={(event) => setReplyBody(event.target.value)} rows={4} placeholder={t('comments.reply.ph')} autoFocus />
                <div className="comment-inline-editor-foot">
                  <StickerTrigger onInsert={(code) => insertAtCursor(replyRef.current, code, setReplyBody)} />
                  <button type="button" className="ghost" onClick={() => { setReplyOpen(false); setReplyBody(''); setActionError('') }}>{t('common.cancel')}</button>
                  <button type="button" className="primary" disabled={replyBusy || replyBody.trim().length < 2} onClick={() => void submitReply()}><Send size={12} />{replyBusy ? t('comments.publishing.reply') : me.email ? t('comments.reply.pub') : t('comments.reply.login')}</button>
                </div>
              </div>
            )}
          </>
        )}

        {isDeleted && me.isAdmin && replies.length > 0 && (
          <div className="comment-actions">
            <button type="button" className="danger" onClick={() => { if (window.confirm(t('comments.del.all.replies.q'))) void remove(true) }}><Trash2 size={11} />{t('comments.delete.all.replies')}</button>
          </div>
        )}

        {replies.length > 0 && (
          <div className="comment-replies">
            {replies.map((reply) => (
              <CommentCard
                key={reply.id}
                comment={reply}
                replies={[]}
                me={me}
                tags={tags}
                isCollapsed={isCollapsed}
                toggleCollapse={toggleCollapse}
                getDateMode={getDateMode}
                toggleDate={toggleDate}
                onReply={onReply}
                onEdited={onEdited}
                onDeleted={onDeleted}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  )
}
