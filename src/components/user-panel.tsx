import {
  changePassword,
  deleteAccount,
  getUser,
  onAuthChange,
  updateDisplayName,
  type AuthUser,
} from '@/lib/auth-client'
import {
  AlertTriangle,
  FileUp,
  Info,
  KeyRound,
  MessageSquareText,
  MessageSquareWarning,
  PenLine,
  Send,
  Type,
  UserRound,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { renderMarkdown } from '@/lib/markdown'
import { feedbackUploadUrl, formatBytes } from '@/lib/utils'
import { useT, useLang } from '@/lib/i18n'
import { UserTagList } from '@/components/user-tag-badge'
import type { UserTag } from '../../db/index.js'
import { Link } from '@tanstack/react-router'
import {
  clearFontPref,
  getFontPref,
  preloadAllFonts,
  setFontPref,
  ALL_FONT_IDS,
  FONT_GROUPS,
  FONT_STACKS,
  type FontId,
  type FontGroupLang,
} from '@/lib/font-prefs'
import { siteContentFn } from './public-fns'
import {
  discardAttachmentFn,
  listUserTagsFn,
  markWarningsReadFn,
  myCommentsFn,
  myProfileFn,
  myWarningsFn,
  saveFontPrefFn,
  saveSignatureFn,
  submitFeedbackFn,
} from './user-fns'

type Profile = Awaited<ReturnType<typeof myProfileFn>>
type Warning = Awaited<ReturnType<typeof myWarningsFn>>[number]
type PendingAttachment = { id: number; filename: string; sizeBytes: number }

// font / about 两个 tab 无需登录，其余为登录用户专属
type Tab = 'font' | 'about' | 'profile' | 'comments' | 'warnings' | 'feedback' | 'danger'
const AUTH_TABS: Tab[] = ['profile', 'comments', 'warnings', 'feedback', 'danger']

const MAX_SIGNATURE = 500

const openAuthModal = () => window.dispatchEvent(new Event('open-auth'))

/** 未读警告数变化时通知外壳（齿轮红点） */
function broadcastUnread(count: number) {
  window.dispatchEvent(new CustomEvent('user-warnings', { detail: count }))
}

export function UserPanel() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  // 服务端身份（读取 sg_auth httpOnly cookie）
  const [serverAuthed, setServerAuthed] = useState(false)
  const [tab, setTab] = useState<Tab>('profile')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [warnings, setWarnings] = useState<Warning[]>([])
  const [tagDefs, setTagDefs] = useState<UserTag[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')

  const probeServer = useCallback(async () => {
    try {
      const res = await fetch('/api/comments?action=adminStatus', { credentials: 'same-origin' })
      const data = await res.json()
      setServerAuthed(!!data?.status?.authed)
    } catch { setServerAuthed(false) }
  }, [])

  const refreshProfile = useCallback(async () => {
    try {
      const [p, tags] = await Promise.all([myProfileFn(), listUserTagsFn().catch(() => [] as UserTag[])])
      setProfile(p)
      setTagDefs(tags)
      setServerAuthed(true)
      broadcastUnread(p.unreadWarnings)
      return p
    } catch {
      // 未登录时服务端 fn 拒绝属正常情况，不计为错误（界面走访客引导）
      setProfile(null)
      return null
    }
  }, [])

  useEffect(() => {
    getUser().then(setUser).catch(() => setUser(null))
    const unsub = onAuthChange((next) => { setUser(next ?? null); void probeServer() })
    const show = () => { setOpen(true); void probeServer(); void loadPanelData() }
    window.addEventListener('open-user-panel', show)
    void probeServer()
    return () => { unsub(); window.removeEventListener('open-user-panel', show) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeServer])

  // 打开面板即尝试拉资料：服务端 fn 自身有鉴权，成功即说明已登录（本地 mock
  // 浏览器无 Identity 会话也能工作）；未读警告在查看后标记已读。
  const loadPanelData = useCallback(async () => {
    setLoading(true); setLoadError('')
    const p = await refreshProfile()
    if (p) {
      try {
        const list = await myWarningsFn()
        setWarnings(list)
        if (p.unreadWarnings > 0) {
          await markWarningsReadFn()
          broadcastUnread(0)
          setWarnings((ws) => ws.map((w) => (w.readAt ? w : { ...w, readAt: new Date().toISOString() })))
        }
      } catch { /* 警告加载失败不阻塞面板 */ }
    }
    setLoading(false)
  }, [refreshProfile])

  const loggedIn = !!user || serverAuthed || !!profile

  // 注销/登出后清空面板数据；当前 tab 若是登录专属则回到“关于本站”
  useEffect(() => {
    if (!loggedIn) {
      setProfile(null); setWarnings([])
      if (AUTH_TABS.includes(tab)) setTab('about')
    }
  }, [loggedIn, tab])

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <section className="auth-modal user-modal" role="dialog" aria-modal="true" aria-label={t('user.center')}>
        <button className="modal-close" onClick={() => setOpen(false)} aria-label={t('common.close')} title={t('user.close.title')}><X size={18} /></button>
        <div className="auth-modal-body">
        <div className="terminal-label">user.settings()</div>
        <h2>{t('user.center')}</h2>

        <nav className="user-tabs" aria-label={t('user.center')}>
          <button type="button" className={tab === 'font' ? 'on' : ''} onClick={() => setTab('font')}><Type size={13} />{t('user.tab.font')}</button>
          <button type="button" className={tab === 'about' ? 'on' : ''} onClick={() => setTab('about')}><Info size={13} />{t('user.tab.about')}</button>
          {loggedIn && (
            <>
              <button type="button" className={tab === 'profile' ? 'on' : ''} onClick={() => setTab('profile')}><PenLine size={13} />{t('user.tab.profile')}</button>
              <button type="button" className={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}><MessageSquareText size={13} />{t('user.tab.comments')}</button>
              <button type="button" className={tab === 'warnings' ? 'on' : ''} onClick={() => setTab('warnings')}>
                <MessageSquareWarning size={13} />{t('user.tab.warnings')}
                {profile && profile.unreadWarnings > 0 && <span className="user-tab-badge">{profile.unreadWarnings}</span>}
              </button>
              <button type="button" className={tab === 'feedback' ? 'on' : ''} onClick={() => setTab('feedback')}><Send size={13} />{t('user.tab.feedback')}</button>
              <button type="button" className={`danger-tab ${tab === 'danger' ? 'on' : ''}`} onClick={() => setTab('danger')}><AlertTriangle size={13} />{t('user.tab.danger')}</button>
            </>
          )}
        </nav>

        {loadError && <div className="banner error small">{loadError}</div>}

        {/* 无需登录的两个 tab */}
        {tab === 'font' && <FontTab loggedIn={loggedIn} serverFontPref={profile?.fontPref || ''} />}
        {tab === 'about' && <AboutTab />}

        {loggedIn ? (
          loading && !profile ? <div className="skeleton-list" /> : (
            <>
              {tab === 'profile' && profile && (
                <ProfileTab profile={profile} tagDefs={tagDefs} onSaved={refreshProfile} />
              )}
              {tab === 'comments' && <MyCommentsTab />}
              {tab === 'warnings' && <WarningsTab warnings={warnings} />}
              {tab === 'feedback' && <FeedbackTab onDone={refreshProfile} />}
              {tab === 'danger' && profile && <DangerTab onClosed={() => setOpen(false)} />}
            </>
          )
        ) : (
          AUTH_TABS.includes(tab) && (
            <div className="user-guest">
              <UserRound size={34} />
              <p>{t('user.guest.hint')}</p>
              <button className="primary-button" onClick={() => { setOpen(false); openAuthModal() }}>{t('user.go.login')}</button>
              <button type="button" className="text-button" onClick={() => void probeServer()}>{t('user.recheck')}</button>
            </div>
          )
        )}
        </div>
      </section>
    </div>
  )
}

// ----------------------------------------------------------------
// 字体：中/英/俄分组（一般 / 艺术），即时预览，可取消回默认
// ----------------------------------------------------------------
const FONT_PANGRAMS: Record<FontGroupLang, string> = {
  zh: '永和九年，岁在癸丑。暮春之初，会于会稽山阴之兰亭。',
  en: 'The quick brown fox jumps over the lazy dog. 0123456789',
  ru: 'Съешь же ещё этих мягких французских булок, да выпей чаю. 0123456789',
}

function FontTab({ loggedIn, serverFontPref }: { loggedIn: boolean; serverFontPref: string }) {
  const t = useT()
  const [current, setCurrent] = useState<FontId | ''>(() => getFontPref())
  const [busy, setBusy] = useState<FontId | '' | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 打开选择器后后台预载全部字体 CSS：卡片预览随后自动换成真实字体
  useEffect(() => { void preloadAllFonts() }, [])

  // 跨设备同步：本机从未设置过字体（localStorage 无键）时，登录后采用账户
  // 中保存的偏好，仅同步一次；本机已显式选择或取消过则完全尊重本机选择。
  const syncedRef = useRef(false)
  useEffect(() => {
    if (syncedRef.current || !loggedIn || !serverFontPref) return
    if (typeof localStorage === 'undefined' || localStorage.getItem('sg-font-pref') !== null) return
    if (!(ALL_FONT_IDS as string[]).includes(serverFontPref)) return
    syncedRef.current = true
    const id = serverFontPref as FontId
    void setFontPref(id)
      .then(() => setCurrent(id))
      .catch(() => { syncedRef.current = false })
  }, [loggedIn, serverFontPref])

  const pick = async (id: FontId) => {
    if (busy !== null) return
    setBusy(id); setMsg(null)
    try {
      await setFontPref(id) // 立即挂 data-font + localStorage + 下载该字体 CSS
      if (loggedIn) await saveFontPrefFn({ data: { fontPref: id } })
      setCurrent(id)
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('user.font.fail') })
    } finally { setBusy(null) }
  }

  const reset = async () => {
    if (busy !== null) return
    setBusy(''); setMsg(null)
    try {
      clearFontPref()
      if (loggedIn) await saveFontPrefFn({ data: { fontPref: '' } })
      setCurrent('')
      setMsg({ kind: 'ok', text: t('user.font.reset.done') })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('user.font.fail') })
    } finally { setBusy(null) }
  }

  const groupLangs: FontGroupLang[] = ['zh', 'en', 'ru']
  return (
    <div className="user-tab-body font-picker">
      <p className="user-note">{t('user.font.note')}</p>
      {groupLangs.map((lg) => (
        <section className="font-lang-group" key={lg}>
          <h3>{t(`user.font.lang.${lg}`)}</h3>
          {(['normal', 'art'] as const).map((kind) => (
            <div className="font-kind-row" key={kind}>
              <span className="font-kind-label">{t(`user.font.kind.${kind}`)}</span>
              <div className="font-options">
                {FONT_GROUPS[lg][kind].map((id) => (
                  <button
                    type="button"
                    key={id}
                    className={`font-option ${current === id ? 'on' : ''}`}
                    disabled={busy !== null}
                    onClick={() => void pick(id)}
                  >
                    <span className="font-option-name">{t(`font.opt.${id}`)}</span>
                    <span className="font-option-sample" style={{ fontFamily: FONT_STACKS[id] }}>
                      {busy === id ? t('common.loading') : FONT_PANGRAMS[lg]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
      <button type="button" className="ghost-button font-reset" disabled={busy !== null || current === ''} onClick={() => void reset()}>
        {busy === '' ? t('common.loading') : t('user.font.reset')}
      </button>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'} small`}>{msg.text}</div>}
    </div>
  )
}

// ----------------------------------------------------------------
// 关于本站：网站简介 + 友情链接（Markdown 渲染；按当前语言，缺省依次回退 en/zh）
// ----------------------------------------------------------------
function markExternalLinks(el: HTMLDivElement | null) {
  if (!el) return
  el.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })
}

function AboutTab() {
  const t = useT()
  const lang = useLang()
  const [rows, setRows] = useState<Awaited<ReturnType<typeof siteContentFn>> | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    siteContentFn()
      .then((r) => { if (alive) setRows(r) })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t('user.about.fail')) })
    return () => { alive = false }
  }, [t])

  const pickBody = (key: string): string => {
    if (!rows) return ''
    for (const l of [lang, 'en', 'zh'] as const) {
      const b = rows.find((r) => r.key === key && r.lang === l)?.body
      if (b && b.trim()) return b
    }
    return ''
  }

  const about = pickBody('about')
  const links = pickBody('links')

  return (
    <div className="user-tab-body about-tab">
      {rows === null ? (
        err ? <div className="banner error small">{err}</div> : <p className="user-empty">{t('common.loading')}</p>
      ) : !about && !links ? (
        <p className="user-empty">{t('user.about.empty')}</p>
      ) : (
        <>
          {about && (
            <section className="about-block">
              <h3>{t('user.about.title')}</h3>
              <div className="markdown-body compact about-content" ref={markExternalLinks}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(about) }} />
            </section>
          )}
          {links && (
            <section className="about-block">
              <h3>{t('user.links.title')}</h3>
              <div className="markdown-body compact about-content" ref={markExternalLinks}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(links) }} />
            </section>
          )}
        </>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// 资料：昵称 / 个签 / 密码
// ----------------------------------------------------------------
function ProfileTab({ profile, tagDefs, onSaved }: {
  profile: Profile
  tagDefs: UserTag[]
  onSaved: () => Promise<Profile | null>
}) {
  const t = useT()
  const [displayName, setDisplayName] = useState(profile.displayName)
  const [signature, setSignature] = useState(profile.signature)
  const [newPassword, setNewPassword] = useState('')
  const [busyName, setBusyName] = useState(false)
  const [busySig, setBusySig] = useState(false)
  const [busyPwd, setBusyPwd] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const saveName = async () => {
    const name = displayName.trim()
    if (name.length < 1) { setMsg({ kind: 'err', text: t('user.nick.empty') }); return }
    if (name.length > 20) { setMsg({ kind: 'err', text: t('user.nick.long') }); return }
    setBusyName(true); setMsg(null)
    try {
      // /api/auth updateProfile 在服务端同步 users / profiles / 历史评论署名
      await updateDisplayName(name)
      setMsg({ kind: 'ok', text: t('user.nick.saved') })
      await onSaved()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('user.nick.fail') })
    } finally { setBusyName(false) }
  }

  const saveSignature = async () => {
    if (signature.length > MAX_SIGNATURE) { setMsg({ kind: 'err', text: t('user.sig.long', { n: MAX_SIGNATURE }) }); return }
    setBusySig(true); setMsg(null)
    try {
      await saveSignatureFn({ data: { signature } })
      setMsg({ kind: 'ok', text: t('user.sig.saved') })
      await onSaved()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('user.sig.fail') })
    } finally { setBusySig(false) }
  }

  const handleChangePassword = async () => {
    if (newPassword.length < 8) { setMsg({ kind: 'err', text: t('user.pwd.short') }); return }
    setBusyPwd(true); setMsg(null)
    try {
      await changePassword(newPassword)
      setNewPassword('')
      setMsg({ kind: 'ok', text: t('user.pwd.saved') })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('user.pwd.fail') })
    } finally { setBusyPwd(false) }
  }

  return (
    <div className="user-tab-body">
      <div className="user-identity-line">
        <span className="verified-pulse" />
        <div><strong>{profile.email}</strong></div>
      </div>

      {profile.tags.length > 0 && (
        <div className="user-tags-line">
          <span className="user-tags-label">{t('user.tags')}</span>
          <UserTagList tagIds={profile.tags} tags={tagDefs} />
        </div>
      )}

      <label className="user-field">
        {t('user.nickname')}
        <input value={displayName} maxLength={20} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('user.nickname.ph')} />
      </label>
      <button type="button" className="primary-button small" disabled={busyName || displayName.trim() === profile.displayName} onClick={() => void saveName()}>
        {busyName ? t('user.syncing') : t('user.save.nick')}
      </button>

      <label className="user-field">
        {t('user.signature', { n: MAX_SIGNATURE })}
        <textarea rows={3} maxLength={MAX_SIGNATURE} value={signature} onChange={(e) => setSignature(e.target.value)}
          placeholder={t('user.signature.ph')} />
        <span className="user-field-counter">{signature.length}/{MAX_SIGNATURE}</span>
      </label>
      {signature.trim() && (
        <div className="user-sig-preview">
          <span>{t('user.preview')}</span>
          <div className="comment-signature markdown-body compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(signature) }} />
        </div>
      )}
      <button type="button" className="primary-button small" disabled={busySig} onClick={() => void saveSignature()}>
        {busySig ? t('user.saving') : t('user.signature.save')}
      </button>
      {profile.signatureUpdatedBy && (
        <p className="user-note warn">{t('user.sig.modified', { name: profile.signatureUpdatedBy })}</p>
      )}

      <div className="user-divider"><KeyRound size={13} /><span>{t('user.change.password')}</span></div>
      <label className="user-field">
        {t('user.new.password')}
        <input type="password" value={newPassword} minLength={8} autoComplete="new-password"
          onChange={(e) => setNewPassword(e.target.value)} placeholder={t('user.new.password.ph')} />
      </label>
      <button type="button" className="primary-button small" disabled={busyPwd || newPassword.length < 8} onClick={() => void handleChangePassword()}>
        {busyPwd ? t('user.updating') : t('user.update.password')}
      </button>

      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'} small`}>{msg.text}</div>}
    </div>
  )
}

// ----------------------------------------------------------------
// 我的评论：可搜索正文，点击进入对应文章
// ----------------------------------------------------------------
function MyCommentsTab() {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  const [keyword, setKeyword] = useState('')
  const [list, setList] = useState<Awaited<ReturnType<typeof myCommentsFn>>>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async (kw: string) => {
    setLoading(true); setErr('')
    try {
      const rows = await myCommentsFn({ data: { keyword: kw } })
      setList(rows)
    } catch (e) { setErr(e instanceof Error ? e.message : t('user.load.fail')) }
    finally { setLoading(false) }
  }, [t])

  useEffect(() => { void load(keyword) }, [keyword, load])

  return (
    <div className="user-tab-body">
      <div className="user-field">
        {t('user.search.comments')}
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t('user.search.comments.ph')} />
      </div>
      {err && <div className="banner error small">{err}</div>}
      {loading ? (
        <p className="user-empty">{t('common.loading')}</p>
      ) : list.length === 0 ? (
        <p className="user-empty">{keyword ? t('user.no.match') : t('user.no.comments')}</p>
      ) : (
        <ul className="my-comments-list">
          {list.map((c) => (
            <li key={c.id} className="my-comment-item">
              <Link to="/posts/$slug" params={{ slug: c.postSlug }} className="my-comment-post">
                {c.postTitle}
              </Link>
              <p className="my-comment-body">{c.body}</p>
              <time className="my-comment-date">{new Date(c.createdAt).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// 我的警告
// ----------------------------------------------------------------
function WarningsTab({ warnings }: { warnings: Warning[] }) {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  if (warnings.length === 0) {
    return <p className="user-empty">{t('user.warnings.empty')}</p>
  }
  return (
    <ul className="warning-list">
      {warnings.map((w) => (
        <li key={w.id} className={w.readAt ? '' : 'unread'}>
          <div className="warning-head">
            <AlertTriangle size={14} />
            <strong>{w.readAt ? t('user.warning.read') : t('user.warning.new')}</strong>
            <time>{new Date(w.createdAt).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })}</time>
          </div>
          <p>{w.message}</p>
          <small>{t('user.warning.issuer', { name: w.issuedBy })}</small>
        </li>
      ))}
    </ul>
  )
}

// ----------------------------------------------------------------
// 反馈：标题 / 正文 / 附件
// ----------------------------------------------------------------
function FeedbackTab({ onDone }: { onDone: () => Promise<Profile | null> }) {
  const t = useT()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    if (attachments.length + files.length > 6) { setMsg({ kind: 'err', text: t('user.attach.max') }); return }
    setUploading(true); setMsg(null)
    try {
      for (const file of Array.from(files)) {
        if (file.size > 4 * 1024 * 1024) { setMsg({ kind: 'err', text: t('user.attach.big', { name: file.name }) }); continue }
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch(feedbackUploadUrl(), { method: 'POST', body: fd, credentials: 'same-origin' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || t('user.attach.upload.fail', { name: file.name }))
        setAttachments((list) => [...list, { id: data.attachment.id, filename: data.attachment.filename, sizeBytes: data.attachment.sizeBytes }])
      }
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('user.attach.fail') })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const removeAttachment = async (id: number) => {
    try {
      await discardAttachmentFn({ data: { id } })
      setAttachments((list) => list.filter((a) => a.id !== id))
    } catch { /* 移除失败时保留在列表中，提交时服务端会再次校验 */ }
  }

  const submit = async () => {
    if (subject.trim().length < 1 || body.trim().length < 2) {
      setMsg({ kind: 'err', text: t('user.feedback.fill') }); return
    }
    setSending(true); setMsg(null)
    try {
      await submitFeedbackFn({ data: { subject, body, attachmentIds: attachments.map((a) => a.id) } })
      setMsg({ kind: 'ok', text: t('user.feedback.done') })
      setSubject(''); setBody(''); setAttachments([])
      await onDone()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('user.feedback.fail') })
    } finally { setSending(false) }
  }

  return (
    <div className="user-tab-body">
      <p className="user-note">{t('user.feedback.note')}</p>
      <label className="user-field">
        {t('user.feedback.title')}
        <input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} placeholder={t('user.feedback.title.ph')} />
      </label>
      <label className="user-field">
        {t('user.feedback.body')}
        <textarea rows={5} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder={t('user.feedback.body.ph')} />
      </label>
      <div className="feedback-attach-row">
        <button type="button" className="ghost-button" disabled={uploading} onClick={() => fileRef.current?.click()}>
          <FileUp size={14} />{uploading ? t('user.feedback.uploading') : t('user.feedback.add')}
        </button>
        <input ref={fileRef} type="file" hidden multiple accept="image/*,application/pdf,application/zip,text/*"
          onChange={(e) => void uploadFiles(e.target.files)} />
      </div>
      {attachments.length > 0 && (
        <ul className="feedback-attach-list">
          {attachments.map((a) => (
            <li key={a.id}>
              <span>{a.filename}</span>
              <em>{formatBytes(a.sizeBytes)}</em>
              <button type="button" onClick={() => void removeAttachment(a.id)} aria-label={t('user.attach.remove', { name: a.filename })} title={t('user.attach.remove.title', { name: a.filename })}><X size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="primary-button" disabled={sending || uploading} onClick={() => void submit()}>
        <Send size={14} />{sending ? t('user.feedback.submitting') : t('user.feedback.submit')}
      </button>
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'} small`}>{msg.text}</div>}
    </div>
  )
}

// ----------------------------------------------------------------
// 注销账户（分步确认）
// ----------------------------------------------------------------
function DangerTab({ onClosed }: { onClosed: () => void }) {
  const t = useT()
  const [step, setStep] = useState<1 | 2>(1)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const doDelete = async () => {
    if (confirmText.trim() !== 'DELETE') { setMsg({ kind: 'err', text: t('user.danger.confirm.ph') }); return }
    setBusy(true); setMsg(null)
    try {
      await deleteAccount()
      setMsg({
        kind: 'ok',
        text: t('user.danger.done'),
      })
      window.setTimeout(() => { window.location.href = '/' }, 1800)
      onClosed()
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : t('user.danger.fail') })
      setBusy(false)
    }
  }

  return (
    <div className="user-tab-body">
      <div className="danger-box">
        <AlertTriangle size={18} />
        <div>
          <strong>{t('user.danger.title')}</strong>
          <ul>
            <li>{t('user.danger.l1')}</li>
            <li>{t('user.danger.l2')}</li>
            <li>{t('user.danger.l3')}</li>
          </ul>
        </div>
      </div>
      {step === 1 ? (
        <button type="button" className="danger-button" onClick={() => setStep(2)}>{t('user.danger.continue')}</button>
      ) : (
        <>
          <label className="user-field">
            {t('user.danger.confirm').split('DELETE')[0]}<code>DELETE</code>{t('user.danger.confirm').split('DELETE')[1]}
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE" autoComplete="off" />
          </label>
          <div className="danger-actions">
            <button type="button" className="ghost-button" onClick={() => { setStep(1); setConfirmText('') }}>{t('common.cancel')}</button>
            <button type="button" className="danger-button" disabled={busy || confirmText.trim() !== 'DELETE'} onClick={() => void doDelete()}>
              {busy ? t('user.danger.doing') : t('user.danger.do')}
            </button>
          </div>
        </>
      )}
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'error'} small`}>{msg.text}</div>}
    </div>
  )
}
