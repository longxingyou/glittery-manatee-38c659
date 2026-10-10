import * as React from 'react'
import {
  BookOpen,
  Braces,
  Check,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Play,
  Search,
  Share2,
  ShieldCheck,
  Zap,
} from 'lucide-react'

import { useT } from '@/lib/i18n'

const NET_API = '/api/net'

interface NetEnvelope {
  ok?: boolean
  error?: string
  status?: number
  finalUrl?: string
  contentType?: string
  truncated?: boolean
  body?: string
  engine?: string
  results?: Array<{ title: string; url: string; snippet: string }>
  via?: string
  enabled?: boolean
  links?: ShareLinkInfo[]
  id?: string
  token?: string
  /** YouTube 站内搜索结果（action=yt_search） */
  items?: YtSearchItem[]
  /** B站直链结果（action=bili_playurl） */
  streams?: string[]
  quality?: number | null
}

/** YouTube 站内搜索结果项 */
interface YtSearchItem {
  id: string
  title: string
  channel: string
  date: string
  thumb: string
}

interface ShareLinkInfo {
  id: string
  createdAt: string
  lastUsedAt: string | null
  bound: boolean
}

function buildNetUrl(action: 'gh' | 'fetch' | 'reader' | 'search' | 'share_info' | 'yt_search' | 'download' | 'bili_playurl', params: Record<string, string>): string {
  const u = new URL(NET_API, window.location.origin)
  u.searchParams.set('action', action)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

async function callNet(action: 'fetch' | 'search', params: Record<string, string>, shared = false): Promise<NetEnvelope> {
  const res = await fetch(buildNetUrl(action, params), { credentials: 'same-origin' })
  let data: NetEnvelope = {}
  try { data = (await res.json()) as NetEnvelope } catch { /* 非 JSON 响应 */ }
  if (res.status === 401) {
    // 分享模式下无登录入口，直接展示错误而非弹出登录框
    if (!shared) window.dispatchEvent(new Event('open-auth'))
    throw new Error(data.error || '需要管理员登录。')
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

/** YouTube 站内搜索（服务端 /api/net?action=yt_search，需 Worker secret YT_API_KEY） */
async function ytSearch(q: string): Promise<YtSearchItem[]> {
  const res = await fetch(buildNetUrl('yt_search', { q }), { credentials: 'same-origin' })
  let data: NetEnvelope = {}
  try { data = (await res.json()) as NetEnvelope } catch { /* 非 JSON 响应 */ }
  if (res.status === 401) {
    window.dispatchEvent(new Event('open-auth'))
    throw new Error(data.error || '需要管理员登录。')
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data.items ?? []
}

/** 分享管理 POST（仅管理员）：share_list/create/delete/reset/toggle */
async function postNet(action: string, extra?: Record<string, unknown>): Promise<NetEnvelope> {
  const res = await fetch(NET_API, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  })
  let data: NetEnvelope = {}
  try { data = (await res.json()) as NetEnvelope } catch { /* 非 JSON 响应 */ }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

/** 分享模式管理面板（仅管理员可见）：总开关 + 链接列表 */
function SharePanel() {
  const t = useT()
  const [enabled, setEnabled] = React.useState(false)
  const [links, setLinks] = React.useState<ShareLinkInfo[]>([])
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [loaded, setLoaded] = React.useState(false)
  // 明文 token 仅在创建时返回一次；此后 DB 只存哈希，无法再复制
  const [freshUrls, setFreshUrls] = React.useState<Record<string, string>>({})

  const shareUrl = (token: string) =>
    `${window.location.origin}${NET_API}?action=claim&t=${token}`

  const refresh = React.useCallback(async () => {
    const data = await postNet('share_list')
    setEnabled(data.enabled === true)
    setLinks(data.links ?? [])
    setLoaded(true)
  }, [])

  React.useEffect(() => {
    refresh().catch((e) => { setError(e instanceof Error ? e.message : t('admin.net.share.failed')); setLoaded(true) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : t('admin.net.share.failed')) } finally { setBusy('') }
  }

  const toggle = () => run('toggle', async () => {
    if (enabled && !window.confirm(t('admin.net.share.confirmoff'))) return
    const data = await postNet('share_toggle', { enabled: !enabled })
    setEnabled(data.enabled === true)
    if (data.enabled === false) setLinks([])
    if (data.token && data.id) setFreshUrls((m) => ({ ...m, [data.id!]: shareUrl(data.token!) }))
    await refresh()
  })

  const create = () => run('create', async () => {
    const data = await postNet('share_create')
    if (data.token && data.id) setFreshUrls((m) => ({ ...m, [data.id!]: shareUrl(data.token!) }))
    await refresh()
  })

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
        <Share2 size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('admin.net.share.title')}
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: enabled ? '#3fb950' : 'var(--muted)' }}>
          {loaded ? (enabled ? t('admin.net.share.on') : t('admin.net.share.off')) : '…'}
        </span>
      </h2>
      <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.share.desc')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className={enabled ? 'ghost-button' : 'primary-button'} disabled={busy === 'toggle' || !loaded} onClick={() => void toggle()}>
          {enabled ? t('admin.net.share.turnoff') : t('admin.net.share.turnon')}
        </button>
        <button type="button" className="ghost-button" disabled={busy === 'create' || !loaded} onClick={() => void create()}>
          {t('admin.net.share.add')}
        </button>
      </div>
      {error && <div className="banner error" style={{ marginTop: 12 }}>{error}</div>}
      {links.length === 0 && loaded && (
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: '12px 0 0' }}>{t('admin.net.share.empty')}</p>
      )}
      {links.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 10 }}>
          {links.map((l) => (
            <li key={l.id} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <code style={{ fontSize: 12 }}>#{l.id}</code>
                <span style={{ color: l.bound ? '#d29922' : '#3fb950', fontSize: 12 }}>
                  {l.bound ? t('admin.net.share.bound') : t('admin.net.share.unbound')}
                </span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {t('admin.net.share.lastused')}: {l.lastUsedAt ? new Date(l.lastUsedAt).toLocaleString() : t('admin.net.share.never')}
                </span>
                <span style={{ flex: 1 }} />
                {freshUrls[l.id] && (
                  <CopyButton text={freshUrls[l.id]!} label={t('admin.net.share.copy')} copiedKey={`share-${l.id}`} onCopied={() => undefined} />
                )}
                {l.bound && (
                  <button type="button" className="ghost-button" disabled={busy === `reset-${l.id}`}
                    onClick={() => void run(`reset-${l.id}`, async () => { await postNet('share_reset', { id: l.id }); await refresh() })}>
                    {t('admin.net.share.reset')}
                  </button>
                )}
                <button type="button" className="ghost-button" disabled={busy === `del-${l.id}`}
                  onClick={() => void run(`del-${l.id}`, async () => { await postNet('share_delete', { id: l.id }); await refresh() })}>
                  {t('admin.net.share.delete')}
                </button>
              </div>
              {freshUrls[l.id] && (
                <div style={{ marginTop: 8, fontSize: 12, wordBreak: 'break-all' }}>
                  <span style={{ color: '#d29922' }}>{t('admin.net.share.newurl')}</span>
                  <code>{freshUrls[l.id]}</code>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CopyButton({ text, label, copiedKey, onCopied }: { text: string; label: string; copiedKey: string; onCopied: (k: string) => void }) {
  const t = useT()
  const [done, setDone] = React.useState(false)
  return (
    <button
      type="button"
      className="ghost-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        setDone(true)
        onCopied(copiedKey)
        setTimeout(() => setDone(false), 1500)
      }}
      title={label}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {done ? t('admin.net.copied') : label}
    </button>
  )
}

// ────────────────────────────────────────────────────────────
// 视频面板：B站 / YouTube。
// 两种播放模式：
// - embed：官方外链播放器 iframe。桌面端正常；但 B站移动端对第三方页面的 iframe
//   嵌入有 JS 层风控（手机各浏览器均提示"嵌入的站点无法访问"），no-referrer 亦无效。
// - native（仅 B站）：浏览器端 JSONP 调 B站接口（view → cid → playurl），取
//   platform=html5 的 720P MP4 直链（无 Referer 鉴权、CORS 放行、支持 Range），
//   用原生 <video> 播放。请求由用户本机 IP 直发 B站，视频流不经本站服务器，
//   因而不受 iframe 嵌入风控影响——手机端默认此模式。
// worker.ts 已放行：script-src api.bilibili.com（JSONP）、media-src *.bilivideo.com。
// ────────────────────────────────────────────────────────────

/** 从粘贴内容解析 B站/YouTube 视频标识；b23.tv 短链无法在浏览器侧解析（CORS），需先打开复制长链 */
function parseVideoInput(raw: string): { site: 'bili' | 'yt'; id: string } | null {
  const s = raw.trim()
  if (!s) return null
  const bv = /BV[0-9A-Za-z]{10}/.exec(s)
  if (bv) return { site: 'bili', id: bv[0] }
  const av = /(?:^|[^\w])av(\d{6,})/i.exec(s)
  if (av) return { site: 'bili', id: `av${av[1]}` }
  const yt = /(?:youtube\.com\/(?:watch\?[^#\s]*?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([0-9A-Za-z_-]{11})/.exec(s)
  if (yt) return { site: 'yt', id: yt[1] }
  if (/^[0-9A-Za-z_-]{11}$/.test(s)) return { site: 'yt', id: s }
  return null
}

/** 通用 JSONP：B站接口以 application/json 提供且不发 CORS 头，第三方页面只能靠 JSONP 跨域读取 */
function jsonp<T>(baseUrl: string, timeoutMs = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = `__sg_jp_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
    const s = document.createElement('script')
    const cleanup = () => {
      clearTimeout(timer)
      delete (window as unknown as Record<string, unknown>)[cb]
      s.remove()
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('JSONP timeout')) }, timeoutMs)
    ;(window as unknown as Record<string, (data: T) => void>)[cb] = (data: T) => { cleanup(); resolve(data) }
    s.onerror = () => { cleanup(); reject(new Error('JSONP network error')) }
    s.src = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}jsonp=jsonp&callback=${cb}`
    document.head.appendChild(s)
  })
}

interface BiliPageInfo { cid: number; page: number; part: string }
interface BiliViewInfo {
  title: string
  pic: string
  pages: BiliPageInfo[]
}
interface BiliApiEnvelope<T> { code: number; message: string; data: T }

function biliIdParam(id: string): string {
  return id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${encodeURIComponent(id)}`
}

/** view 接口：视频元信息 + 分 P 列表（每页含独立 cid） */
async function fetchBiliView(id: string): Promise<BiliViewInfo> {
  const info = await jsonp<BiliApiEnvelope<{ title: string; pic: string; pages: BiliPageInfo[] }>>(
    `https://api.bilibili.com/x/web-interface/view?${biliIdParam(id)}`,
  )
  if (info.code !== 0) throw new Error(`view API ${info.code}: ${info.message}`)
  return {
    title: info.data.title,
    pic: (info.data.pic || '').replace(/^http:\/\//, 'https://'),
    pages: info.data.pages ?? [],
  }
}

/**
 * playurl(platform=html5)：免登录 720P MP4，无 Referer 鉴权；返回主地址 + 备用线路。
 * 必须走同源 Worker 代理：playurl 仅接受 *.bilibili.com 的 Referer（浏览器直连
 * 第三方/空 Referer 返回 403，JSONP 还会被 Chrome ORB 拦截），由 Worker 伪造 Referer。
 */
async function fetchBiliStreams(id: string, cid: number): Promise<string[]> {
  const params: Record<string, string> = { cid: String(cid) }
  if (id.startsWith('av')) params.aid = id.slice(2)
  else params.bvid = id
  const res = await fetch(buildNetUrl('bili_playurl', params), { credentials: 'same-origin' })
  let data: NetEnvelope = {}
  try { data = (await res.json()) as NetEnvelope } catch { /* 非 JSON */ }
  if (res.status === 401) {
    window.dispatchEvent(new Event('open-auth'))
    throw new Error(data.error || '需要管理员登录。')
  }
  if (!res.ok || data.ok === false || !data.streams?.length) {
    throw new Error(data.error || `playurl HTTP ${res.status}`)
  }
  return data.streams
}

/** 手机/平板等触屏设备默认走直链模式（嵌入模式在移动浏览器被 B站风控） */
function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 820
}

function VideoPanel() {
  const t = useT()
  const [raw, setRaw] = React.useState('')
  const [video, setVideo] = React.useState<{ site: 'bili' | 'yt'; id: string } | null>(null)
  const [error, setError] = React.useState('')
  const [q, setQ] = React.useState('')
  const [items, setItems] = React.useState<YtSearchItem[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [mode, setMode] = React.useState<'embed' | 'native'>(() => (isTouchDevice() ? 'native' : 'embed'))
  const [pageIdx, setPageIdx] = React.useState(0)
  const [biliInfo, setBiliInfo] = React.useState<BiliViewInfo | null>(null)
  const [streamState, setStreamState] = React.useState<'loading' | 'ok' | 'error'>('loading')
  const [streams, setStreams] = React.useState<string[]>([])
  const [streamErr, setStreamErr] = React.useState('')
  const [streamIdx, setStreamIdx] = React.useState(0)

  const play = () => {
    setError('')
    const v = parseVideoInput(raw)
    if (!v) { setError(t('admin.net.video.invalid')); return }
    setVideo(v)
    setPageIdx(0)
    setStreamIdx(0)
    setBiliInfo(null)
    setStreams([])
    setStreamState('loading')
    setMode(v.site === 'bili' && isTouchDevice() ? 'native' : 'embed')
  }

  const search = async () => {
    const kw = q.trim()
    if (!kw || busy) return
    setBusy(true)
    setError('')
    try {
      setItems(await ytSearch(kw))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.net.video.failed'))
    } finally {
      setBusy(false)
    }
  }

  // B站直链解析：先 view 取分 P 列表，再用选中页 cid 调 playurl 取 MP4。
  // video/mode/分P 变化时触发；切 P 复用已取到的 pages 元信息。
  const biliId = video?.site === 'bili' ? video.id : null
  React.useEffect(() => {
    if (!biliId || mode !== 'native') return
    let cancelled = false
    setStreamIdx(0)
    setStreams([])
    setStreamState('loading')
    setStreamErr('')
    ;(async () => {
      // view 已有（切 P 场景）则复用，否则重新拉取
      const info = biliInfo ?? await fetchBiliView(biliId)
      if (cancelled) return
      if (!biliInfo) setBiliInfo(info)
      if (info.pages.length === 0) throw new Error('empty pages')
      const cid = info.pages[Math.min(pageIdx, info.pages.length - 1)]!.cid
      const got = await fetchBiliStreams(biliId, cid)
      if (cancelled) return
      setStreams(got)
      setStreamState('ok')
    })().catch((e: unknown) => {
      if (cancelled) return
      const msg = e instanceof Error ? e.message : 'resolve failed'
      setStreamErr(
        /no mp4 durl|empty pages/i.test(msg)
          ? t('admin.net.video.nodash')
          : /API -?\d{3}|风控|拒绝了服务器|playurl/i.test(msg)
            ? t('admin.net.video.ratelimited')
            : t('admin.net.video.nativefail'),
      )
      setStreamState('error')
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biliId, mode, pageIdx])

  // 参数严格按 B站官方外链播放器文档（https://player.bilibili.com/）：
  // aid/bvid 选一；p=分集；autoplay/danmaku 为布尔。
  const embedSrc = video
    ? video.site === 'bili'
      ? `https://player.bilibili.com/player.html${video.id.startsWith('av') ? `?aid=${video.id.slice(2)}` : `?bvid=${video.id}`}&p=${pageIdx + 1}&autoplay=0&danmaku=0`
      : `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=0&rel=0`
    : ''

  const appDeepLink = video
    ? video.site === 'bili'
      ? `bilibili://video/${video.id.startsWith('av') ? video.id.slice(2) : video.id}`
      : `vnd.youtube:${video.id}`
    : ''

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
        <Play size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('admin.net.video.title')}
      </h2>
      <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.video.desc')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <input
          value={raw}
          onChange={(e) => { setRaw(e.target.value); setError('') }}
          onKeyDown={(e) => { if (e.key === 'Enter') play() }}
          placeholder={t('admin.net.video.placeholder')}
          spellCheck={false}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button type="button" className="primary-button" onClick={play}>{t('admin.net.video.play')}</button>
      </div>
      {error && <div className="banner error" style={{ marginTop: 10 }}>{error}</div>}
      {video && (
        <>
          {/* 模式切换：B站支持嵌入/直链；YouTube 仅嵌入 */}
          {video.site === 'bili' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              <button
                type="button"
                className={mode === 'embed' ? 'primary-button' : 'ghost-button'}
                onClick={() => setMode('embed')}
              >
                {t('admin.net.video.mode.embed')}
              </button>
              <button
                type="button"
                className={mode === 'native' ? 'primary-button' : 'ghost-button'}
                onClick={() => setMode('native')}
              >
                {t('admin.net.video.mode.native')}
              </button>
            </div>
          )}

          {mode === 'embed' || video.site === 'yt' ? (
            <div style={{ position: 'relative', marginTop: 12, width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
              <iframe
                key={embedSrc}
                src={embedSrc}
                title={t('admin.net.video.title')}
                allowFullScreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                referrerPolicy="no-referrer"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              />
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
                {streamState === 'loading' && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c9d1d9', fontSize: 14 }}>
                    {t('admin.net.video.resolving')}
                  </div>
                )}
                {streamState === 'ok' && streams[streamIdx] && (
                  <video
                    key={streams[streamIdx]}
                    ref={(el) => {
                      // React 类型未声明 video.referrerPolicy，但现代浏览器均支持；
                      // html5 直链虽无 Referer 鉴权，仍显式去掉，最大兼容性
                      if (el) (el as HTMLVideoElement & { referrerPolicy: string }).referrerPolicy = 'no-referrer'
                    }}
                    src={streams[streamIdx]}
                    poster={biliInfo?.pic || undefined}
                    controls
                    playsInline
                    preload="metadata"
                    onError={() => {
                      // 主线路失败依次回退 backup_url；全部失败才报错
                      if (streamIdx < streams.length - 1) {
                        setStreamIdx((i) => i + 1)
                      } else {
                        setStreamErr(t('admin.net.video.nativefail'))
                        setStreamState('error')
                      }
                    }}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: '#000' }}
                  />
                )}
                {streamState === 'error' && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center', color: '#f85149', fontSize: 13 }}>
                    <span>{streamErr}</span>
                    <button type="button" className="ghost-button" onClick={() => setMode('embed')}>
                      {t('admin.net.video.mode.embed')}
                    </button>
                  </div>
                )}
              </div>
              {/* 分 P 选择 + 元信息 */}
              {biliInfo && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 12 }}>
                  <strong style={{ fontSize: 13, maxWidth: '100%' }}>{biliInfo.title}</strong>
                  {biliInfo.pages.length > 1 && (
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'var(--muted)' }}>
                      {t('admin.net.video.pages')}
                      <select
                        value={pageIdx}
                        onChange={(e) => { setPageIdx(Number(e.target.value)); setStreamIdx(0) }}
                        style={{ maxWidth: 220 }}
                      >
                        {biliInfo.pages.map((p, i) => (
                          <option key={p.cid} value={i}>P{p.page} {p.part}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <span style={{ color: 'var(--muted)' }}>720P</span>
                </div>
              )}
            </div>
          )}

          {/* 外部打开兜底：新窗口顶层播放（已验证手机正常）/ 唤起 App */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: 12 }}>
            <a href={embedSrc} target="_blank" rel="noreferrer">
              {t('admin.net.video.openplayer')} <ExternalLink size={12} style={{ verticalAlign: '-2px' }} />
            </a>
            <a href={appDeepLink}>{t('admin.net.video.openapp')}</a>
          </div>
        </>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>{t('admin.net.video.ytsearch')}</strong>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
          placeholder={t('admin.net.video.searchph')}
          spellCheck={false}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button type="button" className="ghost-button" disabled={busy || !q.trim()} onClick={() => void search()}>
          {busy ? '…' : t('admin.net.video.search')}
        </button>
        <a href={`https://search.bilibili.com/all?keyword=${encodeURIComponent(q.trim())}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
          {t('admin.net.video.openbili')} <ExternalLink size={12} style={{ verticalAlign: '-2px' }} />
        </a>
      </div>
      <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 12 }}>{t('admin.net.video.bilihint')}</p>
      {items && (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 10 }}>
          {items.map((it) => (
            <li key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              {it.thumb && <img src={it.thumb} alt="" loading="lazy" style={{ width: 120, borderRadius: 6, flexShrink: 0 }} />}
              <div style={{ minWidth: 0 }}>
                <button
                  type="button"
                  className="ghost-button"
                  style={{ padding: '2px 6px', whiteSpace: 'normal', textAlign: 'left', height: 'auto' }}
                  onClick={() => {
                    setVideo({ site: 'yt', id: it.id })
                    setRaw(`https://www.youtube.com/watch?v=${it.id}`)
                    window.scrollTo({ top: 0, behavior: 'smooth' })
                  }}
                >
                  {it.title}
                </button>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                  {it.channel}{it.date ? ` · ${it.date}` : ''}
                </div>
              </div>
            </li>
          ))}
          {items.length === 0 && <li style={{ color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.video.noresult')}</li>}
        </ul>
      )}
    </section>
  )
}

const QUICK_LINKS = [
  { host: 'GitHub', url: 'https://github.com' },
  { host: 'Google Scholar', url: 'https://scholar.google.com' },
  { host: 'arXiv', url: 'https://arxiv.org' },
  { host: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov' },
  { host: 'Semantic Scholar', url: 'https://www.semanticscholar.org' },
  { host: 'Stack Overflow', url: 'https://stackoverflow.com' },
  { host: 'Wikipedia', url: 'https://www.wikipedia.org' },
]

// 回国快捷入口：中国常用服务直达
const QUICK_LINKS_CN = [
  { host: '百度', url: 'https://www.baidu.com' },
  { host: '哔哩哔哩', url: 'https://www.bilibili.com' },
  { host: '知乎', url: 'https://www.zhihu.com' },
  { host: '豆瓣', url: 'https://www.douban.com' },
  { host: '微博', url: 'https://www.weibo.com' },
  { host: '中国知网', url: 'https://www.cnki.net' },
  { host: 'CSDN', url: 'https://www.csdn.net' },
  { host: '淘宝', url: 'https://www.taobao.com' },
  { host: '京东', url: 'https://www.jd.com' },
  { host: '国家政务', url: 'https://www.gov.cn' },
]

// ── 搜索智能路由 ──
// 用户偏好持久化键；仅存 'auto' | 'global' | 'cn'，无敏感信息
const SEARCH_REGION_KEY = 'sg_net_search_region'
type SearchRegion = 'auto' | 'global' | 'cn'

function loadSearchRegion(): SearchRegion {
  if (typeof window === 'undefined') return 'auto'
  try {
    const v = window.localStorage.getItem(SEARCH_REGION_KEY)
    if (v === 'global' || v === 'cn') return v
  } catch { /* localStorage 不可用（隐私模式等），退回默认 auto */ }
  return 'auto'
}

// CJK 检测：含中文/日文/韩文 → 走回国线路（中文用户大概率希望中国源）
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/

/** 根据查询文字自动判断线路：CJK 字符 → cn，纯拉丁/数字/符号 → global */
function detectRegion(q: string): 'global' | 'cn' {
  return CJK_RE.test(q) ? 'cn' : 'global'
}

export function NetworkTools({ shared = false }: { shared?: boolean }) {
  const t = useT()
  // 分享模式：挂载时自检 SG_SHARE cookie（/api/net?action=share_info）
  const [denied, setDenied] = React.useState('')
  const [checking, setChecking] = React.useState(shared)
  React.useEffect(() => {
    if (!shared) return
    fetch(buildNetUrl('share_info', {}), { credentials: 'same-origin' })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as NetEnvelope
        if (!res.ok || data.ok === false) setDenied(data.error || t('admin.net.share.denied'))
      })
      .catch(() => setDenied(t('admin.net.share.denied')))
      .finally(() => setChecking(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared])

  const [ghInput, setGhInput] = React.useState('')
  const [ghError, setGhError] = React.useState('')
  const [ghCopied, setGhCopied] = React.useState('')

  // 文件下载输入
  const [dlInput, setDlInput] = React.useState('')

  const [pageUrl, setPageUrl] = React.useState('')
  const [fetchBusy, setFetchBusy] = React.useState(false)
  const [fetchError, setFetchError] = React.useState('')
  const [fetchData, setFetchData] = React.useState<NonNullable<NetEnvelope> | null>(null)

  const [query, setQuery] = React.useState('')
  const [searchBusy, setSearchBusy] = React.useState(false)
  const [searchError, setSearchError] = React.useState('')
  const [searchResults, setSearchResults] = React.useState<NonNullable<NetEnvelope['results']>>([])
  const [searchEngine, setSearchEngine] = React.useState('')
  const [searchRegion, setSearchRegion] = React.useState<SearchRegion>('auto')
  // 记录上次实际生效线路，仅在 auto 模式下展示「自动识别」徽章
  const [autoResolved, setAutoResolved] = React.useState<'global' | 'cn' | null>(null)

  // 首次挂载：从 localStorage 恢复用户偏好；变更时持久化
  React.useEffect(() => {
    const r = loadSearchRegion()
    if (r !== 'auto') setSearchRegion(r)
  }, [])
  const persistRegion = React.useCallback((r: SearchRegion) => {
    try {
      if (r === 'auto') window.localStorage.removeItem(SEARCH_REGION_KEY)
      else window.localStorage.setItem(SEARCH_REGION_KEY, r)
    } catch { /* 隐私模式或配额限制，忽略 */ }
  }, [])
  const chooseRegion = React.useCallback((r: SearchRegion) => {
    setSearchRegion(r)
    persistRegion(r)
  }, [persistRegion])

  const ghTargets = React.useMemo(() => {
    const v = ghInput.trim()
    if (!/^https:\/\/([\w-]+\.)*(github|githubusercontent|githubassets)\.com(\/|$)/i.test(v)) return null
    return {
      auto: buildNetUrl('gh', { u: v, mode: 'auto' }),
      pipe: buildNetUrl('gh', { u: v, mode: 'pipe' }),
    }
  }, [ghInput])

  // 文件下载 URL：任意 http(s) 链接都放行（服务端再做 SSRF 校验）
  const dlUrl = React.useMemo(() => {
    const v = dlInput.trim()
    if (!/^https?:\/\//.test(v)) return null
    return buildNetUrl('download', { u: v })
  }, [dlInput])

  const doFetchText = async () => {
    const u = pageUrl.trim()
    if (!/^https?:\/\//.test(u)) {
      setFetchError(t('admin.net.fetch.badurl'))
      return
    }
    setFetchBusy(true)
    setFetchError('')
    setFetchData(null)
    try {
      setFetchData(await callNet('fetch', { u }, shared))
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : t('admin.net.fetch.failed'))
    } finally {
      setFetchBusy(false)
    }
  }

  const openReader = () => {
    const u = pageUrl.trim()
    if (!/^https?:\/\//.test(u)) {
      setFetchError(t('admin.net.fetch.badurl'))
      return
    }
    window.open(buildNetUrl('reader', { u }), '_blank', 'noopener,noreferrer')
  }

  const doSearch = async () => {
    const q = query.trim()
    if (!q) return
    // 智能路由：auto 模式按查询文字含 CJK 与否选路；手动锁定则按用户偏好
    const effective = searchRegion === 'auto' ? detectRegion(q) : searchRegion
    setAutoResolved(searchRegion === 'auto' ? effective : null)
    setSearchBusy(true)
    setSearchError('')
    setSearchResults([])
    setSearchEngine('')
    try {
      const data = await callNet('search', { q, ...(effective === 'cn' ? { region: 'cn' } : {}) }, shared)
      setSearchResults(data.results ?? [])
      setSearchEngine(data.engine || '')
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : t('admin.net.search.failed'))
    } finally {
      setSearchBusy(false)
    }
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div>
          <h1><Globe size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />{t('admin.net.title')}</h1>
          <p>{t('admin.net.sub')}</p>
        </div>
      </div>

      {shared ? (
        checking ? (
          <div className="banner" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>…</div>
        ) : denied ? (
          <div className="banner error" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={15} /> {denied}
          </div>
        ) : (
          <div className="banner ok" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Share2 size={15} /> {t('admin.net.shared.banner')}
          </div>
        )
      ) : (
        <div className="banner ok" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldCheck size={15} /> {t('admin.net.audit')}
        </div>
      )}

      {shared && (checking || denied) ? null : (
        <>
      {!shared && <SharePanel />}
      {!shared && <VideoPanel />}

      {/* ── GitHub 加速 ── */}
      <section className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}><Zap size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('admin.net.gh.title')}</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.gh.desc')}</p>
        <input
          value={ghInput}
          onChange={(e) => { setGhInput(e.target.value); setGhError('') }}
          placeholder="https://github.com/owner/repo/releases/download/v1/file.zip"
          spellCheck={false}
        />
        {ghInput.trim() && !ghTargets && <div className="banner error" style={{ marginTop: 8 }}>{t('admin.net.gh.bad')}</div>}
        {ghError && <div className="banner error" style={{ marginTop: 8 }}>{ghError}</div>}
        {ghTargets && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <a className="primary-button" href={ghTargets.auto} rel="noreferrer">
              <Download size={14} /> {t('admin.net.gh.auto')}
            </a>
            <a className="ghost-button" href={ghTargets.pipe} rel="noreferrer">
              <Download size={14} /> {t('admin.net.gh.pipe')}
            </a>
            <CopyButton text={ghTargets.auto} label={t('admin.net.gh.copyauto')} copiedKey="auto" onCopied={setGhCopied} />
            <CopyButton text={ghTargets.pipe} label={t('admin.net.gh.copypipe')} copiedKey="pipe" onCopied={setGhCopied} />
            {ghCopied && <small style={{ alignSelf: 'center', color: 'var(--muted)' }}>{t('admin.net.gh.hint')}</small>}
          </div>
        )}
      </section>

      {/* ── 网页与 API ── */}
      <section className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}><BookOpen size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('admin.net.acc.title')}</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.acc.desc')}</p>
        <input
          value={pageUrl}
          onChange={(e) => setPageUrl(e.target.value)}
          placeholder="https://example.com/article 或 https://api.example.com/v1/data"
          spellCheck={false}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <button type="button" className="primary-button" onClick={openReader}>
            <BookOpen size={14} /> {t('admin.net.acc.reader')}
          </button>
          <button type="button" className="ghost-button" disabled={fetchBusy} onClick={() => void doFetchText()}>
            <Braces size={14} /> {fetchBusy ? t('admin.net.acc.busy') : t('admin.net.acc.fetch')}
          </button>
        </div>
        {fetchError && <div className="banner error" style={{ marginTop: 12 }}>{fetchError}</div>}
        {fetchData?.body != null && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>{t('admin.net.acc.status')}: {fetchData.status}</span>
              <span>{t('admin.net.acc.type')}: {fetchData.contentType || '?'}</span>
              {fetchData.truncated && <span style={{ color: '#d29922' }}>{t('admin.net.acc.truncated')}</span>}
              <CopyButton text={fetchData.body} label={t('admin.net.acc.copy')} copiedKey="body" onCopied={() => undefined} />
            </div>
            <pre style={{ maxHeight: 420, overflow: 'auto', margin: 0, padding: 12, background: 'var(--inset-bg, rgba(127,139,155,0.12))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, lineHeight: 1.55 }}>{fetchData.body}</pre>
          </div>
        )}
      </section>

      {/* ── 文件下载 ── */}
      <section className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}><Download size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('admin.net.dl.title')}</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.dl.desc')}</p>
        <input
          value={dlInput}
          onChange={(e) => setDlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && dlUrl) window.location.href = dlUrl }}
          placeholder={t('admin.net.dl.ph')}
          spellCheck={false}
        />
        {dlInput.trim() && !dlUrl && <div className="banner error" style={{ marginTop: 8 }}>{t('admin.net.fetch.badurl')}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <a className="primary-button" href={dlUrl || '#'} aria-disabled={!dlUrl} onClick={(e) => { if (!dlUrl) e.preventDefault() }}>
            <Download size={14} /> {t('admin.net.dl.go')}
          </a>
          {dlUrl && <CopyButton text={dlUrl} label={t('admin.net.gh.copyauto')} copiedKey="dl" onCopied={() => undefined} />}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, margin: '10px 0 0', lineHeight: 1.6 }}>{t('admin.net.dl.hint')}</p>
      </section>

      {/* ── 代理搜索 ── */}
      <section className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}><Search size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('admin.net.search.title')}</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.search.desc')}</p>
        <div style={{ display: 'flex', gap: 4, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className={searchRegion === 'auto' ? 'primary-button' : 'ghost-button'} style={{ fontSize: 13, padding: '4px 12px' }} onClick={() => chooseRegion('auto')}>
            <Zap size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />{t('admin.net.search.region.auto')}
          </button>
          <button type="button" className={searchRegion === 'global' ? 'primary-button' : 'ghost-button'} style={{ fontSize: 13, padding: '4px 12px' }} onClick={() => chooseRegion('global')}>
            <Globe size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />{t('admin.net.search.region.global')}
          </button>
          <button type="button" className={searchRegion === 'cn' ? 'primary-button' : 'ghost-button'} style={{ fontSize: 13, padding: '4px 12px' }} onClick={() => chooseRegion('cn')}>
            {t('admin.net.search.region.cn')}
          </button>
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 4 }}>{t('admin.net.search.region.tip')}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doSearch() }}
            placeholder={t('admin.net.search.ph')}
            style={{ flex: 1 }}
          />
          <button type="button" className="primary-button" disabled={searchBusy} onClick={() => void doSearch()}>
            <Search size={14} /> {searchBusy ? t('admin.net.search.busy') : t('admin.net.search.go')}
          </button>
        </div>
        {searchError && <div className="banner error" style={{ marginTop: 12 }}>{searchError}</div>}
        {searchResults.length > 0 && searchEngine && (
          <p style={{ color: 'var(--muted)', fontSize: 12, margin: '12px 0 0' }}>
            {t('admin.net.search.via')}: {searchEngine === 'fallback' ? 'Crossref + arXiv + DDG Instant Answer' : searchEngine === 'bing-cn' ? 'Bing 中国' : searchEngine === 'baidu' ? '百度' : searchEngine}
            {searchEngine === 'fallback' && ` — ${t('admin.net.search.fallbacktip')}`}
            {autoResolved && (
              <span style={{ marginLeft: 8, color: '#3fb950' }}>
                · {t('admin.net.search.region.autobadge')}: {autoResolved === 'cn' ? t('admin.net.search.region.cn') : t('admin.net.search.region.global')}
              </span>
            )}
          </p>
        )}
        {searchResults.length === 0 && !searchBusy && !searchError && query && (
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 12 }}>{t('admin.net.search.none')}</p>
        )}
        <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 10 }}>
          {searchResults.map((r) => (
            <li key={r.url} style={{ paddingBottom: 10, borderBottom: '1px dashed var(--border)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <a href={r.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{r.title || r.url}</a>
                <a
                  className="text-button"
                  href={buildNetUrl('reader', { u: r.url })}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                >
                  <BookOpen size={12} style={{ verticalAlign: '-2px' }} /> {t('admin.net.search.reader')}
                </a>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>{r.url}</div>
              {r.snippet && <p style={{ margin: '4px 0 0', fontSize: 13 }}>{r.snippet}</p>}
            </li>
          ))}
        </ol>
      </section>

      {/* ── 常用入口 ── */}
      <section className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}><ExternalLink size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('admin.net.quick.title')}</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.quick.desc')}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {QUICK_LINKS.map((q) => (
            <a key={q.url} className="ghost-button" href={q.url} target="_blank" rel="noreferrer">
              <Globe size={14} /> {q.host}
            </a>
          ))}
        </div>
      </section>

      {/* ── 回国快捷入口 ── */}
      <section className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}><Globe size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{t('admin.net.cn.quick.title')}</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('admin.net.cn.quick.desc')}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {QUICK_LINKS_CN.map((q) => (
            <a key={q.url} className="ghost-button" href={q.url} target="_blank" rel="noreferrer">
              <Globe size={14} /> {q.host}
            </a>
          ))}
        </div>
      </section>
        </>
      )}
    </div>
  )
}
