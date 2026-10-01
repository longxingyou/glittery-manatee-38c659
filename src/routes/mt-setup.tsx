import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import type { MtBrowserClient } from '@/lib/mtproto-browser'

export const Route = createFileRoute('/mt-setup')({
  component: MtSetupPage,
})

interface MtStatus {
  configured: boolean
  hasConfig: boolean
  hasSession: boolean
  chat: { id: string } | null
}
interface MtCreds {
  apiId: number
  apiHash: string
  session: string
  chat: { id: string; accessHash: string } | null
}
interface ChannelItem {
  id: string
  accessHash: string
  title: string
  broadcast: boolean
}

async function apiJson(action: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`/api/comments?action=${action}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data
}

function MtSetupPage() {
  const t = useT()
  const [phase, setPhase] = useState<'loading' | 'need-admin' | 'ready'>('loading')
  const [status, setStatus] = useState<MtStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 应用凭据与手机号
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phone, setPhone] = useState('')
  // 验证码 / 2FA
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep] = useState<'app' | 'code' | 'password' | 'channel'>('app')
  const [channels, setChannels] = useState<ChannelItem[]>([])
  const [boundChat, setBoundChat] = useState<{ id: string } | null>(null)

  // gramjs 客户端与登录上下文保存在 ref（不触发渲染）
  const mcRef = useRef<MtBrowserClient | null>(null)
  const credsRef = useRef<{ apiId: number; apiHash: string } | null>(null)
  const phoneRef = useRef('')
  const codeHashRef = useRef('')

  const destroyClient = useCallback(async () => {
    if (mcRef.current) {
      await mcRef.current.destroy().catch(() => undefined)
      mcRef.current = null
    }
  }, [])

  useEffect(() => () => { void destroyClient() }, [destroyClient])

  // 初始：检查管理员状态与配置
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = (await apiJson('mt-status')) as MtStatus
        if (cancelled) return
        setStatus(s)
        setBoundChat(s.chat)
        setPhase('ready')
      } catch {
        if (!cancelled) setPhase('need-admin')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const ensureClient = useCallback(async (id: number, hash: string, session = '') => {
    if (!mcRef.current) {
      const mod = await import('@/lib/mtproto-browser')
      mcRef.current = await mod.createMtBrowserClient(id, hash, session)
    }
    return mcRef.current.client
  }, [])

  // 已配置：用存储的会话直接列出可绑定频道
  const loadChannelsWithSession = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const creds = (await apiJson('mt-creds')) as MtCreds
      const client = await ensureClient(creds.apiId, creds.apiHash, creds.session)
      const dialogs = await client.getDialogs({})
      const items: ChannelItem[] = []
      for (const d of dialogs) {
        const e = d.entity as { accessHash?: bigIntLike; className?: string; megagroup?: boolean; broadcast?: boolean } | undefined
        if (!e || !d.isChannel || e.accessHash == null) continue
        items.push({
          id: String(d.id),
          accessHash: String(e.accessHash),
          title: d.name || d.title || String(d.id),
          broadcast: !!e.broadcast,
        })
      }
      setChannels(items)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [ensureClient])

  // 步骤 1：连接 + 发送验证码
  const sendCode = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const id = Number(apiId)
      if (!Number.isInteger(id) || id <= 0) throw new Error(t('mts.err.appid'))
      if (!/^[a-f0-9]{20,}$/i.test(apiHash.trim())) throw new Error(t('mts.err.apphash'))
      if (!/^\+?\d{6,15}$/.test(phone.replace(/[\s-]/g, ''))) throw new Error(t('mts.err.phone'))
      credsRef.current = { apiId: id, apiHash: apiHash.trim() }
      phoneRef.current = phone.trim()
      const client = await ensureClient(id, apiHash.trim())
      const sent = await client.sendCode({ apiId: id, apiHash: apiHash.trim() }, phoneRef.current)
      codeHashRef.current = sent.phoneCodeHash
      setStep('code')
    } catch (e) {
      setError(fmtErr(e, t))
    } finally {
      setBusy(false)
    }
  }, [apiId, apiHash, phone, ensureClient, t])

  // 步骤 2：提交验证码（可能进入 2FA）
  const submitCode = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const { Api } = await import('telegram')
      const client = mcRef.current?.client
      const creds = credsRef.current
      if (!client || !creds) throw new Error(t('mts.err.state'))
      try {
        await client.invoke(new Api.auth.SignIn({
          phoneNumber: phoneRef.current,
          phoneCodeHash: codeHashRef.current,
          phoneCode: code.trim(),
        }))
      } catch (e) {
        // gramjs 2.x 不再导出 SessionPasswordNeededError，按 RPC errorMessage 判定
        if ((e as { errorMessage?: string })?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
          setStep('password')
          return
        }
        throw e
      }
      await afterSignedIn()
    } catch (e) {
      setError(fmtErr(e, t))
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, t])

  // 步骤 2b：2FA 密码
  const submitPassword = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const client = mcRef.current?.client
      const creds = credsRef.current
      if (!client || !creds) throw new Error(t('mts.err.state'))
      await client.signInWithPassword(
        { apiId: creds.apiId, apiHash: creds.apiHash },
        { password: async () => password, onError: async () => true },
      )
      await afterSignedIn()
    } catch (e) {
      setError(fmtErr(e, t))
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password, t])

  // 登录成功：保存会话 → 拉频道列表
  const afterSignedIn = async () => {
    const client = mcRef.current?.client
    const creds = credsRef.current
    if (!client || !creds) throw new Error(t('mts.err.state'))
    const mod = await import('@/lib/mtproto-browser')
    const session = mod.exportSessionString(client)
    await apiJson('mt-save-session', { method: 'POST', body: JSON.stringify({ apiId: creds.apiId, apiHash: creds.apiHash, session }) })
    const dialogs = await client.getDialogs({})
    const items: ChannelItem[] = []
    for (const d of dialogs) {
      const e = d.entity as { accessHash?: bigIntLike; broadcast?: boolean } | undefined
      if (!e || !d.isChannel || e.accessHash == null) continue
      items.push({
        id: String(d.id),
        accessHash: String(e.accessHash),
        title: d.name || d.title || String(d.id),
        broadcast: !!e.broadcast,
      })
    }
    setChannels(items)
    setStep('channel')
  }

  const bindChannel = useCallback(async (ch: ChannelItem) => {
    setBusy(true)
    setError('')
    try {
      await apiJson('mt-save-chat', { method: 'POST', body: JSON.stringify({ id: ch.id, accessHash: ch.accessHash }) })
      setBoundChat({ id: ch.id })
      setStatus((s) => (s ? { ...s, configured: true, chat: { id: ch.id } } : s))
      await destroyClient()
      setStep('app')
      setCode('')
      setPassword('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [destroyClient])

  const resetAll = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await apiJson('mt-clear', { method: 'POST' })
      setStatus((s) => (s ? { ...s, configured: false, hasSession: false, chat: null } : s))
      setBoundChat(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  if (phase === 'loading') {
    return (
      <main className="mts-page">
        <div className="mts-card"><p className="mts-muted">{t('mts.loading')}</p></div>
      </main>
    )
  }

  if (phase === 'need-admin') {
    return (
      <main className="mts-page">
        <div className="mts-card">
          <h1>{t('mts.title')}</h1>
          <p className="mts-err">{t('mts.need.admin')}</p>
          <button className="mts-btn primary" onClick={() => window.dispatchEvent(new Event('open-auth'))}>
            {t('mts.login.btn')}
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="mts-page">
      <div className="mts-card">
        <h1>{t('mts.title')}</h1>
        <p className="mts-muted" dangerouslySetInnerHTML={{ __html: t('mts.intro') }} />

        <dl className="mts-status">
          <dt>{t('mts.status.session')}</dt>
          <dd className={status?.hasSession ? 'ok' : 'no'}>
            {status?.hasSession ? t('mts.status.bound') : t('mts.status.none')}
          </dd>
          <dt>{t('mts.status.channel')}</dt>
          <dd className={boundChat ? 'ok' : 'no'}>{boundChat ? boundChat.id : t('mts.status.none')}</dd>
        </dl>

        {error && <p className="mts-err" role="alert">{error}</p>}

        {step === 'app' && (
          <section className="mts-step">
            <h2>1. {t('mts.step.app')}</h2>
            <p className="mts-muted" dangerouslySetInnerHTML={{ __html: t('mts.app.hint') }} />
            <label className="mts-label">{t('mts.app.id')}
              <input value={apiId} onChange={(e) => setApiId(e.target.value)} inputMode="numeric" placeholder="1234567" />
            </label>
            <label className="mts-label">{t('mts.app.hash')}
              <input value={apiHash} onChange={(e) => setApiHash(e.target.value)} spellCheck={false}
                placeholder="0123456789abcdef0123456789abcdef" />
            </label>
            <label className="mts-label">{t('mts.phone')}
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel"
                placeholder="+86 138 0000 0000" />
            </label>
            <button className="mts-btn primary" disabled={busy} onClick={() => void sendCode()}>
              {busy ? t('mts.busy') : t('mts.send.code')}
            </button>

            {status?.hasSession && (
              <div className="mts-sep">
                <button className="mts-btn" disabled={busy} onClick={() => void loadChannelsWithSession()}>
                  {t('mts.channel.reselect')}
                </button>
                <button className="mts-btn danger" disabled={busy} onClick={() => void resetAll()}>
                  {t('mts.clear.session')}
                </button>
              </div>
            )}
          </section>
        )}

        {step === 'code' && (
          <section className="mts-step">
            <h2>2. {t('mts.step.code')}</h2>
            <p className="mts-muted">{t('mts.code.hint')}</p>
            <label className="mts-label">{t('mts.code')}
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} autoFocus />
            </label>
            <button className="mts-btn primary" disabled={busy} onClick={() => void submitCode()}>
              {busy ? t('mts.busy') : t('mts.signin')}
            </button>
            <button className="mts-btn" disabled={busy} onClick={() => setStep('app')}>{t('mts.back')}</button>
          </section>
        )}

        {step === 'password' && (
          <section className="mts-step">
            <h2>2FA</h2>
            <p className="mts-muted">{t('mts.password.hint')}</p>
            <label className="mts-label">{t('mts.password')}
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') void submitPassword() }} />
            </label>
            <button className="mts-btn primary" disabled={busy} onClick={() => void submitPassword()}>
              {busy ? t('mts.busy') : t('mts.signin')}
            </button>
          </section>
        )}

        {step === 'channel' && (
          <section className="mts-step">
            <h2>3. {t('mts.step.channel')}</h2>
            <p className="mts-muted">{t('mts.channel.hint')}</p>
            {channels.length === 0 && <p className="mts-err">{t('mts.channel.empty')}</p>}
            <ul className="mts-channels">
              {channels.map((ch) => (
                <li key={ch.id}>
                  <button className="mts-channel-btn" disabled={busy} onClick={() => void bindChannel(ch)}>
                    <span className="mts-channel-title">{ch.title}</span>
                    <span className="mts-channel-meta">
                      {ch.broadcast ? t('mts.channel.broadcast') : t('mts.channel.megagroup')} · {ch.id}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="mts-foot">
          <Link to="/admin">{t('mts.back.admin')}</Link>
          {' · '}
          <a href="/api/comments?action=mt-selftest" target="_blank" rel="noreferrer">{t('mts.selftest')}</a>
        </div>
      </div>

      <style>{`
        .mts-page { min-height: 100vh; display: flex; justify-content: center; padding: 48px 16px;
          background: var(--bg, #0d1117); color: var(--text, #e6edf3); }
        .mts-card { width: 100%; max-width: 640px; background: var(--surface, #161b22);
          border: 1px solid var(--border, #30363d); border-radius: 12px; padding: 28px; }
        .mts-card h1 { font-size: 20px; margin: 0 0 8px; }
        .mts-card h2 { font-size: 15px; margin: 18px 0 8px; }
        .mts-muted { color: var(--text-dim, #8b949e); font-size: 13px; line-height: 1.7; }
        .mts-muted a { color: var(--accent, #4cc2ff); }
        .mts-err { color: #f85149; font-size: 13px; line-height: 1.6; }
        .mts-status { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 16px 0; font-size: 13px; }
        .mts-status dt { color: var(--text-dim, #8b949e); }
        .mts-status dd.ok { color: #3fb950; margin: 0; }
        .mts-status dd.no { color: #8b949e; margin: 0; }
        .mts-step { margin-top: 8px; border-top: 1px solid var(--border, #30363d); padding-top: 8px; }
        .mts-label { display: block; font-size: 13px; margin: 10px 0; color: var(--text-dim, #8b949e); }
        .mts-label input { display: block; width: 100%; margin-top: 4px; padding: 8px 10px; font-size: 14px;
          background: var(--bg, #0d1117); color: var(--text, #e6edf3);
          border: 1px solid var(--border, #30363d); border-radius: 8px; box-sizing: border-box; }
        .mts-btn { display: inline-block; margin: 6px 8px 0 0; padding: 8px 16px; font-size: 13px; cursor: pointer;
          background: transparent; color: var(--text, #e6edf3); border: 1px solid var(--border, #30363d);
          border-radius: 8px; }
        .mts-btn.primary { background: var(--accent, #1f6feb); border-color: var(--accent, #1f6feb); color: #fff; }
        .mts-btn.danger { color: #f85149; border-color: #f8514955; }
        .mts-btn:disabled { opacity: .55; cursor: default; }
        .mts-sep { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--border, #30363d); }
        .mts-channels { list-style: none; padding: 0; margin: 10px 0; max-height: 320px; overflow: auto; }
        .mts-channel-btn { display: block; width: 100%; text-align: left; padding: 10px 12px; margin-bottom: 6px;
          background: var(--bg, #0d1117); border: 1px solid var(--border, #30363d); border-radius: 8px;
          color: var(--text, #e6edf3); cursor: pointer; }
        .mts-channel-btn:hover { border-color: var(--accent, #1f6feb); }
        .mts-channel-title { display: block; font-size: 14px; }
        .mts-channel-meta { display: block; font-size: 12px; color: var(--text-dim, #8b949e); margin-top: 2px; }
        .mts-foot { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border, #30363d);
          font-size: 13px; }
        .mts-foot a { color: var(--accent, #4cc2ff); }
      `}</style>
    </main>
  )
}

type bigIntLike = { toString(): number } | { toString(): string } | number | bigint

function fmtErr(e: unknown, t: (k: string) => string): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/PHONE_NUMBER_INVALID/.test(msg)) return t('mts.err.phone')
  if (/PHONE_CODE_INVALID|CODE_INVALID/.test(msg)) return t('mts.err.code')
  if (/PASSWORD_HASH_INVALID|PASSWORD_EMPTY/.test(msg)) return t('mts.err.password')
  if (/FLOOD_WAIT|TooMany|too many/i.test(msg)) return t('mts.err.flood')
  return msg
}
