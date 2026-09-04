import * as React from 'react'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { FileDown, Lock, LockOpen } from 'lucide-react'

import {
  DEFAULT_SITE_DESCRIPTION,
  DEFAULT_SITE_TITLE,
  attachmentDownloadUrl,
  attachmentTokenUrl,
  formatBytes,
  type AdminSettings,
  type AdminStatus,
  type AttachmentPublic,
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
  async (): Promise<{ public: SiteSettings; admin?: AdminSettings; isAdmin: boolean }> => {
    const mod = await import('../../db/index.js')
    const status = await mod.getAdminStatus()
    if (status.isAdmin) return { public: await mod.getPublicSettings(), admin: await mod.getAdminSettings(), isAdmin: true as const }
    return { public: await mod.getPublicSettings(), isAdmin: false as const }
  },
)

export const allCategoryNamesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<string[]> => {
    const mod = await import('../../db/index.js')
    const list = await mod.listCategoryInfo()
    return list.map((c) => c.name).sort()
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

export const postAttachmentsFn = createServerFn({ method: 'GET' })
  .inputValidator((input) => z.object({ postSlug: z.string().min(1).max(160) }).parse(input))
  .handler(async ({ data }): Promise<AttachmentPublic[]> => {
    const mod = await import('../../db/index.js')
    return mod.listAttachmentsPublic(data.postSlug)
  })

export const publicServerFns = {
  settingsFn,
  allCategoryNamesFn,
  publishedPostsFn,
  getPublishedPostFn,
  postAttachmentsFn,
  adminStatusFn,
}

// 保留 DEFAULT_SITE_* 以让调用方仍然从这里 import（未使用时不影响）
export { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE }

// =================================================================
// 前台：文章页附件面板（访客可见，密码锁 UI）
// =================================================================
export function AttachmentPanel({ postSlug }: { postSlug: string }) {
  const [items, setItems] = React.useState<AttachmentPublic[] | null>(null)
  const [error, setError] = React.useState('')
  const [tokens, setTokens] = React.useState<Record<number, string>>({})
  const [passwordInputs, setPasswordInputs] = React.useState<Record<number, string>>({})
  const [busy, setBusy] = React.useState<number | null>(null)

  const load = React.useCallback(async () => {
    setError('')
    try { setItems(await postAttachmentsFn({ data: { postSlug } })) }
    catch (e) { setError(e instanceof Error ? e.message : '附件列表读取失败。') }
  }, [postSlug])
  React.useEffect(() => { void load() }, [load])

  const tryUnlock = async (att: AttachmentPublic) => {
    const pwd = passwordInputs[att.id] || ''
    if (!pwd) { alert('请先输入密码。'); return }
    setBusy(att.id)
    try {
      const response = await fetch(`${attachmentTokenUrl(att.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '密码不正确。')
      setTokens((m) => ({ ...m, [att.id]: data.token as string }))
    } catch (e) { alert(e instanceof Error ? e.message : '校验失败。') }
    finally { setBusy(null) }
  }

  if (items && items.length === 0 && !error) return null
  return (
    <section className="attachment-panel comments-section">
      <div className="comments-heading">
        <div><FileDown size={18} /><h2>附件下载</h2><span>{items?.length ?? 0}</span></div>
        <p>按大小上限 4 MB 存储；带锁图标需作者指定的密码解锁后下载。</p>
      </div>
      {error && <div className="banner error small">{error} <button onClick={() => void load()}>重试</button></div>}
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
                    <span>· 已下载 <b>{att.downloads}</b> 次</span>
                    <span className={att.locked ? 'chip lock' : 'chip unlock'}>
                      {att.locked ? <><Lock size={10} />加密</> : <><LockOpen size={10} />公开</>}
                    </span>
                  </div>
                </div>
              </div>
              <div className="attach-actions">
                {att.locked ? (
                  tokens[att.id] ? (
                    <>
                      <span className="chip unlock"><LockOpen size={10} />已解锁，10 分钟内可下载</span>
                      <a className="row-action primary" href={attachmentDownloadUrl(att.id, tokens[att.id])} target="_blank" rel="noreferrer"><FileDown size={13} />下载</a>
                    </>
                  ) : (
                    <>
                      <input
                        type="password"
                        placeholder="作者设定的密码"
                        value={passwordInputs[att.id] ?? ''}
                        onChange={(e) => setPasswordInputs((m) => ({ ...m, [att.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') void tryUnlock(att) }}
                      />
                      <button className="row-action primary" disabled={busy === att.id} onClick={() => void tryUnlock(att)}>
                        {busy === att.id ? '校验中…' : '解锁并下载'}
                      </button>
                    </>
                  )
                ) : (
                  <a className="row-action primary" href={attachmentDownloadUrl(att.id)} target="_blank" rel="noreferrer"><FileDown size={13} />下载</a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
