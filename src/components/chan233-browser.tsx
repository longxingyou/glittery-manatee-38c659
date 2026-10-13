import * as React from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  EyeOff,
  File as FileIcon,
  Image as ImageIcon,
  Lock,
  MessageSquare,
  Pin,
  RefreshCw,
  Search,
  Star,
  X,
} from 'lucide-react'

import { useT } from '@/lib/i18n'
import type { VBoardGroup, VPost, VThread, VThreadCard } from '@/lib/chan233-server'

/**
 * 233chan（里岛匿名版）只读浏览器 —— /admin/c233。
 *
 * 与 X 岛浏览器同源的交互范式：
 * - 版面快选（分组网格 + 搜索）→ 串列表（catalog 卡片流）→ 串内阅读（Po 强调 + 低噪楼层）
 * - 综合时间线：25 版聚合最近活跃串，同视图输入关键词即全站搜索
 * - 收藏 / 最近浏览（localStorage，仅本机）
 * - 返回不刷新：内存缓存视图数据与滚动位置；刷新按钮强制绕过缓存
 * - 引用链接（>>123）本串直接定位高亮，跨串弹预览浮层可跳转；
 * - 串内搜索 / 楼号跳转；图片灯箱、视频/音频内联播放、NSFW 版面缩略图默认模糊
 * - 数据经 /api/c233（网关优先代理 vichan JSON），站点源站不稳定由网关兜底
 */

const API = '/api/c233'
const NSFW_KEY = 'sg.c233.nsfw.reveal'
const FAV_KEY = 'sg.c233.favs'
const HIST_KEY = 'sg.c233.history'
const BLOCK_KEY = 'sg.c233.blocked'
/** catalog / 时间线分批渲染步长（kotori 340 / int 690 张卡全量渲染会卡） */
const BATCH = 40

type View =
  | { kind: 'boards' }
  | { kind: 'timeline'; focus?: boolean }
  | { kind: 'catalog'; board: string; title: string; nsfw: boolean }
  | { kind: 'thread'; board: string; tid: number }

function viewKey(v: View): string {
  if (v.kind === 'boards') return 'boards'
  if (v.kind === 'timeline') return 'timeline'
  if (v.kind === 'catalog') return `catalog:${v.board}`
  return `thread:${v.board}:${v.tid}`
}

interface VTimelinePayload {
  cards: VThreadCard[]
  partial: string[]
}

interface ViewPayload {
  groups?: VBoardGroup[]
  cards?: VThreadCard[]
  thread?: VThread
  timeline?: VTimelinePayload
  error?: string
}

// ── 收藏 / 浏览历史（localStorage，仅本机）──
interface MineItem {
  board: string
  tid: number
  title: string
  at: number
}

function readMine(key: string): MineItem[] {
  try {
    const raw = localStorage.getItem(key)
    const arr: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (x): x is MineItem =>
        !!x && typeof x === 'object' && typeof (x as MineItem).board === 'string' && typeof (x as MineItem).tid === 'number',
    )
  } catch {
    return []
  }
}
function writeMine(key: string, list: MineItem[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* 隐私模式 */
  }
}

// ── 屏蔽名单（完整匹配，两端空白归一；命中即不再呈现）──
// BLOCK_KEY=用户名字（站方昵称随机化，跨串同名才有效）；
// BLOCK_ID_KEY=8 位饼干 ID（每日轮换、同 IP 当日同 ID，屏蔽当日有效）
const BLOCK_ID_KEY = 'sg.c233.blockedIds'
function readBlocked(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const arr: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
  } catch {
    return []
  }
}
function writeBlocked(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* 隐私模式 */
  }
}

async function cget(params: Record<string, string>, bypassCache = false): Promise<any> {
  const u = new URL(API, window.location.origin)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  const res = await fetch(u, { credentials: 'same-origin', cache: bypassCache ? 'reload' : 'default' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── 附件地址（与 chan233-server 的路径规则一致；前端只拼 URL 不引服务端模块）──
const thumbSrc = (board: string, tim?: string, ext?: string) =>
  tim && ext ? `${API}?action=img&kind=thumb&p=${encodeURIComponent(`${board}/thumb/${tim}.png`)}` : ''
const fullSrc = (board: string, tim?: string, ext?: string) =>
  tim && ext ? `${API}?action=img&kind=src&p=${encodeURIComponent(`${board}/src/${tim}${ext}`)}` : ''
const flagSrc = (code?: string) =>
  code && /^[\w]{1,12}$/.test(code)
    ? `${API}?action=img&kind=flag&p=${encodeURIComponent(`assets/countryballs/${code.toLowerCase()}.png`)}`
    : ''

const IMG_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
const VIDEO_EXT = ['.mp4', '.webm']
const AUDIO_EXT = ['.mp3', '.ogg']

/** 8 位饼干 ID → 稳定色相（同 ID 同色，跨刷新一致） */
function idHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

function fmtTime(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${sameYear ? '' : `${d.getFullYear()}-`}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtSize(bytes: number | undefined): string {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

/** 标题：有 sub 用 sub，否则取正文纯文本前 40 字 */
function cardTitle(p: VPost): string {
  if (p.sub) return p.sub
  const txt = (p.com || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;&gt;\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return txt.slice(0, 40) || `No.${p.no}`
}

export function Chan233Browser() {
  const t = useT()
  const [stack, setStack] = React.useState<View[]>([{ kind: 'boards' }])
  const top = stack[stack.length - 1]
  const key = viewKey(top)

  const [payload, setPayload] = React.useState<ViewPayload>({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  // 返回不刷新：视图数据 + 滚动位置内存缓存
  const cacheRef = React.useRef(new Map<string, ViewPayload & { scrollY?: number }>())
  const saveScroll = React.useCallback(() => {
    const k = viewKey(stack[stack.length - 1])
    const hit = cacheRef.current.get(k)
    if (hit) hit.scrollY = window.scrollY
  }, [stack])
  const push = (v: View) => {
    saveScroll()
    setStack((s) => [...s, v])
  }
  const pop = () => {
    if (stack.length > 1) setStack((s) => s.slice(0, -1))
  }

  // NSFW 缩略图模糊（会话级总开关 + 单卡揭示）；SSR 无 localStorage，挂载后再回填
  const [revealAll, setRevealAll] = React.useState(false)
  React.useEffect(() => {
    try { setRevealAll(localStorage.getItem(NSFW_KEY) === '1') } catch { /* 隐私模式 */ }
  }, [])
  const [revealed, setRevealed] = React.useState<React.Key[]>([])
  const toggleRevealAll = () => {
    const next = !revealAll
    setRevealAll(next)
    try { localStorage.setItem(NSFW_KEY, next ? '1' : '0') } catch { /* 隐私模式 */ }
    if (!next) setRevealed([])
  }
  const reveal = (no: React.Key) => setRevealed((r) => [...r, no])
  const isHidden = (boardNsfw: boolean, no: React.Key) => boardNsfw && !revealAll && !revealed.includes(no)

  // ── 收藏 / 最近浏览（localStorage，仅本机；挂载后回填防 SSR 崩溃）──
  const [favs, setFavs] = React.useState<MineItem[]>([])
  const [history, setHistory] = React.useState<MineItem[]>([])
  React.useEffect(() => {
    setFavs(readMine(FAV_KEY))
    setHistory(readMine(HIST_KEY))
  }, [])
  const isFav = (board: string, tid: number) => favs.some((f) => f.board === board && f.tid === tid)
  const toggleFav = () => {
    if (top.kind !== 'thread') return
    const { board, tid } = top
    const next = isFav(board, tid)
      ? favs.filter((f) => !(f.board === board && f.tid === tid))
      : [{ board, tid, title: payload.thread ? cardTitle(payload.thread.op) : `No.${tid}`, at: Date.now() }, ...favs].slice(0, 100)
    setFavs(next)
    writeMine(FAV_KEY, next)
  }
  const delFav = (board: string, tid: number) => {
    const next = favs.filter((f) => !(f.board === board && f.tid === tid))
    setFavs(next)
    writeMine(FAV_KEY, next)
  }
  const clearHistory = () => {
    setHistory([])
    writeMine(HIST_KEY, [])
  }

  // ── 屏蔽名单（点名字/ID 徽章弹层确认；串列表/时间线/串内统一过滤）──
  const [blocked, setBlocked] = React.useState<string[]>([])
  const [blockedIds, setBlockedIds] = React.useState<string[]>([])
  React.useEffect(() => {
    setBlocked(readBlocked(BLOCK_KEY))
    setBlockedIds(readBlocked(BLOCK_ID_KEY))
  }, [])
  const [namePop, setNamePop] = React.useState<{ name: string; x: number; y: number } | null>(null)
  const [idPop, setIdPop] = React.useState<{ id: string; x: number; y: number } | null>(null)
  const isBlocked = React.useCallback((name?: string) => !!name && blocked.includes(name.trim()), [blocked])
  const isBlockedId = React.useCallback((id?: string) => !!id && blockedIds.includes(id), [blockedIds])
  /** 帖子级判定：名字或 ID 任一命中即隐藏 */
  const isHiddenPost = React.useCallback((p: VPost) => isBlocked(p.name) || isBlockedId(p.id), [isBlocked, isBlockedId])
  const blockName = (name: string) => {
    const n = name.trim()
    if (!n || blocked.includes(n)) return
    const next = [...blocked, n]
    setBlocked(next)
    writeBlocked(BLOCK_KEY, next)
  }
  const unblockName = (name: string) => {
    const next = blocked.filter((b) => b !== name)
    setBlocked(next)
    writeBlocked(BLOCK_KEY, next)
  }
  const blockId = (id: string) => {
    if (!id || blockedIds.includes(id)) return
    const next = [...blockedIds, id]
    setBlockedIds(next)
    writeBlocked(BLOCK_ID_KEY, next)
  }
  const unblockId = (id: string) => {
    const next = blockedIds.filter((b) => b !== id)
    setBlockedIds(next)
    writeBlocked(BLOCK_ID_KEY, next)
  }
  const onNameClick = (name: string, x: number, y: number) => {
    const n = name.trim()
    if (n) setNamePop({ name: n, x, y })
  }
  const onIdClick = (id: string, x: number, y: number) => {
    if (id) setIdPop({ id, x, y })
  }

  // 引用预览浮层 + 跨串定位 + 串内高亮 + 灯箱
  const [preview, setPreview] = React.useState<{ post: VPost; tid: number; x: number; y: number } | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [pendingLocate, setPendingLocate] = React.useState<{ tid: number; no: number } | null>(null)
  const [hitNo, setHitNo] = React.useState<number | null>(null)
  const [box, setBox] = React.useState<{ src: string; name?: string; dim?: string } | null>(null)

  // 楼层定位（引用跳转 / 串内搜索共用）：高亮 + 滚动居中 + 2.6s 后消退
  const locate = React.useCallback((no: number) => {
    setHitNo(no)
    setTimeout(() => {
      document.getElementById(`v-post-${no}`)?.scrollIntoView({ block: 'center' })
      setTimeout(() => setHitNo((h) => (h === no ? null : h)), 2600)
    }, 60)
  }, [])

  // ── 数据加载（缓存命中直接回放，绕过则重新拉取）──
  const load = React.useCallback(async (view: View, bypass: boolean) => {
    const k = viewKey(view)
    setLoading(true)
    setError('')
    try {
      let next: ViewPayload = {}
      if (view.kind === 'boards') next = await cget({ action: 'boards' }, bypass)
      else if (view.kind === 'timeline') next = { timeline: await cget({ action: 'timeline' }, bypass) }
      else if (view.kind === 'catalog') next = await cget({ action: 'catalog', board: view.board }, bypass)
      else next = await cget({ action: 'thread', board: view.board, id: String(view.tid) }, bypass)
      cacheRef.current.set(k, next)
      setPayload(next)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '加载失败'
      setError(msg)
      setPayload({})
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    const hit = cacheRef.current.get(key)
    setPreview(null)
    setBox(null)
    setNamePop(null)
    setIdPop(null)
    if (hit && (hit.cards || hit.thread || hit.groups || hit.timeline || hit.error)) {
      setPayload(hit)
      setError(hit.error || '')
      requestAnimationFrame(() => window.scrollTo({ top: hit.scrollY || 0 }))
      return
    }
    setPayload({})
    setRevealed([])
    setHitNo(null)
    load(top, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // 串加载完成 → 记录浏览历史（去重置顶，截 50 条；StrictMode 双调用幂等无害）
  React.useEffect(() => {
    if (top.kind !== 'thread' || !payload.thread) return
    const item: MineItem = { board: top.board, tid: top.tid, title: cardTitle(payload.thread.op), at: Date.now() }
    setHistory((prev) => {
      const next = [item, ...prev.filter((h) => !(h.board === item.board && h.tid === item.tid))].slice(0, 50)
      writeMine(HIST_KEY, next)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, payload.thread])

  // 跨串跳转后的楼层定位
  React.useEffect(() => {
    if (!pendingLocate || top.kind !== 'thread' || top.tid !== pendingLocate.tid || loading) return
    const no = pendingLocate.no
    setPendingLocate(null)
    if (no) locate(no)
  }, [pendingLocate, top, loading, locate])

  // Esc 关闭浮层/灯箱
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setPreview(null)
      setBox(null)
      setNamePop(null)
      setIdPop(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── 引用链接（v:ref:<no>@<tid>）：本串定位，跨串取目标串弹预览 ──
  const onContentClick = async (e: React.MouseEvent, current: VThread | undefined) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    const m = /^v:ref:(\d+)@(\d+)$/.exec(href)
    if (!m) return // 外链走原生 target=_blank
    e.preventDefault()
    const no = Number(m[1])
    const tid = Number(m[2])
    if (!no) return
    if (current && current.posts.some((p) => p.no === no)) {
      setPreview(null)
      locate(no)
      return
    }
    if (top.kind !== 'thread') return
    setPreviewLoading(true)
    try {
      const data = await cget({ action: 'thread', board: top.board, id: String(tid) })
      const post = (data.thread?.posts || []).find((p: VPost) => p.no === no)
      setPreview({ post: post || { no, resto: tid, name: t('c233.postNotFound') }, tid, x: e.clientX, y: e.clientY })
    } catch {
      setPreview({ post: { no, resto: tid, name: t('c233.postNotFound') }, tid, x: e.clientX, y: e.clientY })
    } finally {
      setPreviewLoading(false)
    }
  }

  const openPreviewThread = (tid: number, no: number) => {
    if (top.kind !== 'thread') return
    setPreview(null)
    setPendingLocate({ tid, no })
    push({ kind: 'thread', board: top.board, tid })
  }

  const crumb =
    top.kind === 'boards'
      ? t('c233.title')
      : top.kind === 'timeline'
        ? t('c233.timeline')
        : top.kind === 'catalog'
          ? top.title
          : `No.${top.tid}`

  // 时间线卡片点版面 chip → 进对应版面（标题/NSFW 从缓存的版面表解析）
  const openBoardById = (id: string) => {
    const groups = cacheRef.current.get('boards')?.groups || []
    let title = id
    let nsfw = false
    for (const g of groups) {
      for (const b of g.boards) {
        if (b.id === id) {
          title = b.title
          nsfw = !!b.nsfw
        }
      }
    }
    push({ kind: 'catalog', board: id, title, nsfw })
  }
  const boardNsfw = top.kind === 'catalog' ? top.nsfw : false

  return (
    <div className="c233-app">
      {/* 顶栏 */}
      <div className="v-topbar">
        {stack.length > 1 && (
          <button type="button" className="btn x-icon-btn" onClick={pop} aria-label={t('c233.back')}>
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="v-crumb">{crumb}</div>
        {boardNsfw && (
          <button
            type="button"
            className="btn x-icon-btn"
            onClick={toggleRevealAll}
            aria-label={revealAll ? t('c233.hide') : t('c233.revealAll')}
            title={revealAll ? t('c233.hide') : t('c233.revealAll')}
          >
            {revealAll ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
        {top.kind === 'thread' && (
          <button
            type="button"
            className={`btn x-icon-btn${isFav(top.board, top.tid) ? ' v-fav-on' : ''}`}
            onClick={toggleFav}
            aria-label={isFav(top.board, top.tid) ? t('c233.unfav') : t('c233.fav')}
            title={isFav(top.board, top.tid) ? t('c233.unfav') : t('c233.fav')}
          >
            <Star size={16} />
          </button>
        )}
        <button
          type="button"
          className="btn x-icon-btn"
          onClick={() => {
            setRevealed([])
            load(top, true)
          }}
          disabled={loading}
          aria-label={t('c233.refresh')}
        >
          <RefreshCw size={16} className={loading ? 'v-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="v-error">
          {error}
          <div>
            <button type="button" className="btn" onClick={() => load(top, true)}>
              {t('c233.retry')}
            </button>
          </div>
        </div>
      )}
      {loading && !payload.cards && !payload.thread && !payload.groups && !payload.timeline && (
        <div className="v-loading">{t('c233.loading')}</div>
      )}

      {/* 版面选择 */}
      {top.kind === 'boards' && (
        <BoardsView
          groups={payload.groups || []}
          onPick={(b) => push({ kind: 'catalog', board: b.id, title: b.title, nsfw: !!b.nsfw })}
          onTimeline={() => push({ kind: 'timeline' })}
          onSearchAll={() => push({ kind: 'timeline', focus: true })}
          favs={favs}
          history={history}
          onOpenMine={(it) => push({ kind: 'thread', board: it.board, tid: it.tid })}
          onDelFav={delFav}
          onClearHistory={clearHistory}
          blocked={blocked}
          blockedIds={blockedIds}
          onUnblock={unblockName}
          onUnblockId={unblockId}
        />
      )}

      {/* 综合时间线 / 全站搜索 */}
      {top.kind === 'timeline' && (
        <TimelineView
          key={top.focus ? 'timeline-focus' : 'timeline'}
          data={payload.timeline}
          loading={loading}
          autoFocus={!!top.focus}
          onOpen={(board, tid) => push({ kind: 'thread', board, tid })}
          onOpenBoard={openBoardById}
          onBox={setBox}
          isHiddenPost={isHiddenPost}
          onNameClick={onNameClick}
          onIdClick={onIdClick}
        />
      )}

      {/* 串列表 */}
      {top.kind === 'catalog' && (
        <CatalogView
          key={key}
          board={top.board}
          cards={payload.cards || (loading ? undefined : [])}
          nsfw={top.nsfw}
          isHidden={(no) => isHidden(top.nsfw, no)}
          onReveal={reveal}
          onOpen={(tid) => push({ kind: 'thread', board: top.board, tid })}
          onBox={setBox}
          isHiddenPost={isHiddenPost}
          onNameClick={onNameClick}
          onIdClick={onIdClick}
        />
      )}

      {/* 串内阅读 */}
      {top.kind === 'thread' && (
        <ThreadView
          key={key}
          board={top.board}
          thread={payload.thread}
          loading={loading}
          hitNo={hitNo}
          onContentClick={onContentClick}
          onBox={setBox}
          onLocate={locate}
          isHiddenPost={isHiddenPost}
          onNameClick={onNameClick}
          onIdClick={onIdClick}
        />
      )}

      {/* 名字弹层：点任意用户名字 → 屏蔽/取消屏蔽（完整匹配） */}
      {namePop && (
        <>
          <div className="v-pop-scrim" onClick={() => setNamePop(null)} />
          <div className="v-pop v-namepop" style={{ left: clampX(namePop.x), top: clampY(namePop.y) }} onClick={(e) => e.stopPropagation()}>
            <div className="v-post-head">
              <span className="v-name">{namePop.name}</span>
            </div>
            <button
              type="button"
              className="btn v-block-btn"
              onClick={() => {
                if (isBlocked(namePop.name)) unblockName(namePop.name)
                else blockName(namePop.name)
                setNamePop(null)
              }}
            >
              {isBlocked(namePop.name) ? t('c233.unblockName') : t('c233.block')}
            </button>
          </div>
        </>
      )}

      {/* ID 弹层：点 ID 徽章 → 屏蔽该 ID（当日有效，ID 每日轮换） */}
      {idPop && (
        <>
          <div className="v-pop-scrim" onClick={() => setIdPop(null)} />
          <div className="v-pop v-namepop" style={{ left: clampX(idPop.x), top: clampY(idPop.y) }} onClick={(e) => e.stopPropagation()}>
            <div className="v-post-head">
              <PostIdChip id={idPop.id} />
            </div>
            <div className="v-idpop-note">{t('c233.idDailyNote')}</div>
            <button
              type="button"
              className="btn v-block-btn"
              onClick={() => {
                if (isBlockedId(idPop.id)) unblockId(idPop.id)
                else blockId(idPop.id)
                setIdPop(null)
              }}
            >
              {isBlockedId(idPop.id) ? t('c233.unblockName') : t('c233.blockId')}
            </button>
          </div>
        </>
      )}

      {/* 引用预览浮层（点击进所在串并定位） */}
      {preview && top.kind === 'thread' && (
        <div className="v-pop" style={{ left: clampX(preview.x), top: clampY(preview.y) }} onClick={(e) => { e.stopPropagation(); openPreviewThread(preview.tid, preview.post.no) }}>
          <div className="v-post-head">
            <span className="v-name">{preview.post.name}</span>
            {preview.post.trip && <span className="v-trip">{preview.post.trip}</span>}
            <PostFlag post={preview.post} />
            <PostIdChip id={preview.post.id} />
            <span className="v-no">No.{preview.post.no}</span>
            <span className="v-pop-hint">{t('c233.openThread')}</span>
          </div>
          <div className="v-content" dangerouslySetInnerHTML={{ __html: preview.post.com || '' }} />
        </div>
      )}
      {previewLoading && <div className="v-pop-loading">{t('c233.quoteLoading')}</div>}

      {/* 灯箱 / 播放器 */}
      {box && (
        <div className="v-lightbox" onClick={() => setBox(null)}>
          <div className="v-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="v-lightbox-close" onClick={() => setBox(null)} aria-label="close">
              <X size={18} />
            </button>
            {/\.(?:mp4|webm)$/i.test(box.src) ? (
              <video src={box.src} controls autoPlay style={{ maxWidth: '94vw', maxHeight: '84vh' }} />
            ) : /\.(?:mp3|ogg)$/i.test(box.src) ? (
              <audio src={box.src} controls autoPlay style={{ width: 'min(480px, 90vw)' }} />
            ) : (
              <img src={box.src} alt={box.name || ''} style={{ maxWidth: '94vw', maxHeight: '84vh' }} />
            )}
            {box.name && <div className="v-lightbox-cap">{box.name}{box.dim ? ` · ${box.dim}` : ''}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function clampX(x: number): number {
  const w = window.innerWidth
  const width = w <= 640 ? 0 : 340
  return Math.min(Math.max(8, x - 40), Math.max(8, w - width - 8))
}
function clampY(y: number): number {
  return Math.min(Math.max(60, y + 10), window.innerHeight - 80)
}

// ───────────────────────── 版面选择 ─────────────────────────

function BoardsView({
  groups,
  onPick,
  onTimeline,
  onSearchAll,
  favs,
  history,
  onOpenMine,
  onDelFav,
  onClearHistory,
  blocked,
  blockedIds,
  onUnblock,
  onUnblockId,
}: {
  groups: VBoardGroup[]
  onPick: (b: { id: string; title: string; nsfw?: boolean }) => void
  onTimeline: () => void
  onSearchAll: () => void
  favs: MineItem[]
  history: MineItem[]
  onOpenMine: (it: MineItem) => void
  onDelFav: (board: string, tid: number) => void
  onClearHistory: () => void
  blocked: string[]
  onUnblock: (name: string) => void
  blockedIds: string[]
  onUnblockId: (id: string) => void
}) {
  const t = useT()
  const [q, setQ] = React.useState('')
  const needle = q.trim().toLowerCase()
  const match = (id: string, title: string) => !needle || id.toLowerCase().includes(needle) || title.toLowerCase().includes(needle)
  return (
    <div className="v-boards">
      {/* 综合入口：时间线（跨版最近活跃）+ 全站搜索（同视图输入关键词） */}
      <div className="v-home-tools">
        <button type="button" className="btn v-home-tool" onClick={onTimeline}>
          <Clock size={13} /> {t('c233.timeline')}
        </button>
        <button type="button" className="btn v-home-tool" onClick={onSearchAll}>
          <Search size={13} /> {t('c233.searchAll')}
        </button>
      </div>
      {!!favs.length && (
        <div className="v-mine">
          <div className="v-group-name">{t('c233.favs')}</div>
          <div className="v-mine-row">
            {favs.map((f) => (
              <span key={`${f.board}:${f.tid}`} className="v-mine-chip" title={f.title} onClick={() => onOpenMine(f)}>
                <Star size={11} className="v-mine-star" />
                <span className="v-mine-title">{f.title}</span>
                <span className="v-mine-meta">/{f.board}/</span>
                <button
                  type="button"
                  className="v-mine-del"
                  aria-label={t('c233.unfav')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelFav(f.board, f.tid)
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      {!!history.length && (
        <div className="v-mine">
          <div className="v-group-name v-history-head">
            {t('c233.history')}
            <button type="button" className="v-history-clear" onClick={onClearHistory}>
              {t('c233.clearHistory')}
            </button>
          </div>
          <div className="v-mine-row">
            {history.slice(0, 12).map((h) => (
              <span key={`${h.board}:${h.tid}`} className="v-mine-chip" title={h.title} onClick={() => onOpenMine(h)}>
                <span className="v-mine-title">{h.title}</span>
                <span className="v-mine-meta">/{h.board}/</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {!!blocked.length && (
        <div className="v-mine">
          <div className="v-group-name">{t('c233.blocked')}</div>
          <div className="v-mine-row">
            {blocked.map((name) => (
              <span key={name} className="v-mine-chip v-mine-blocked" title={name}>
                <span className="v-mine-title">{name}</span>
                <button type="button" className="v-mine-del" aria-label={t('c233.unblockName')} onClick={() => onUnblock(name)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      {!!blockedIds.length && (
        <div className="v-mine">
          <div className="v-group-name">{t('c233.blockedIds')}</div>
          <div className="v-mine-row">
            {blockedIds.map((id) => (
              <span key={id} className="v-mine-chip v-mine-blocked" title={id}>
                <PostIdChip id={id} />
                <button type="button" className="v-mine-del" aria-label={t('c233.unblockName')} onClick={() => onUnblockId(id)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="v-search">
        <Search size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('c233.searchBoards')} />
      </div>
      {groups.map((g) => {
        const bs = g.boards.filter((b) => match(b.id, b.title))
        if (!bs.length) return null
        return (
          <div className="v-group" key={g.name}>
            <div className="v-group-name">{g.name}</div>
            <div className="v-group-grid">
              {bs.map((b) => (
                <button type="button" key={b.id} className={`v-board-chip${b.nsfw ? ' v-board-nsfw' : ''}`} onClick={() => onPick(b)}>
                  <span className="v-board-title">{b.title}</span>
                  <span className="v-board-slug">/{b.id}/</span>
                  {b.nsfw && <span className="v-nsfw-badge">{t('c233.nsfw')}</span>}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ───────────────────────── 串列表 ─────────────────────────

function CatalogView({
  board,
  cards,
  nsfw,
  isHidden,
  onReveal,
  onOpen,
  onBox,
  isHiddenPost,
  onNameClick,
  onIdClick,
}: {
  board: string
  cards: VThreadCard[] | undefined
  nsfw: boolean
  isHidden: (no: React.Key) => boolean
  onReveal: (no: React.Key) => void
  onOpen: (tid: number) => void
  onBox: (b: { src: string; name?: string; dim?: string } | null) => void
  isHiddenPost: (p: VPost) => boolean
  onNameClick: (name: string, x: number, y: number) => void
  onIdClick: (id: string, x: number, y: number) => void
}) {
  const t = useT()
  const [q, setQ] = React.useState('')
  const [sort, setSort] = React.useState<'last' | 'op'>('last')
  // 分批渲染（int 版 690 张卡全量渲染会卡）：IntersectionObserver 哨兵提前 600px 追加
  const [visible, setVisible] = React.useState(BATCH)
  React.useEffect(() => setVisible(BATCH), [q, sort])
  const sentinelRef = useSentinel(() => setVisible((v) => v + BATCH))
  if (!cards) return null
  const needle = q.trim().toLowerCase()
  // 屏蔽名单：OP 名字/ID 完整匹配即整串不再呈现
  const unblocked = cards.filter((c) => !isHiddenPost(c.op))
  const filtered = needle
    ? unblocked.filter((c) => cardTitle(c.op).toLowerCase().includes(needle) || String(c.tid).includes(needle))
    : unblocked
  const sorted = [...filtered].sort((a, b) => {
    if (a.sticky !== b.sticky) return a.sticky ? -1 : 1
    return sort === 'last' ? b.lastAt - a.lastAt : (b.op.time || 0) - (a.op.time || 0)
  })
  return (
    <div>
      <div className="v-cat-toolbar">
        <div className="v-search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('c233.searchThreads')} />
        </div>
        <div className="v-sort">
          <button type="button" className={`btn v-sortbtn${sort === 'last' ? ' v-sort-on' : ''}`} onClick={() => setSort('last')}>
            {t('c233.sortLast')}
          </button>
          <button type="button" className={`btn v-sortbtn${sort === 'op' ? ' v-sort-on' : ''}`} onClick={() => setSort('op')}>
            {t('c233.sortOp')}
          </button>
        </div>
      </div>
      {!sorted.length && <div className="v-empty">{t('c233.empty')}</div>}
      {sorted.slice(0, visible).map((c) => (
        <CatalogCard
          key={c.tid}
          card={c}
          board={board}
          hidden={isHidden(c.tid)}
          onReveal={() => onReveal(c.tid)}
          onOpen={(cc) => onOpen(cc.tid)}
          onBox={onBox}
          onNameClick={onNameClick}
          onIdClick={onIdClick}
        />
      ))}
      {visible < sorted.length && (
        <div ref={sentinelRef} className="v-sentinel">
          {t('c233.loading')}
        </div>
      )}
      {nsfw && <div className="v-nsfw-note">{t('c233.nsfwNote')}</div>}
    </div>
  )
}

/** IntersectionObserver 哨兵（回调 ref：节点挂载/卸载/替换时自动接/断观察器） */
function useSentinel(onMore: () => void) {
  const cbRef = React.useRef(onMore)
  cbRef.current = onMore
  const obRef = React.useRef<IntersectionObserver | null>(null)
  return React.useCallback((el: HTMLDivElement | null) => {
    obRef.current?.disconnect()
    obRef.current = null
    if (!el) return
    const ob = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) cbRef.current()
      },
      { rootMargin: '600px' },
    )
    ob.observe(el)
    obRef.current = ob
  }, [])
}

function CatalogCard({
  card,
  board,
  hidden,
  onReveal,
  onOpen,
  onBox,
  showBoard,
  onOpenBoard,
  onNameClick,
  onIdClick,
}: {
  card: VThreadCard
  board: string
  hidden: boolean
  onReveal: () => void
  onOpen: (card: VThreadCard) => void
  onBox: (b: { src: string; name?: string; dim?: string } | null) => void
  /** 时间线模式：显示可点击的版面 chip */
  showBoard?: boolean
  onOpenBoard?: (board: string) => void
  onNameClick?: (name: string, x: number, y: number) => void
  onIdClick?: (id: string, x: number, y: number) => void
}) {
  const t = useT()
  // timeline 聚合卡自带 board 字段；catalog 卡回退到当前版面
  const b = card.board || board
  const isImg = !!card.op.ext && IMG_EXT.includes(card.op.ext.toLowerCase())
  const dim =
    card.op.w && card.op.h
      ? `${card.op.w}×${card.op.h} · ${fmtSize(card.op.fsize)}`
      : fmtSize(card.op.fsize)
  return (
    <div className={`panel v-card${card.sticky ? ' v-card-sticky' : ''}`} onClick={() => onOpen(card)}>
      <div className="v-card-row">
        {isImg && card.op.tim && (
          <img
            className={`v-thumb${hidden ? ' v-blur' : ''}`}
            src={thumbSrc(b, card.op.tim, card.op.ext)}
            alt=""
            loading="lazy"
            onClick={(e) => {
              e.stopPropagation()
              if (hidden) {
                onReveal()
                return
              }
              onBox({ src: fullSrc(b, card.op.tim, card.op.ext), name: card.op.filename || undefined, dim })
            }}
          />
        )}
        <div className="v-card-main">
          <div className="v-post-head">
            {card.sticky && (
              <span className="v-badge v-badge-pin">
                <Pin size={10} /> {t('c233.sticky')}
              </span>
            )}
            {card.locked && (
              <span className="v-badge v-badge-lock">
                <Lock size={10} /> {t('c233.locked')}
              </span>
            )}
            <span className="v-card-title">{cardTitle(card.op)}</span>
          </div>
          <div className="v-meta">
            {showBoard && (
              <span
                className="v-boardtag"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenBoard?.(b)
                }}
              >
                /{b}/
              </span>
            )}
            <span
              className={`v-name${onNameClick ? ' v-name-click' : ''}`}
              onClick={
                onNameClick
                  ? (e) => {
                      e.stopPropagation()
                      onNameClick(card.op.name, e.clientX, e.clientY)
                    }
                  : undefined
              }
            >
              {card.op.name}
            </span>
            {card.op.trip && <span className="v-trip">{card.op.trip}</span>}
            <PostFlag post={card.op} />
            <PostIdChip id={card.op.id} onClick={onIdClick} />
            <span className="v-no">No.{card.op.no}</span>
            <span className="v-count">
              <MessageSquare size={11} /> {card.replies}
            </span>
            {!!card.images && (
              <span className="v-count">
                <ImageIcon size={11} /> {card.images}
              </span>
            )}
            <span className="v-time">{fmtTime(card.lastAt)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────── 综合时间线 / 全站搜索 ─────────────────────────

function TimelineView({
  data,
  loading,
  autoFocus,
  onOpen,
  onOpenBoard,
  onBox,
  isHiddenPost,
  onNameClick,
  onIdClick,
}: {
  data: VTimelinePayload | undefined
  loading: boolean
  autoFocus: boolean
  onOpen: (board: string, tid: number) => void
  onOpenBoard: (board: string) => void
  onBox: (b: { src: string; name?: string; dim?: string } | null) => void
  isHiddenPost: (p: VPost) => boolean
  onNameClick: (name: string, x: number, y: number) => void
  onIdClick: (id: string, x: number, y: number) => void
}) {
  const t = useT()
  const [q, setQ] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // 「全站搜索」入口进来时直接聚焦搜索框
  React.useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])
  const [visible, setVisible] = React.useState(BATCH)
  React.useEffect(() => setVisible(BATCH), [q])
  const sentinelRef = useSentinel(() => setVisible((v) => v + BATCH))
  const needle = q.trim().toLowerCase()
  const cards = (data?.cards || []).filter((c) => !isHiddenPost(c.op))
  // 空 = 按最近活跃的时间线；输入 = 全站搜索（标题 / 正文 / 串号 / 版面）
  const filtered = needle
    ? cards.filter((c) => {
        const txt = (c.op.com || '').replace(/<[^>]+>/g, ' ').toLowerCase()
        return (
          cardTitle(c.op).toLowerCase().includes(needle) ||
          txt.includes(needle) ||
          String(c.tid).includes(needle) ||
          (c.board || '').toLowerCase().includes(needle)
        )
      })
    : cards
  return (
    <div>
      <div className="v-cat-toolbar">
        <div className="v-search">
          <Search size={14} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('c233.searchAll')} />
        </div>
      </div>
      {!!data?.partial.length && (
        <div className="v-partial">
          {t('c233.timelinePartial')}: {data.partial.join(' / ')}
        </div>
      )}
      {!loading && !filtered.length && <div className="v-empty">{needle ? t('c233.noHit') : t('c233.empty')}</div>}
      {filtered.slice(0, visible).map((c) => (
        <CatalogCard
          key={`${c.board}:${c.tid}`}
          card={c}
          board={c.board || ''}
          hidden={false}
          onReveal={() => {}}
          onOpen={(cc) => onOpen(cc.board || '', cc.tid)}
          onBox={onBox}
          showBoard
          onOpenBoard={onOpenBoard}
          onNameClick={onNameClick}
          onIdClick={onIdClick}
        />
      ))}
      {visible < filtered.length && (
        <div ref={sentinelRef} className="v-sentinel">
          {t('c233.loading')}
        </div>
      )}
    </div>
  )
}

// ───────────────────────── 串内阅读 ─────────────────────────

function ThreadView({
  board,
  thread,
  loading,
  hitNo,
  onContentClick,
  onBox,
  onLocate,
  isHiddenPost,
  onNameClick,
  onIdClick,
}: {
  board: string
  thread: VThread | undefined
  loading: boolean
  hitNo: number | null
  onContentClick: (e: React.MouseEvent, thread: VThread | undefined) => void
  onBox: (b: { src: string; name?: string; dim?: string } | null) => void
  onLocate: (no: number) => void
  isHiddenPost: (p: VPost) => boolean
  onNameClick: (name: string, x: number, y: number) => void
  onIdClick: (id: string, x: number, y: number) => void
}) {
  const t = useT()
  // ── 串内搜索 / 楼号跳转：纯数字按 No. 前缀匹配（精确命中优先），否则匹配正文/昵称/标题 ──
  const [q, setQ] = React.useState('')
  const [hitIdx, setHitIdx] = React.useState(-1)
  // 屏蔽名单：名字或 ID 完整匹配的楼层不再呈现（搜索跳转同样跳过）
  const visiblePosts = React.useMemo(() => (thread ? thread.posts.filter((p) => !isHiddenPost(p)) : []), [thread, isHiddenPost])
  const hiddenCount = (thread?.posts.length || 0) - visiblePosts.length
  const hits = React.useMemo(() => {
    if (!thread) return [] as number[]
    const needle = q.trim().toLowerCase()
    if (!needle) return [] as number[]
    if (/^\d+$/.test(needle)) {
      const exact: number[] = []
      const prefix: number[] = []
      for (const p of visiblePosts) {
        const s = String(p.no)
        if (s === needle) exact.push(p.no)
        else if (s.startsWith(needle)) prefix.push(p.no)
      }
      return [...exact, ...prefix]
    }
    return visiblePosts
      .filter((p) => {
        const txt = (p.com || '').replace(/<[^>]+>/g, ' ').toLowerCase()
        return txt.includes(needle) || (p.name || '').toLowerCase().includes(needle) || (p.sub || '').toLowerCase().includes(needle)
      })
      .map((p) => p.no)
  }, [q, thread, visiblePosts])
  React.useEffect(() => setHitIdx(-1), [hits])
  const jump = (dir: 1 | -1) => {
    if (!hits.length) return
    const next = hitIdx < 0 ? (dir === 1 ? 0 : hits.length - 1) : (hitIdx + dir + hits.length) % hits.length
    setHitIdx(next)
    onLocate(hits[next])
  }
  if (!thread) return loading ? null : <div className="v-empty">{t('c233.empty')}</div>
  const poId = thread.op.id
  return (
    <div className="v-thread">
      <div className="v-thread-tools">
        <div className="v-search">
          <Search size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('c233.searchInThread')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') jump(1)
            }}
          />
        </div>
        {!!q.trim() && (
          <span className={`v-hits${hits.length ? '' : ' v-hits-none'}`}>
            {hits.length ? `${Math.max(hitIdx, 0) + 1}/${hits.length}` : t('c233.noHit')}
          </span>
        )}
        <button type="button" className="btn x-icon-btn" disabled={!hits.length} onClick={() => jump(-1)} aria-label="↑">
          <ChevronUp size={15} />
        </button>
        <button type="button" className="btn x-icon-btn" disabled={!hits.length} onClick={() => jump(1)} aria-label="↓">
          <ChevronDown size={15} />
        </button>
      </div>
      {hiddenCount > 0 && <div className="v-hidden-note">{t('c233.hiddenPosts', { n: hiddenCount })}</div>}
      {visiblePosts.map((p) => (
        <PostCard key={p.no} post={p} board={board} isOp={p.no === thread.op.no} poId={poId} hit={hitNo === p.no} thread={thread} onContentClick={onContentClick} onBox={onBox} onNameClick={onNameClick} onIdClick={onIdClick} />
      ))}
    </div>
  )
}

function PostCard({
  post,
  board,
  isOp,
  poId,
  hit,
  thread,
  onContentClick,
  onBox,
  onNameClick,
  onIdClick,
}: {
  post: VPost
  board: string
  isOp: boolean
  poId?: string
  hit: boolean
  thread: VThread
  onContentClick: (e: React.MouseEvent, thread: VThread | undefined) => void
  onBox: (b: { src: string; name?: string; dim?: string } | null) => void
  onNameClick?: (name: string, x: number, y: number) => void
  onIdClick?: (id: string, x: number, y: number) => void
}) {
  const isImg = !!post.ext && IMG_EXT.includes(post.ext.toLowerCase())
  const isVideo = !!post.ext && VIDEO_EXT.includes(post.ext.toLowerCase())
  const isAudio = !!post.ext && AUDIO_EXT.includes(post.ext.toLowerCase())
  const sameId = !isOp && !!poId && !!post.id && post.id === poId
  const su = fullSrc(board, post.tim, post.ext)
  return (
    <div id={`v-post-${post.no}`} className={`panel v-post${isOp ? ' v-op' : ''}${hit ? ' v-hit' : ''}`}>
      <div className="v-post-head">
        {isOp && <span className="v-badge v-badge-op">Po</span>}
        {sameId && <span className="v-badge v-badge-sameid">同ID</span>}
        {post.sticky && <span className="v-badge v-badge-pin"><Pin size={10} /></span>}
        {post.locked && <span className="v-badge v-badge-lock"><Lock size={10} /></span>}
        <span
          className={`v-name${onNameClick ? ' v-name-click' : ''}`}
          onClick={
            onNameClick
              ? (e) => {
                  e.stopPropagation()
                  onNameClick(post.name, e.clientX, e.clientY)
                }
              : undefined
          }
        >
          {post.name}
        </span>
        {post.trip && <span className="v-trip">{post.trip}</span>}
        <PostFlag post={post} />
        <PostIdChip id={post.id} onClick={onIdClick} />
        <span className="v-no">No.{post.no}</span>
        <span className="v-time">{fmtTime(post.time)}</span>
      </div>
      <div className="v-content" onClick={(e) => onContentClick(e, thread)} dangerouslySetInnerHTML={{ __html: post.com || '' }} />
      {!!post.tim && !!post.ext && (
        <div className="v-att">
          {isImg && (
            <img
              className="v-att-img"
              src={thumbSrc(board, post.tim, post.ext) || su}
              alt={post.filename || ''}
              loading="lazy"
              onClick={() =>
                onBox({
                  src: su,
                  name: post.filename || undefined,
                  dim: post.w && post.h ? `${post.w}×${post.h} · ${fmtSize(post.fsize)}` : fmtSize(post.fsize),
                })
              }
            />
          )}
          {isVideo && <video className="v-att-media" src={su} controls preload="metadata" />}
          {isAudio && <audio className="v-att-media" src={su} controls preload="metadata" />}
          {!isImg && !isVideo && !isAudio && (
            <a className="v-file" href={su} target="_blank" rel="noopener noreferrer">
              <FileIcon size={13} /> {post.filename}
              {post.ext} · {fmtSize(post.fsize)}
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function PostFlag({ post }: { post: VPost }) {
  const fu = flagSrc(post.country)
  if (!fu) return null
  return <img className="v-flag" src={fu} alt={post.country_name || post.country || ''} title={post.country_name || post.country || ''} loading="lazy" />
}

function PostIdChip({ id, onClick }: { id?: string; onClick?: (id: string, x: number, y: number) => void }) {
  if (!id) return null
  return (
    <span
      className={`v-idchip${onClick ? ' v-name-click' : ''}`}
      style={{ background: `hsl(${idHue(id)} 48% 40%)` }}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation()
              onClick(id, e.clientX, e.clientY)
            }
          : undefined
      }
    >
      {id}
    </span>
  )
}
