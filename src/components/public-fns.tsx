import * as React from 'react'
import { createServerFn } from '@tanstack/react-start'
import { onAuthChange } from '@/lib/auth-client'
import { z } from 'zod'
import { FileDown, Lock, LockOpen } from 'lucide-react'
import { useT } from '@/lib/i18n'

import {
  DEFAULT_SITE_DESCRIPTION,
  DEFAULT_SITE_TITLE,
  attachmentDownloadUrl,
  attachmentTokenUrl,
  formatBytes,
  type AdminSettings,
  type AdminStatus,
  type AttachmentPublic,
  type CategoryLabel,
  type PostData,
  type SiteSettings,
} from '@/lib/utils'

// =================================================================
// 公开 Server Functions（前台三条路由 + __root loader + 附件面板使用）
// 拆分到独立文件：避免因 card.tsx 同时被 lazy + static 引用导致 chunk 不拆分
// =================================================================

// 注意：createServerFn(...).handler(...) 链上不能包裹 `as unknown as` 类型断言，
// 否则 Start 编译器无法识别方法链（fast-path 要求声明初值为 CallExpression），
// 文件会被静默跳过编译，导致 SSR 下函数返回 undefined。
// 类型改用 handler 返回值注解表达。

export const adminStatusFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminStatus> => {
    const mod = await import('../../db/index.js')
    return mod.getAdminStatus()
  },
)

export const settingsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ public: SiteSettings; admin?: AdminSettings; isAdmin: boolean; adminStatus: AdminStatus | null }> => {
    const mod = await import('../../db/index.js')
    // root loader 是每个页面的关键路径。未登录访客（绝大多数）冷启动只需一次 settings 查询，
    // 不再像原来那样经 getAdminStatus 查一次 settings、再经 getPublicSettings 查一次（9+9=18s）。
    const DB_TIMEOUT = 7_000
    const fallbackPublic = { siteTitle: DEFAULT_SITE_TITLE, siteDescription: DEFAULT_SITE_DESCRIPTION, customCss: '' }
    try {
      // 第一步：当前用户（无 cookie 时零 DB，立即返回 null）
      const me = await mod.withDbTimeout(mod.getCurrentUser(), DB_TIMEOUT, '读取登录状态').catch(() => null)

      if (!me) {
        // 未登录：只查一次 public settings；未登录必非管理员，无需读 adminEmails
        const pub = await mod.withDbTimeout(mod.getPublicSettings(), DB_TIMEOUT, '读取站点设置').catch(() => fallbackPublic)
        return {
          public: pub,
          isAdmin: false as const,
          adminStatus: { authed: false, email: null, isAdmin: false, adminConfigured: false },
        }
      }

      // 已登录：走完整 adminStatus（内部合并 env + settings 的 adminEmails，有缓存）
      const status = await mod.withDbTimeout(mod.getAdminStatus(), DB_TIMEOUT, '读取管理员状态').catch(() => ({
        authed: true as const, email: me.email, isAdmin: false as const, adminConfigured: false,
      }))
      if (status.isAdmin) {
        const [pub, adm] = await Promise.all([
          mod.withDbTimeout(mod.getPublicSettings(), DB_TIMEOUT, '读取站点设置'),
          mod.withDbTimeout(mod.getAdminSettings(), DB_TIMEOUT, '读取管理设置'),
        ])
        return { public: pub, admin: adm, isAdmin: true as const, adminStatus: status }
      }
      const pub = await mod.withDbTimeout(mod.getPublicSettings(), DB_TIMEOUT, '读取站点设置').catch(() => fallbackPublic)
      return { public: pub, isAdmin: false as const, adminStatus: status }
    } catch {
      // 超时或 DB 不可用：返回默认值，页面照常渲染
      return { public: fallbackPublic, isAdmin: false as const, adminStatus: null }
    }
  },
)

export const allCategoriesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CategoryLabel[]> => {
    const mod = await import('../../db/index.js')
    const list = await mod.listCategoryInfo()
    return list
      .map((c) => ({ name: c.name, nameEn: c.nameEn, nameRu: c.nameRu }))
      .sort((a, b) => a.name.localeCompare(b.name))
  },
)

export const publishedPostsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PostData[]> => {
    const mod = await import('../../db/index.js')
    return mod.listPublishedPosts()
  },
)

export const getPublishedPostFn = createServerFn({ method: 'GET' })
  .inputValidator((input) => z.object({ slug: z.string().min(1).max(160) }).parse(input))
  .handler(async ({ data }): Promise<PostData | null> => {
    const mod = await import('../../db/index.js')
    return mod.getPublishedPost(data.slug)
  })

// 草稿预览（仅管理员）：后台仪表盘"预览"跳转 /posts/{slug} 时，
// 未发布文章不在 publishedPostsFn 结果里，由本 fn 兜底；requireAdmin 拦截非管理员
export const adminPostPreviewFn = createServerFn({ method: 'GET' })
  .inputValidator((input) => z.object({ slug: z.string().min(1).max(160) }).parse(input))
  .handler(async ({ data }): Promise<PostData | null> => {
    const mod = await import('../../db/index.js')
    await mod.requireAdmin()
    return mod.getDbPostBySlug(data.slug)
  })

export const postAttachmentsFn = createServerFn({ method: 'GET' })
  .inputValidator((input) => z.object({ postSlug: z.string().min(1).max(160) }).parse(input))
  .handler(async ({ data }): Promise<AttachmentPublic[]> => {
    const mod = await import('../../db/index.js')
    // 附件登录门禁：未登录访客不可读取附件列表（服务端强制）
    const user = await mod.getCurrentUser()
    if (!user) throw new Error('请先登录后查看附件。')
    return mod.listAttachmentsPublic(data.postSlug)
  })

// 站点内容块（网站简介 / 友情链接；公开，用户中心展示）
export const siteContentFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ key: string; lang: string; body: string; updatedAt: string | null }[]> => {
    const mod = await import('../../db/index.js')
    return mod.listSiteContent()
  },
)

export const publicServerFns = {
  settingsFn,
  allCategoriesFn,
  publishedPostsFn,
  getPublishedPostFn,
  adminPostPreviewFn,
  postAttachmentsFn,
  adminStatusFn,
  siteContentFn,
}

// 保留 DEFAULT_SITE_* 以让调用方仍然从这里 import（未使用时不影响）
export { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE }

// =================================================================
// 前台：文章页附件面板（访客可见，密码锁 UI）
// =================================================================
export function AttachmentPanel({ postSlug }: { postSlug: string }) {
  const t = useT()
  const [items, setItems] = React.useState<AttachmentPublic[] | null>(null)
  const [error, setError] = React.useState('')
  const [tokens, setTokens] = React.useState<Record<number, string>>({})
  const [passwordInputs, setPasswordInputs] = React.useState<Record<number, string>>({})
  const [busy, setBusy] = React.useState<number | null>(null)
  // 附件登录门禁：guest 时仅展示引导登录面板，不拉取附件列表
  const [auth, setAuth] = React.useState<'checking' | 'authed' | 'guest'>('checking')

  React.useEffect(() => {
    let alive = true
    const probe = async () => {
      try {
        const res = await fetch('/api/comments?action=adminStatus', { credentials: 'same-origin' })
        const data = await res.json()
        if (alive) setAuth(data?.status?.authed ? 'authed' : 'guest')
      } catch { if (alive) setAuth('guest') }
    }
    void probe()
    const unsubscribe = onAuthChange(() => { void probe() })
    return () => { alive = false; unsubscribe() }
  }, [])

  const load = React.useCallback(async () => {
    setError('')
    try { setItems(await postAttachmentsFn({ data: { postSlug } })) }
    catch (e) { setError(e instanceof Error ? e.message : t('attach.err.list')) }
  }, [postSlug, t])
  React.useEffect(() => { if (auth === 'authed') void load() }, [auth, load])

  const tryUnlock = async (att: AttachmentPublic) => {
    const pwd = passwordInputs[att.id] || ''
    if (!pwd) { alert(t('attach.err.pwd.empty')); return }
    setBusy(att.id)
    try {
      const response = await fetch(`${attachmentTokenUrl(att.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || t('attach.err.pwd.wrong'))
      setTokens((m) => ({ ...m, [att.id]: data.token as string }))
    } catch (e) { alert(e instanceof Error ? e.message : t('attach.err.check')) }
    finally { setBusy(null) }
  }

  // 未登录：附件完全隐藏，引导登录
  if (auth === 'guest') {
    return (
      <section className="attachment-panel comments-section">
        <div className="comments-heading">
          <div><FileDown size={18} /><h2>{t('attach.title')}</h2></div>
          <p>{t('attach.login.p')}</p>
        </div>
        <div className="attach-gate">
          <Lock size={18} />
          <span>{t('attach.login.span')}</span>
          <button onClick={() => window.dispatchEvent(new Event('open-auth'))}>{t('attach.login.btn')}</button>
        </div>
      </section>
    )
  }

  if (items && items.length === 0 && !error) return null
  return (
    <section className="attachment-panel comments-section">
      <div className="comments-heading">
        <div><FileDown size={18} /><h2>{t('attach.title')}</h2><span>{items?.length ?? 0}</span></div>
        <p>{t('attach.info')}</p>
      </div>
      {error && <div className="banner error small">{error} <button onClick={() => void load()}>{t('attach.retry')}</button></div>}
      {items === null ? <div className="skeleton-list" /> : (
        <ul className="attach-list public">
          {items.map((att) => (
            <li key={att.id} className="attach-row">
              <div className="attach-main">
                <div className="attach-icon">{att.locked ? <Lock size={18} /> : <FileDown size={18} />}</div>
                <div className="attach-meta">
                  <strong>{att.filename}</strong>
                  <div className="attach-sub">
                    <span>{formatBytes(att.sizeBytes)}</span>
                    <span>{t('attach.downloads.pre')} <b>{att.downloads}</b> {t('attach.downloads.post')}</span>
                    <span className={att.locked ? 'chip lock' : 'chip unlock'}>
                      {att.locked ? <><Lock size={10} />{t('attach.locked')}</> : <><LockOpen size={10} />{t('attach.public')}</>}
                    </span>
                  </div>
                </div>
              </div>
              <div className="attach-actions">
                {att.locked ? (
                  tokens[att.id] ? (
                    <>
                      <span className="chip unlock"><LockOpen size={10} />{t('attach.unlocked')}</span>
                      <a className="row-action primary" href={attachmentDownloadUrl(att.id, tokens[att.id])} target="_blank" rel="noreferrer"><FileDown size={13} />{t('attach.download')}</a>
                    </>
                  ) : (
                    <>
                      <input
                        type="password"
                        placeholder={t('attach.pwd.ph')}
                        value={passwordInputs[att.id] ?? ''}
                        onChange={(e) => setPasswordInputs((m) => ({ ...m, [att.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') void tryUnlock(att) }}
                      />
                      <button className="row-action primary" disabled={busy === att.id} onClick={() => void tryUnlock(att)}>
                        {busy === att.id ? t('attach.checking') : t('attach.unlock.download')}
                      </button>
                    </>
                  )
                ) : (
                  <a className="row-action primary" href={attachmentDownloadUrl(att.id)} target="_blank" rel="noreferrer"><FileDown size={13} />{t('attach.download')}</a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
