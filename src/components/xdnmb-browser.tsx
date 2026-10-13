import * as React from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Crosshair,
  Dices,
  Download,
  Eye,
  EyeOff,
  FileImage,
  Flag,
  Flame,
  History,
  Image as ImageIcon,
  ImagePlus,
  Maximize2,
  MessageSquare,
  Minimize2,
  Quote,
  RefreshCw,
  ScanLine,
  ScrollText,
  Search,
  Send,
  Settings,
  Smile,
  Star,
  StarOff,
  Sticker,
  Trash2,
  User,
  X,
} from 'lucide-react'

import { useT } from '@/lib/i18n'
import type { XForum, XForumGroup, XPost, XTimeline } from '@/lib/xdnmb-types'
import {
  KAOMOJI_GROUPS,
  SNIPPETS,
  STICKER_GROUPS,
  stickerSrc,
} from '@/lib/xdnmb-composer-assets'
import type { XSticker } from '@/lib/xdnmb-composer-assets'

const API = '/api/xdnmb'
const PAGE_SIZE = 19
const FEED_PAGE_SIZE = 10
const MYPOSTS_PAGE_SIZE = 30
const IMMERSIVE_KEY = 'sg.xdnmb.immersive'
const DRAWER_KEY = 'sg.xdnmb.drawer.collapsed'

async function xget(params: Record<string, string>, bypassCache = false): Promise<any> {
  const u = new URL(API, window.location.origin)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  const res = await fetch(u, {
    credentials: 'same-origin',
    cache: bypassCache ? 'reload' : 'default',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
async function xpost(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(API, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
/** 发串/回复：multipart 提交（可带图片附件），不要手动设 Content-Type（boundary 由浏览器生成） */
async function xsubmit(form: FormData): Promise<any> {
  const res = await fetch(API, { method: 'POST', credentials: 'same-origin', body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function thumb(p: XPost): string {
  return p.img && p.ext ? `/api/xdnmb?action=img&kind=thumb&p=${encodeURIComponent(p.img + p.ext)}` : ''
}
function fullImg(p: XPost): string {
  return p.img && p.ext ? `/api/xdnmb?action=img&kind=image&p=${encodeURIComponent(p.img + p.ext)}` : ''
}
/** 标题：有标题用标题，否则取正文纯文本前 30 字 */
function postTitle(p: XPost): string {
  if (p.title && p.title !== '无标题') return p.title
  const txt = p.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return txt.slice(0, 30) || `No.${p.id}`
}

/** 引用楼层缓存：同一轮浏览内重复点同一引用零请求 */
const refCache = new Map<string, XPost>()

type View =
  | { kind: 'forum'; fid: string; name: string; page: number }
  | { kind: 'timeline'; tid: string; name: string; page: number }
  | { kind: 'thread'; id: string; page: number }
  | { kind: 'favs' }
  | { kind: 'subs'; page: number }
  | { kind: 'myposts'; page: number }

function viewKey(v: View): string {
  switch (v.kind) {
    case 'forum': return `forum:${v.fid}:p${v.page}`
    case 'timeline': return `timeline:${v.tid}:p${v.page}`
    case 'thread': return `thread:${v.id}:p${v.page}`
    case 'subs': return `subs:p${v.page}`
    case 'myposts': return `myposts:p${v.page}`
    default: return v.kind
  }
}
function sameView(a: View | null, b: View): boolean {
  if (!a || a.kind !== b.kind) return false
  if (a.kind === 'forum' && b.kind === 'forum') return a.fid === b.fid && a.page === b.page
  if (a.kind === 'timeline' && b.kind === 'timeline') return a.tid === b.tid && a.page === b.page
  if (a.kind === 'thread' && b.kind === 'thread') return a.id === b.id && a.page === b.page
  if (a.kind === 'subs' && b.kind === 'subs') return a.page === b.page
  if (a.kind === 'myposts' && b.kind === 'myposts') return a.page === b.page
  return true
}

type CacheEntry = { posts?: XPost[] | null; thread?: XPost | null }

/** "我的发言"条目（与后端 XdnmbMyPostInfo 对应） */
type MyPost = {
  id: number
  tid: number
  fid: number | null
  isPo: boolean
  threadTitle: string
  content: string
  img: string
  ext: string
  now: string
  userHash: string
  seenAt: string
}

/** 引用弹层定位描述 */
type RefSpec = { kind: 'ref' | 'thread'; id: string; x: number; y: number }

export function XdnmbBrowser() {
  const t = useT()
  const [groups, setGroups] = React.useState<XForumGroup[] | null>(null)
  const [timelines, setTimelines] = React.useState<XTimeline[] | null>(null)
  // 导航栈：末位为当前视图，返回即弹栈
  const [stack, setStack] = React.useState<View[]>([])
  const view = stack[stack.length - 1] ?? null
  const [posts, setPosts] = React.useState<XPost[] | null>(null)
  const [thread, setThread] = React.useState<XPost | null>(null)
  const [tracked, setTracked] = React.useState<{ favs: XdnmbTrack[]; subs: XdnmbTrack[] }>({ favs: [], subs: [] })
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [lightbox, setLightbox] = React.useState('')
  const [toast, setToast] = React.useState('')
  const [reloadKey, setReloadKey] = React.useState(0)
  const [immersive, setImmersive] = React.useState(false)
  const [refSpec, setRefSpec] = React.useState<RefSpec | null>(null)
  // 举报流程：先选理由（reason=null），再打开预填的值班室发串编辑器
  const [report, setReport] = React.useState<{ id: number; reason: ReportReason | null } | null>(null)
  // 搜索浮层：query=输入词，items=结果，loading=请求中，err=错误
  const [search, setSearch] = React.useState<{ open: boolean; query: string; items: SearchItem[]; loading: boolean; err: string }>({
    open: false, query: '', items: [], loading: false, err: '',
  })
  // 饼干是否已绑定（设置按钮上的状态点；值在设置保存后刷新）
  const [hasCookie, setHasCookie] = React.useState<boolean | null>(null)
  // 已绑定饼干的明文 user_hash（7 位 ID，用于"我的发言"被动采集与楼内高亮）
  const cookieHashRef = React.useRef('')
  // 全部已知饼干显示名集合（多饼干时都能命中"我的发言"采集）
  const cookieNamesRef = React.useRef<Set<string>>(new Set())
  // "我的发言"列表（独立于串/版面缓存）
  const [myPosts, setMyPosts] = React.useState<MyPost[] | null>(null)
  const [myTotal, setMyTotal] = React.useState(0)
  // 已上报过"我的发言"的楼层键（每页视图最多上报一次，避免重复请求）
  const reportedRef = React.useRef(new Set<string>())

  // 会话内视图数据缓存（返回不刷新）与各视图滚动位置
  const dataCache = React.useRef(new Map<string, CacheEntry>())
  const scrollMap = React.useRef(new Map<string, number>())
  // 跨页定位成功后待滚动到的楼号
  const pendingAnchor = React.useRef<number | null>(null)
  // 定位时附带的高亮关键词（搜索进入时传入，随 flashReply 消费一次）
  const pendingHitQ = React.useRef<string | undefined>(undefined)
  // 当前定位高亮（卡片 + 关键词标记），由浮动条手动关闭
  const [hit, setHit] = React.useState<{ id: number; q?: string } | null>(null)
  const prevReload = React.useRef(0)

  React.useEffect(() => {
    try { setImmersive(localStorage.getItem(IMMERSIVE_KEY) === '1') } catch { /* 隐私模式 */ }
  }, [])
  const toggleImmersive = React.useCallback(() => {
    setImmersive((v) => {
      const n = !v
      try { localStorage.setItem(IMMERSIVE_KEY, n ? '1' : '0') } catch { /* ignore */ }
      return n
    })
  }, [])

  // 沉浸模式：除本组件顶栏外，把外层 admin 工作台（侧栏+顶栏）一并隐藏，彻底防误触。
  // 通过 body class 实现（AdminLayout 是父组件，这里够不到），离开时务必还原。
  React.useEffect(() => {
    if (typeof document === 'undefined') return
    document.body.classList.toggle('sg-xdnmb-imm', immersive)
    return () => document.body.classList.remove('sg-xdnmb-imm')
  }, [immersive])

  // 全局快捷键：Ctrl/Cmd+K 打开搜索（command palette 惯例）
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearch((s) => ({ ...s, open: !s.open }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 身份集合变化（换饼干/加饼干/改显示名）后同步采集名集
  const applyIdentity = React.useCallback((names: string[]) => {
    cookieNamesRef.current = new Set(names.filter(Boolean))
    reportedRef.current.clear()
  }, [])

  const showToast = React.useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2200)
  }, [])

  const nav = React.useCallback((v: View) => {
    setStack((s) => (sameView(s[s.length - 1] ?? null, v) ? s : [...s, v]))
  }, [])
  const replace = React.useCallback((v: View) => {
    setStack((s) => [...s.slice(0, -1), v])
  }, [])
  const resetTo = React.useCallback((v: View) => {
    setStack([v])
  }, [])
  const back = React.useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  }, [])
  const manualRefresh = React.useCallback(() => setReloadKey((k) => k + 1), [])

  // 初始：版面列表 + 收藏订阅 + 身份设置；落根视图为综合版1
  React.useEffect(() => {
    void (async () => {
      try {
        const [g, tl, tr, st] = await Promise.all([
          xget({ action: 'forums' }),
          xget({ action: 'timelines' }),
          xget({ action: 'tracked' }),
          xpost({ action: 'settings_get' }),
        ])
        setGroups(g.groups)
        setTimelines(tl.timelines)
        setTracked({ favs: tr.favs || [], subs: tr.subs || [] })
        setHasCookie(!!(st.userhash || '').trim())
        cookieHashRef.current = (st.cookieName || '').trim()
        applyIdentity([(st.cookieName || '').trim(), ...((st.cookies || []).map((c: { cookieName?: string }) => c.cookieName || ''))])
        setStack([{ kind: 'forum', fid: '4', name: t('xdnmb.defaultForum'), page: 1 }])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [t, applyIdentity])

  // 定位命中后的持久高亮：滚动到目标楼 → 卡片高亮 + 关键词标记，
  // 不自动消退，由底部"关闭高亮"浮条手动清除（避免妨碍阅读时一刀切）
  const flashReply = React.useCallback((id: number, q?: string) => {
    const el = document.getElementById(`x-${id}`)
    if (!el) return false
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    clearHitUi()
    el.classList.add('x-hit')
    if (q) markKeywords(el, q)
    setHit({ id, q })
    return true
  }, [])

  /**
   * 我的发言被动采集：X 岛官方没有"按饼干查历史"接口（黎明岛也只存本地）。
   * 每打开串的一页，把 user_hash 命中任意已知饼干显示名的楼层上报入库；
   * 同一缓存键只上报一次，后台已存在的行 ON CONFLICT DO NOTHING。
   */
  const collectMyPosts = React.useCallback(async (th: XPost, cacheKey: string) => {
    const names = cookieNamesRef.current
    if (!names.size) return
    if (reportedRef.current.has(cacheKey)) return
    reportedRef.current.add(cacheKey)
    const hits: Array<{ id: number; isPo: boolean; content: string; img: string; ext: string; now: string; userHash: string }> = []
    if (names.has(th.user_hash)) {
      hits.push({ id: th.id, isPo: true, content: th.content, img: th.img || '', ext: th.ext || '', now: th.now || '', userHash: th.user_hash })
    }
    for (const r of th.Replies || []) {
      if (names.has(r.user_hash)) {
        hits.push({ id: r.id, isPo: false, content: r.content, img: r.img || '', ext: r.ext || '', now: r.now || '', userHash: r.user_hash })
      }
    }
    if (hits.length === 0) return
    try {
      await xpost({
        action: 'myposts_see',
        tid: th.id,
        fid: th.fid ?? null,
        threadTitle: postTitle(th),
        posts: hits,
      })
    } catch {
      // 采集失败不打扰浏览；允许下次重试
      reportedRef.current.delete(cacheKey)
    }
  }, [])

  // 视图切换时清掉上一次的定位高亮（声明在加载 effect 之前：先清后定位）
  React.useEffect(() => {
    setHit(null)
    clearHitUi()
  }, [view])

  // 视图变化 → 缓存命中则瞬时恢复（含滚动位置），否则拉取
  React.useEffect(() => {
    if (!view) return
    const key = viewKey(view)
    const force = reloadKey !== prevReload.current
    prevReload.current = reloadKey
    setError('')

    const settle = (anchorId: number | null) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (anchorId != null) {
          flashReply(anchorId, pendingHitQ.current)
          pendingHitQ.current = undefined
          pendingAnchor.current = null
        } else if (!force) {
          const y = scrollMap.current.has(key) ? scrollMap.current.get(key)! : 0
          window.scrollTo({ top: y })
        }
        // 强制刷新时保持当前滚动位置
      }))
    }

    // 收藏页直接读 tracked 内存态，无需请求
    if (view.kind === 'favs') {
      setPosts(null)
      setThread(null)
      setMyPosts(null)
      setLoading(false)
      settle(null)
      return
    }

    // 我的发言：独立数据源（自家 Neon，按浏览被动采集）
    if (view.kind === 'myposts') {
      setPosts(null)
      setThread(null)
      setLoading(true)
      void (async () => {
        try {
          const data = await xget({ action: 'myposts', page: String(view.page) }, force)
          setMyPosts((data.items || []) as MyPost[])
          setMyTotal(Number(data.total) || 0)
          settle(null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setLoading(false)
        }
      })()
      return
    }

    if (!force) {
      const cached = dataCache.current.get(key)
      if (cached) {
        setLoading(false)
        setPosts(cached.posts ?? null)
        setThread(cached.thread ?? null)
        settle(pendingAnchor.current)
        if (cached.thread) void collectMyPosts(cached.thread, key)
        return
      }
    }

    setThread(null)
    setPosts(null)
    setLoading(true)
    void (async () => {
      try {
        let entry: CacheEntry = {}
        if (view.kind === 'forum') {
          const data = await xget({ action: 'showf', fid: view.fid, page: String(view.page) }, force)
          entry = { posts: data.posts as XPost[] }
        } else if (view.kind === 'timeline') {
          const data = await xget({ action: 'timeline', id: view.tid, page: String(view.page) }, force)
          entry = { posts: data.posts as XPost[] }
        } else if (view.kind === 'thread') {
          const data = await xget({ action: 'thread', id: view.id, page: String(view.page) }, force)
          entry = { thread: data.thread as XPost }
        } else if (view.kind === 'subs') {
          const data = await xget({ action: 'feed', page: String(view.page) }, force)
          entry = { posts: data.posts as XPost[] }
          // feed API 首页只返回 9 条（非 10），不能用 posts.length 判 hasMore；
          // 拉取后刷新 tracked 以同步完整订阅数，供 Pager 计算是否有下一页
          void refreshTracked()
        }
        dataCache.current.set(key, entry)
        setPosts(entry.posts ?? null)
        setThread(entry.thread ?? null)
        settle(pendingAnchor.current)
        if (entry.thread) void collectMyPosts(entry.thread, key)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [view, reloadKey, flashReply, collectMyPosts])

  // 持续记录当前视图滚动位置（rAF 节流）
  React.useEffect(() => {
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const cur = stack[stack.length - 1]
        if (cur) scrollMap.current.set(viewKey(cur), window.scrollY)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [stack])

  const favIds = React.useMemo(() => new Set(tracked.favs.map((f) => f.id)), [tracked])
  const subIds = React.useMemo(() => new Set(tracked.subs.map((s) => s.id)), [tracked])

  // fid → 版块名映射（时间线/综合版混排时给卡片右上角 chip 用，参考 DawnIslandK）
  const forumNameByFid = React.useMemo(() => {
    const m = new Map<number, string>()
    for (const g of groups || []) for (const f of g.forums) m.set(Number(f.id), f.showName || f.name)
    return m
  }, [groups])

  // fid → 完整版块对象（发串入口需要 interval 冷却与 msg 版规；时间线 fid=-1 不能发串）
  const forumByFid = React.useMemo(() => {
    const m = new Map<number, XForum>()
    for (const g of groups || []) for (const f of g.forums) m.set(Number(f.id), f)
    return m
  }, [groups])
  const goFid = React.useCallback((fid: string) => {
    const f = forumByFid.get(Number(fid))
    resetTo({ kind: 'forum', fid, name: f ? (f.showName || f.name) : fid, page: 1 })
  }, [forumByFid])
  // 当前视图对应版面的版规（已净化）：版面页展示并发串前确认；串详情页在楼主卡片给入口
  const currentForum = view?.kind === 'forum' ? forumByFid.get(Number(view.fid)) : undefined
  const currentRules = currentForum?.msg ? sanitizeXRules(currentForum.msg) : ''
  const threadForum = view?.kind === 'thread' && thread?.fid != null ? forumByFid.get(thread.fid) : undefined
  const threadRules = threadForum?.msg ? sanitizeXRules(threadForum.msg) : ''
  // 值班室（举报目标版面）：发串冷却与版规取自版面列表；未加载到时用兜底值
  const dutyForum = forumByFid.get(DUTY_FID)
  const dutyRules = dutyForum?.msg ? sanitizeXRules(dutyForum.msg) : ''

  const refreshTracked = React.useCallback(async () => {
    const tr = await xget({ action: 'tracked' })
    setTracked({ favs: tr.favs || [], subs: tr.subs || [] })
  }, [])

  const toggleFav = async (p: XPost) => {
    const has = favIds.has(p.id)
    await xpost({ action: has ? 'fav_del' : 'fav_add', id: p.id, fid: p.fid ?? null, title: postTitle(p) })
    await refreshTracked()
    showToast(has ? t('xdnmb.favRemoved') : t('xdnmb.favAdded'))
  }
  // X 岛搜索：本地索引为主（爬虫覆盖全论坛时间线/版面），nmb-search 为辅
  // （本地索引尚未爬到的串由 nmb-search 兜底，结果按 threadId 去重合并）
  const searchTimer = React.useRef<number | null>(null)
  const JUMP_RE = /^(?:no\s*[.．]?\s*)?(\d{5,12})$/i
  const doSearch = React.useCallback((q: string) => {
    const query = q.trim()
    const jump = JUMP_RE.exec(query)
    setSearch((s) => ({ ...s, query: q, items: query && !jump ? s.items : [], err: '' }))
    if (searchTimer.current) window.clearTimeout(searchTimer.current)
    if (!query || jump) return
    searchTimer.current = window.setTimeout(async () => {
      setSearch((s) => ({ ...s, loading: true, err: '' }))
      try {
        // 并行查本地索引 + nmb-search；任一失败不影响另一个
        const [localRes, remoteRes] = await Promise.allSettled([
          xget({ action: 'index_search', q: query }),
          xget({ action: 'search', q: query }),
        ])
        const seen = new Set<number>()
        const merged: SearchItem[] = []
        // 本地索引结果优先（覆盖面更广）
        if (localRes.status === 'fulfilled') {
          const hits = (localRes.value.hits as Array<{
            id: number; threadId: number; title: string; snippet: string; isMain: boolean
          }>) || []
          for (const h of hits) {
            if (!h.threadId || seen.has(h.threadId)) continue
            seen.add(h.threadId)
            merged.push({
              id: h.threadId,
              r: h.isMain ? null : h.id,
              url: '',
              title: h.title,
              snippet: h.snippet,
            })
          }
        }
        // nmb-search 补充（去重；覆盖本地索引尚未爬到的串）
        if (remoteRes.status === 'fulfilled') {
          const items = (remoteRes.value.items as SearchItem[]) || []
          for (const it of items) {
            if (!it.id || seen.has(it.id)) continue
            seen.add(it.id)
            merged.push(it)
          }
        }
        // 两路都失败才报错
        if (localRes.status === 'rejected' && remoteRes.status === 'rejected') {
          const e = remoteRes.reason
          setSearch((s) => ({
            ...s,
            loading: false,
            err: e instanceof Error ? e.message : String(e),
            items: [],
          }))
          return
        }
        setSearch((s) => ({ ...s, items: merged, loading: false }))
      } catch (e) {
        setSearch((s) => ({ ...s, loading: false, err: e instanceof Error ? e.message : String(e), items: [] }))
      }
    }, 300)
  }, [])
  // 打开搜索结果：带 ?r= 命中回帖号时，直接在串内定位到该楼并高亮关键词
  const openSearchResult = (it: SearchItem) => {
    closeSearch()
    if (it.r && it.r !== it.id) {
      const q = search.query.trim()
      pendingHitQ.current = q
      showToast(t('xdnmb.locating'))
      void locateReply(String(it.id), it.r, undefined, q)
    } else {
      nav({ kind: 'thread', id: String(it.id), page: 1 })
    }
  }
  // No.xxx / 纯编号直跳：
  // 0. 本地索引反查（最快且最可靠：从已索引楼层的 thread_id 直接定位父串）
  // 1. 当前串缓存命中（零网络，最快）
  // 2. 串号验证（thread API 单次请求；回帖号会"该串不存在"被 catch）
  // 3. 搜索反查（No.<rid> + <rid> 两种查询，取并集；本地索引未覆盖时 nmb-search 兜底）
  // 4. 当前串内二分定位（locateReply，兜底回退）
  // X 岛 thread API 在传入回帖号时返回"该串不存在"（不返回父串），
  // ref API 只返回单楼无父串 ID，因此跨串回帖只能靠本地索引或搜索引擎反查。
  const jumpById = async (n: string) => {
    const rid = Number(n)
    closeSearch()
    // 1. 当前串缓存命中（零网络请求）
    const cur = stack[stack.length - 1]
    if (cur?.kind === 'thread') {
      for (const [k, v] of dataCache.current) {
        if (!k.startsWith(`thread:${cur.id}:p`) || !v.thread) continue
        const pg = Number(k.split(':p')[1])
        if (v.thread.id === rid || (v.thread.Replies || []).some((r) => r.id === rid)) {
          pendingAnchor.current = rid
          pendingHitQ.current = undefined
          if (cur.page === pg) { setRefSpec(null); flashReply(rid); return }
          replace({ kind: 'thread', id: cur.id, page: pg })
          setRefSpec(null)
          return
        }
      }
    }
    // 0. 本地索引反查（从已索引楼层 thread_id 直接定位父串，比 nmb-search 覆盖面广）
    try {
      const data = await xget({ action: 'index_search', rid: String(rid) })
      const hit = data.hit as { threadId: number; post: { id: number; threadId: number; content: string } } | null
      if (hit && hit.threadId) {
        showToast(t('xdnmb.locating'))
        if (await locateReply(String(hit.threadId), rid)) return
      }
    } catch { /* 本地索引未命中或不可用，继续走后续路径 */ }
    // 2. 串号验证（thread API；回帖号会 throw 被跳过）
    try {
      const data = await xget({ action: 'thread', id: String(rid), page: '1' })
      const th = data.thread as XPost
      if (th && th.id === rid) {
        nav({ kind: 'thread', id: String(rid), page: 1 })
        showToast(t('xdnmb.jumpThreadOk'))
        return
      }
    } catch { /* 不是串号，按回帖号继续 */ }
    // 3. 搜索反查（本地索引未覆盖时，nmb-search 兜底；No.<rid> + 纯数字两种查询取并集）
    showToast(t('xdnmb.locating'))
    const triedThreads = new Set<number>()
    for (const q of [`No.${rid}`, String(rid)]) {
      try {
        const sres = await xget({ action: 'search', q })
        const items = ((sres.items as SearchItem[]) || []).filter((it) => it.id && !triedThreads.has(it.id))
        // 命中 ?r=<rid>：直接定位到该楼
        const hitItem = items.find((it) => it.r === rid && it.r !== it.id)
        if (hitItem) {
          triedThreads.add(hitItem.id)
          if (await locateReply(String(hitItem.id), hitItem.r as number)) return
        }
        // 搜索结果无 ?r=：逐条尝试定位（首条大概率是包含该回帖的串）
        for (const it of items) {
          triedThreads.add(it.id)
          if (await locateReply(String(it.id), rid)) return
        }
      } catch { /* 搜索不可用或超时 */ }
    }
    // 4. 当前串内二分定位（搜索失败时的回退）
    if (cur?.kind === 'thread') {
      showToast(t('xdnmb.locating'))
      if (await locateReply(cur.id, rid)) return
    }
    showToast(t('xdnmb.jumpNotFound'))
  }
  const openSearch = React.useCallback(() => {
    setSearch((s) => ({ ...s, open: true }))
  }, [])
  const closeSearch = React.useCallback(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current)
    setSearch((s) => ({ ...s, open: false }))
  }, [])
  // 订阅走 X 岛官方 feed（uuid 同步，跨客户端可见），本地同时镜像供 TG 推送
  const toggleSub = async (p: XPost) => {
    const has = subIds.has(p.id)
    const res = await xpost({ action: has ? 'feed_del' : 'feed_add', id: p.id, fid: p.fid ?? null, title: postTitle(p) })
    await refreshTracked()
    // 在订阅列表里退订后顺手刷新该页，让卡片立刻消失
    const cur = stack[stack.length - 1]
    if (has && cur?.kind === 'subs') setReloadKey((k) => k + 1)
    showToast(has ? (res.warning ? `${t('xdnmb.subRemoved')}（${res.warning}）` : t('xdnmb.subRemoved')) : t('xdnmb.subAdded'))
  }

  // 内容区链接拦截：xdnmb:ref:123 弹引用预览；xdnmb:thread:123 预览主楼后再决定跳转
  const onContentClick = (e: React.MouseEvent) => {
    // 防剧透黑条：点击/长按点按反色显示（官网前端同款交互）
    const sp = (e.target as HTMLElement).closest?.('.x-spoiler')
    if (sp) {
      sp.classList.toggle('x-spoiler-show')
      // 黑条本身不是链接时吞掉点击，避免误触下层
      if (!(e.target as HTMLElement).closest('a')) return
    }
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    let mm = /^xdnmb:ref:(\d+)/.exec(href)
    if (mm) {
      e.preventDefault()
      setRefSpec({ kind: 'ref', id: mm[1], x: e.clientX, y: e.clientY })
      return
    }
    mm = /^xdnmb:thread:(\d+)/.exec(href)
    if (mm) {
      e.preventDefault()
      setRefSpec({ kind: 'thread', id: mm[1], x: e.clientX, y: e.clientY })
    }
  }

  const gotoPage = (target: number) => {
    if (!view) return
    const p = Math.max(1, target | 0 || 1)
    if (view.kind === 'forum') replace({ ...view, page: p })
    else if (view.kind === 'timeline') replace({ ...view, page: p })
    else if (view.kind === 'thread') replace({ ...view, page: p })
    else if (view.kind === 'subs') replace({ ...view, page: p })
    else if (view.kind === 'myposts') replace({ ...view, page: p })
  }

  /**
   * 在串内定位某楼：先查已缓存页 → 同页直接滚动；
   * 否则按楼号随页码单调递增做二分（每页约 19 条），结果页写入缓存供返回复用。
   * status 用于弹层显示进度；找不到返回 false（通常是跨串引用）。
   */
  const locateReply = async (tid: string, rid: number, setStatus?: (s: string) => void, q?: string): Promise<boolean> => {
    const realReplies = (th: XPost) => (th.Replies || []).filter((r) => r.user_hash !== 'Tips')

    // 1) 已缓存页面
    for (const [k, v] of dataCache.current) {
      if (!k.startsWith(`thread:${tid}:p`) || !v.thread) continue
      const pg = Number(k.split(':p')[1])
      if (v.thread.id === rid || realReplies(v.thread).some((r) => r.id === rid)) {
        const cur = stack[stack.length - 1]
        if (cur && cur.kind === 'thread' && cur.id === tid && cur.page === pg) {
          setRefSpec(null)
          return flashReply(rid, q)
        }
        pendingAnchor.current = rid
        pendingHitQ.current = q
        replace({ kind: 'thread', id: tid, page: pg })
        setRefSpec(null)
        return true
      }
    }

    // 不在目标串内（如从"我的发言"进入）：先把导航栈切过去，再自行翻页定位
    if (view?.kind !== 'thread' || view.id !== tid) {
      nav({ kind: 'thread', id: tid, page: 1 })
    }

    setStatus?.(t('xdnmb.locating'))
    const fetchPage = async (p: number): Promise<XPost> => {
      const data = await xget({ action: 'thread', id: tid, page: String(p) })
      const th = data.thread as XPost
      dataCache.current.set(`thread:${tid}:p${p}`, { thread: th })
      return th
    }

    try {
      // 2) 估算总页数并校准上界（被删楼可能导致估算偏小；探测到边界为止）
      const firstCached = dataCache.current.get(`thread:${tid}:p1`)?.thread
      const first = firstCached || await fetchPage(1)
      let hi = Math.max(1, Math.ceil((Number(first.ReplyCount) || 0) / PAGE_SIZE))
      let pg = await fetchPage(hi)
      let lastId = (): number => {
        const rs = realReplies(pg)
        return rs.length ? rs[rs.length - 1].id : first.id
      }
      let guard = 0
      while (rid > lastId() && guard < 10) {
        const prevLast = lastId()
        pg = await fetchPage(hi + 1)
        if (lastId() === prevLast) break // 越界返回最后一页：已到尽头
        hi += 1
        guard += 1
      }
      // 3) 二分（hi 探测页已在缓存中，直接复用）
      let lo = 1
      while (lo <= hi && guard < 16) {
        const mid = (lo + hi) >> 1
        const cur = dataCache.current.get(`thread:${tid}:p${mid}`)?.thread || await fetchPage(mid)
        guard += 1
        if (cur.id === rid) {
          pendingAnchor.current = rid
          pendingHitQ.current = q
          replace({ kind: 'thread', id: tid, page: mid })
          setRefSpec(null)
          return true
        }
        const rs = realReplies(cur)
        if (!rs.length) { hi = mid - 1; continue }
        const firstId = rs[0].id
        const endId = rs[rs.length - 1].id
        if (rid < firstId) hi = mid - 1
        else if (rid > endId) lo = mid + 1
        else {
          pendingAnchor.current = rid
          if (view.kind === 'thread' && view.page === mid) {
            setRefSpec(null)
            return flashReply(rid, q)
          }
          pendingHitQ.current = q
          replace({ kind: 'thread', id: tid, page: mid })
          setRefSpec(null)
          return true
        }
      }
    } catch {
      // 网络错误落到未找到提示
    }
    return false
  }

  const currentName = view
    ? view.kind === 'thread'
      ? `No.${view.id}`
      : view.kind === 'favs'
        ? t('xdnmb.favs')
        : view.kind === 'subs'
          ? t('xdnmb.subs')
          : view.kind === 'myposts'
            ? t('xdnmb.myPosts')
            : view.name
    : ''
  const currentThreadId = view?.kind === 'thread' ? view.id : null
  const lastPageHint = view?.kind === 'thread' && thread
    ? Math.max(1, Math.ceil((Number(thread.ReplyCount) || 0) / PAGE_SIZE))
    : view?.kind === 'myposts'
      ? Math.max(1, Math.ceil(myTotal / MYPOSTS_PAGE_SIZE))
      : undefined

  return (
    <div className={`xdnmb-app${immersive ? ' x-imm' : ''}`}>
      {/* 顶栏（沉浸模式隐藏，改用浮动按钮防误触） */}
      <div className="x-topbar">
        {stack.length > 1 && (
          <button type="button" className="x-icon-btn" onClick={back} title={t('xdnmb.back')}>
            <ArrowLeft size={15} />
          </button>
        )}
        <button type="button" className="ghost-button x-topbtn" onClick={() => setDrawerOpen(true)}>
          <MessageSquare size={14} /> {t('xdnmb.forums')}
        </button>
        <button type="button" className="ghost-button x-topbtn" onClick={() => nav({ kind: 'favs' })}>
          <Star size={14} /> {t('xdnmb.favs')}
        </button>
        <button type="button" className="ghost-button x-topbtn" onClick={() => nav({ kind: 'subs', page: 1 })}>
          <Bell size={14} /> {t('xdnmb.subs')}
        </button>
        <button
          type="button"
          className={`x-icon-btn${view?.kind === 'myposts' ? ' x-topbtn-active' : ''}`}
          onClick={() => nav({ kind: 'myposts', page: 1 })}
          title={t('xdnmb.myPosts')}
          aria-label={t('xdnmb.myPosts')}
        >
          <History size={15} />
        </button>
        <strong className="x-crumb">{currentName}</strong>
        <button type="button" className="x-icon-btn" onClick={openSearch} title={t('xdnmb.search')} aria-label={t('xdnmb.search')}>
          <Search size={14} />
        </button>
        <button type="button" className="x-icon-btn" onClick={manualRefresh} title={t('xdnmb.refresh')}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
        <button type="button" className="x-icon-btn" onClick={toggleImmersive} title={t('xdnmb.immersive')}>
          <Maximize2 size={14} />
        </button>
        <button type="button" className="x-icon-btn x-settings-btn" onClick={() => setSettingsOpen(true)} title={t('xdnmb.settings')}>
          <Settings size={14} />
          {hasCookie !== null && <span className={`x-cookie-dot${hasCookie ? ' ok' : ''}`} />}
        </button>
      </div>

      {error && (
        <div className="x-error">
          {error}
          <div>
            <button type="button" className="ghost-button" onClick={() => setSettingsOpen(true)}>
              {t('xdnmb.checkCookie')}
            </button>
          </div>
        </div>
      )}

      {loading && <div className="x-loading"><RefreshCw size={20} className="spin" /></div>}

      {/* 串列表（版面 / 时间线） */}
      {!loading && posts && view && (view.kind === 'forum' || view.kind === 'timeline') && (
        <>
          {/* 发串入口：仅具体版面显示（时间线 fid=-1 无发串权限） */}
          {view.kind === 'forum' && view.fid !== '-1' && currentForum && (
            <XComposer
              key={`post-${view.fid}`}
              mode={{ kind: 'thread', fid: view.fid, interval: Number(currentForum.interval) || 0 }}
              targetLabel={view.name}
              t={t}
              rulesHtml={currentRules}
              canPost={!!hasCookie}
              collapsible
              onOpenSettings={() => setSettingsOpen(true)}
              onContentClick={onContentClick}
              onGoForum={goFid}
              onPosted={(msg) => {
                showToast(msg)
                setReloadKey((k) => k + 1)
                if (view.page !== 1) replace({ ...view, page: 1 })
              }}
            />
          )}
          {posts.map((p) => (
            <PostCard
              key={p.id}
              p={p}
              t={t}
              fav={favIds.has(p.id)}
              sub={subIds.has(p.id)}
              forumName={view.kind === 'forum' ? view.name : (typeof p.fid === 'number' ? forumNameByFid.get(p.fid) : undefined)}
              onOpen={() => nav({ kind: 'thread', id: String(p.id), page: 1 })}
              onToggleFav={() => void toggleFav(p)}
              onToggleSub={() => void toggleSub(p)}
              onReport={(id) => setReport({ id, reason: null })}
              onImg={setLightbox}
              onContentClick={onContentClick}
              summary
            />
          ))}
          {posts.length === 0 && <div className="x-empty">{t('xdnmb.empty')}</div>}
          <Pager page={view.page} hasMore={posts.length >= 20} t={t} onGo={gotoPage} />
        </>
      )}

      {/* 订阅串列表（X 岛官方 feed，按订阅 ID 同步） */}
      {!loading && posts && view?.kind === 'subs' && (
        <>
          {posts.map((p) => (
            <PostCard
              key={p.id}
              p={p}
              t={t}
              fav={favIds.has(p.id)}
              sub={subIds.has(p.id)}
              forumName={typeof p.fid === 'number' ? forumNameByFid.get(p.fid) : undefined}
              onOpen={() => nav({ kind: 'thread', id: String(p.id), page: 1 })}
              onToggleFav={() => void toggleFav(p)}
              onToggleSub={() => void toggleSub(p)}
              onReport={(id) => setReport({ id, reason: null })}
              onImg={setLightbox}
              onContentClick={onContentClick}
              summary
            />
          ))}
          {posts.length === 0 && <div className="x-empty">{t('xdnmb.feedEmpty')}</div>}
          {/* hasMore 用 tracked.subs 总数而非本页条数：feed API 首页只返回 9 条 */}
          <Pager page={view.page} hasMore={tracked.subs.length > view.page * FEED_PAGE_SIZE} t={t} onGo={gotoPage} />
        </>
      )}

      {/* 串详情 */}
      {!loading && thread && view?.kind === 'thread' && (
        <>
          <ThreadView
            thread={thread}
            page={view.page}
            t={t}
            fav={favIds.has(thread.id)}
            sub={subIds.has(thread.id)}
            forumName={typeof thread.fid === 'number' ? forumNameByFid.get(thread.fid) : undefined}
            rulesHtml={threadRules || undefined}
            immersive={immersive}
            canReply={!!hasCookie}
            onToggleFav={() => void toggleFav(thread)}
            onToggleSub={() => void toggleSub(thread)}
            onReport={(id) => setReport({ id, reason: null })}
            onImg={setLightbox}
            onContentClick={onContentClick}
            onGoForum={goFid}
            onOpenSettings={() => setSettingsOpen(true)}
            onPosted={(msg) => {
              showToast(msg)
              // 新回复在末页：强制重取当前页；若不在末页用户可自行翻页
              setReloadKey((k) => k + 1)
            }}
          />
          <Pager
            page={view.page}
            hasMore={(thread.Replies?.length ?? 0) >= PAGE_SIZE}
            lastHint={lastPageHint}
            t={t}
            onGo={gotoPage}
          />
        </>
      )}

      {/* 收藏管理页（收藏是本站自有功能，X 岛无此概念） */}
      {!loading && view?.kind === 'favs' && (
        <TrackList
          items={tracked.favs}
          isSub={false}
          t={t}
          onOpen={(id) => nav({ kind: 'thread', id: String(id), page: 1 })}
          onRemove={async (id) => {
            await xpost({ action: 'fav_del', id })
            await refreshTracked()
          }}
        />
      )}

      {/* 我的发言（按已绑定饼干显示名被动采集） */}
      {!loading && view?.kind === 'myposts' && (
        <MyPostsList
          items={myPosts || []}
          total={myTotal}
          t={t}
          cookieName={cookieHashRef.current}
          onOpen={(tid, rid) => {
            // locateReply 不在目标串时会自动切导航并二分翻页定位
            void locateReply(String(tid), rid)
          }}
          onRemove={async (id) => {
            await xpost({ action: 'myposts_del', id })
            setMyPosts((list) => (list || []).filter((p) => p.id !== id))
            setMyTotal((n) => Math.max(0, n - 1))
          }}
        />
      )}
      {!loading && view?.kind === 'myposts' && (myPosts?.length ?? 0) > 0 && (
        <Pager page={view.page} hasMore={(myPosts?.length ?? 0) >= MYPOSTS_PAGE_SIZE} lastHint={lastPageHint} t={t} onGo={gotoPage} />
      )}

      {/* 版面抽屉 */}
      {drawerOpen && groups && (
        <ForumDrawer
          groups={groups}
          timelines={timelines || []}
          currentFid={view?.kind === 'forum' ? view.fid : null}
          currentTid={view?.kind === 'timeline' ? view.tid : null}
          t={t}
          onClose={() => setDrawerOpen(false)}
          onPickForum={(fid, name) => {
            setDrawerOpen(false)
            resetTo({ kind: 'forum', fid, name, page: 1 })
          }}
          onPickTimeline={(tid, name) => {
            setDrawerOpen(false)
            resetTo({ kind: 'timeline', tid, name, page: 1 })
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          t={t}
          onClose={() => setSettingsOpen(false)}
          onIdentityChange={applyIdentity}
          onSaved={(has, name, names) => {
            setSettingsOpen(false)
            setHasCookie(has)
            cookieHashRef.current = name
            applyIdentity(names)
            showToast(t('xdnmb.saved'))
            // 换饼干后强制重取当前视图，绕过缓存
            dataCache.current.clear()
            setReloadKey((k) => k + 1)
          }}
        />
      )}

      {/* 引用预览弹层 */}
      {refSpec && (
        <RefPopover
          spec={refSpec}
          t={t}
          inThreadId={currentThreadId}
          onClose={() => setRefSpec(null)}
          onReopen={(s) => setRefSpec(s)}
          onLocate={(tid, rid, setStatus) => locateReply(tid, rid, setStatus)}
          onOpenThread={(id) => {
            setRefSpec(null)
            nav({ kind: 'thread', id, page: 1 })
          }}
        />
      )}

      {lightbox && (
        <div className="x-lightbox" onClick={() => setLightbox('')}>
          <img src={lightbox} alt="" />
        </div>
      )}

      {/* 搜索浮层：nmb-search 代理，结果在站内打开；Esc/遮罩关闭 */}
      {search.open && (
        <div className="x-search-mask" onClick={closeSearch}>
          <div className="x-search-pop" role="dialog" aria-label={t('xdnmb.search')} onClick={(e) => e.stopPropagation()}>
            <div className="x-search-head">
              <Search size={16} />
              <input
                className="x-search-input"
                autoFocus
                placeholder={t('xdnmb.searchPh')}
                value={search.query}
                onChange={(e) => doSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') closeSearch() }}
              />
              {search.loading && <RefreshCw size={14} className="spin" />}
              <button type="button" className="x-icon-btn" onClick={closeSearch} aria-label={t('xdnmb.confirmCancel')}>
                <X size={14} />
              </button>
            </div>
            <div className="x-search-body">
              {search.err && <div className="x-form-error">{search.err}</div>}
              {(() => {
                const jm = JUMP_RE.exec(search.query.trim())
                return jm && !search.loading ? (
                  <button type="button" className="x-search-item x-search-jump" onClick={() => void jumpById(jm[1])}>
                    <div className="x-search-item-title"><Crosshair size={13} /> No.{jm[1]}</div>
                    <div className="x-search-item-snip">{t('xdnmb.jumpSub')}</div>
                  </button>
                ) : null
              })()}
              {!search.err && !search.loading && !JUMP_RE.test(search.query.trim()) && search.query.trim() && search.items.length === 0 && (
                <div className="x-empty">{t('xdnmb.searchEmpty')}</div>
              )}
              {!search.err && !search.loading && search.items.length > 0 && (
                <div className="x-search-count">{search.items.length} {t('xdnmb.searchCount')}</div>
              )}
              {search.items.map((it) => (
                <button
                  key={`${it.id}-${it.r ?? 0}`}
                  type="button"
                  className="x-search-item"
                  onClick={() => openSearchResult(it)}
                >
                  <div className="x-search-item-title">{it.title || `No.${it.id}`}</div>
                  {it.snippet && <div className="x-search-item-snip">{it.snippet}</div>}
                  <div className="x-meta"><span>No.{it.id}{it.r && it.r !== it.id ? ` → No.${it.r}` : ''}</span></div>
                </button>
              ))}
              {!search.query.trim() && <div className="x-search-hint">{t('xdnmb.searchHint')}</div>}
            </div>
          </div>
        </div>
      )}

      {/* 举报第一步：选理由（DawnIslandK 同款列表；遮罩点击可取消，无内容可丢） */}
      {report && !report.reason && (
        <div className="x-modal-mask" onClick={() => setReport(null)}>
          <div className="panel x-modal" role="dialog" aria-label={t('xdnmb.reportTitle')} onClick={(e) => e.stopPropagation()}>
            <div className="x-modal-head">
              <Flag size={16} />
              <strong>{t('xdnmb.reportTitle')} · No.{report.id}</strong>
            </div>
            <div className="x-modal-body">
              <p className="x-confirm-line">{t('xdnmb.reportPickReason')}</p>
              <div className="x-report-reasons">
                {REPORT_REASONS.map((r) => (
                  <button key={r.id} type="button" className="x-report-reason" onClick={() => setReport({ id: report.id, reason: r })}>
                    {t(`xdnmb.reportReason.${r.id}`)}
                  </button>
                ))}
              </div>
              <p className="x-confirm-warn">{t('xdnmb.reportHint')}</p>
            </div>
            <div className="x-modal-actions">
              <button type="button" className="ghost-button" onClick={() => setReport(null)}>{t('xdnmb.confirmCancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 举报第二步：预填“引用+理由”的值班室发串编辑器（可补充说明，走既有二次确认）。
          已输入内容可能较多，遮罩点击不关闭，只能点右上角 X */}
      {report && report.reason && (
        <div className="x-modal-mask">
          <div className="x-report-pop">
            <div className="panel x-report-head">
              <Flag size={14} />
              <strong>{t('xdnmb.reportTitle')} · No.{report.id}</strong>
              <button type="button" className="x-icon-btn" onClick={() => setReport(null)} aria-label={t('xdnmb.confirmCancel')}>
                <X size={14} />
              </button>
            </div>
            <XComposer
              key={`report-${report.id}`}
              mode={{ kind: 'thread', fid: String(DUTY_FID), interval: Number(dutyForum?.interval) || 0 }}
              targetLabel={dutyForum ? dutyForum.showName || dutyForum.name : '值班室'}
              t={t}
              rulesHtml={dutyRules || undefined}
              canPost={!!hasCookie}
              initialContent={`>>No.${report.id}\n举报理由: ${report.reason.zh}\n`}
              onOpenSettings={() => setSettingsOpen(true)}
              onPosted={(msg) => { setReport(null); showToast(msg) }}
              onContentClick={onContentClick}
              onGoForum={goFid}
            />
          </div>
        </div>
      )}

      {/* 沉浸模式底部浮动条：返回/版面/搜索/刷新/退出（拇指热区，按使用频率排列） */}
      {immersive && (
        <div className="x-imm-pill">
          {stack.length > 1 && (
            <button type="button" onClick={back} title={t('xdnmb.back')} aria-label={t('xdnmb.back')}>
              <ArrowLeft size={19} />
            </button>
          )}
          <button type="button" onClick={() => setDrawerOpen(true)} title={t('xdnmb.forums')} aria-label={t('xdnmb.forums')}>
            <MessageSquare size={19} />
          </button>
          <button type="button" onClick={openSearch} title={t('xdnmb.search')} aria-label={t('xdnmb.search')}>
            <Search size={19} />
          </button>
          <button type="button" onClick={manualRefresh} title={t('xdnmb.refresh')} aria-label={t('xdnmb.refresh')}>
            <RefreshCw size={19} className={loading ? 'spin' : ''} />
          </button>
          <button type="button" onClick={toggleImmersive} title={t('xdnmb.exitImmersive')} aria-label={t('xdnmb.exitImmersive')}>
            <Minimize2 size={19} />
          </button>
        </div>
      )}

      {/* 定位高亮浮条：告知命中位置，手动关闭以免妨碍阅读；沉浸模式抬到底部浮动条上方 */}
      {hit && (
        <div className={`x-hit-chip${immersive ? ' x-hit-chip-imm' : ''}`} role="status">
          <Crosshair size={13} />
          <span>{t('xdnmb.hitDone')} No.{hit.id}</span>
          <button type="button" onClick={() => { clearHitUi(); setHit(null) }}>
            <X size={12} /> {t('xdnmb.hitOff')}
          </button>
        </div>
      )}

      {toast && <div className="x-toast">{toast}</div>}
    </div>
  )
}

// ───────── 子组件 ─────────

type TFunc = (k: string) => string
type XdnmbTrack = { id: number; fid: number | null; title: string; lastReplyCount?: number; createdAt: string }

// ───────── 发串/回复编辑器（含指定颜文字、GIF 贴纸、骰子、黑条、图片附件） ─────────

const MAX_CONTENT = 10000
const MAX_IMG = 20 * 1024 * 1024
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])

type ComposerMode =
  | { kind: 'reply'; threadId: number }
  | { kind: 'thread'; fid: string; interval: number }

// 举报理由（DawnIslandK 同款 8 项）：选中后向值班室（fid=18）发新串，
// 预填内容固定中文（值班室管理团队阅读）。id 对应 i18n 的 xdnmb.reportReason.*
const REPORT_REASONS = [
  { id: 'porn', zh: '黄赌毒' },
  { id: 'politics', zh: '政治敏感' },
  { id: 'rumor', zh: '谣言欺诈' },
  { id: 'ad', zh: '广告Q群' },
  { id: 'flame', zh: '引战辱骂' },
  { id: 'offtopic', zh: '串版' },
  { id: 'selfdel', zh: '自删' },
  { id: 'other', zh: '其他' },
] as const
type ReportReason = (typeof REPORT_REASONS)[number]

/** 值班室版面 ID（X 岛管理组，举报串发到这里） */
const DUTY_FID = 18

export interface XComposerHandle {
  /** 引用楼层：展开编辑器并在正文插入 >>No.xxx */
  insertQuote: (id: number) => void
}

type PendingImage = { file: File; preview: string; stickerName?: string }

/** 搜索结果项：从 nmb-search 提取的 X 岛串（r = 命中回帖号，来自 URL ?r= 参数） */
type SearchItem = { id: number; url: string; title: string; snippet: string; r?: number | null }

// ───────── 定位高亮工具（纯客户端 DOM 操作，SSR 下不会被调用） ─────────

/** 清除当前所有定位高亮：卡片类名 + 文本命中标记 */
function clearHitUi(): void {
  if (typeof document === 'undefined') return
  document.querySelectorAll('.x-hit').forEach((n) => n.classList.remove('x-hit'))
  document.querySelectorAll('mark.x-mark').forEach((m) => {
    const p = m.parentNode
    if (!p) return
    p.replaceChild(document.createTextNode(m.textContent || ''), m)
    p.normalize()
  })
}

/** 在容器内的文本节点把命中关键词包上 <mark class="x-mark">（只动文本节点，不改标签结构） */
function markKeywords(root: HTMLElement, query: string): void {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((w) => (/[\u4e00-\u9fff]/.test(w) ? w.length >= 1 : w.length >= 2))
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!terms.length) return
  const re = new RegExp(`(${terms.join('|')})`, 'gi')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    const tag = n.parentElement?.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') continue
    nodes.push(n)
  }
  for (const node of nodes) {
    const text = node.nodeValue || ''
    re.lastIndex = 0
    if (!re.test(text)) continue
    re.lastIndex = 0
    const frag = document.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)))
      const mark = document.createElement('mark')
      mark.className = 'x-mark'
      mark.textContent = m[0]
      frag.appendChild(mark)
      last = m.index + m[0].length
      if (m[0].length === 0) re.lastIndex += 1
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    node.parentNode?.replaceChild(frag, node)
  }
}

/**
 * 版面公告（forum.msg，X 岛 HTML 片段）客户端白名单净化。
 * 仅保留常见排版标签与 http(s) 图片；相对链接 /t/ /f/ 改写为 xdnmb: 内部协议。
 */
function sanitizeXRules(src: string): string {
  if (!src) return ''
  const doc = new DOMParser().parseFromString(src, 'text/html')
  const ALLOWED = new Set(['A', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'FONT', 'IMG', 'DIV', 'SPAN', 'P', 'LI', 'UL', 'OL', 'TT', 'BLOCKQUOTE'])
  const walk = (node: Node) => {
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType !== 1) continue
      const el = ch as Element
      const tag = el.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || !ALLOWED.has(tag)) {
        el.replaceWith(doc.createTextNode(el.textContent || ''))
        continue
      }
      for (const attr of Array.from(el.attributes)) {
        const n = attr.name.toLowerCase()
        if (tag === 'A' && n === 'href') {
          const v = attr.value.trim()
          const tM = /^\/t\/(\d+)/.exec(v)
          const fM = /^\/f\/(\d+)/.exec(v)
          if (tM) attr.value = `xdnmb:thread:${tM[1]}`
          else if (fM) attr.value = `xdnmb:forum:${fM[1]}`
          else if (!/^(https?:|mailto:|xdnmb:)/i.test(v)) el.removeAttribute('href')
        } else if (tag === 'IMG' && n === 'src') {
          if (!/^https:\/\//i.test(attr.value)) el.removeAttribute('src')
        } else if (tag === 'FONT' && n === 'color') {
          if (!/^(#[0-9a-fA-F]{3,6}|[a-zA-Z]+)$/.test(attr.value)) el.removeAttribute('color')
        } else {
          el.removeAttribute(attr.name)
        }
      }
      if (tag === 'A') {
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      }
      walk(ch)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

function RulesBox(props: {
  rulesHtml: string
  onContentClick: (e: React.MouseEvent) => void
  onGoForum?: (fid: string) => void
}) {
  return (
    <div
      className="x-rules x-content"
      onClickCapture={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        const fm = a && /^xdnmb:forum:(\d+)/.exec(a.getAttribute('href') || '')
        if (a && fm) {
          e.preventDefault()
          props.onGoForum?.(fm[1])
          return
        }
        props.onContentClick(e)
      }}
      dangerouslySetInnerHTML={{ __html: props.rulesHtml }}
    />
  )
}

/**
 * 锚定触发按钮的浮层定位：
 * - 桌面端（>600px）：position:fixed + 视口钳制（左右各留 8px），下方空间不足时自动向上弹；
 * - 窄屏（≤600px）：不输出坐标，由 CSS 底部 sheet 接管（与 .x-ref-sheet 一致）。
 * 滚动/缩放时自动关闭（浮层内部滚动除外），避免浮层与触发按钮错位。
 */
function useAnchoredPop(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  popRef: React.RefObject<HTMLElement | null>,
  close: () => void,
  opts: { align?: 'left' | 'right'; gap?: number } = {},
): React.CSSProperties {
  const [pos, setPos] = React.useState<React.CSSProperties>({})
  React.useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (window.innerWidth <= 600) { setPos({}); return }
      const b = anchorRef.current?.getBoundingClientRect()
      const m = popRef.current
      if (!b || !m) return
      const w = m.offsetWidth
      const h = m.offsetHeight
      const gap = opts.gap ?? 6
      const left = opts.align === 'left'
        ? Math.max(8, Math.min(b.left, window.innerWidth - w - 8))
        : Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8))
      const top = window.innerHeight - b.bottom - 8 >= h
        ? b.bottom + gap
        : Math.max(8, b.top - h - gap)
      setPos({ left, top })
    }
    place()
    // 浮层内部滚动（如版规正文）不处理；外部滚动时跟随重定位，
    // 仅当触发按钮完全离开视口才关闭，避免与按钮错位
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node | null)) return
      const b = anchorRef.current?.getBoundingClientRect()
      if (!b || b.bottom < 0 || b.top > window.innerHeight) { close(); return }
      place()
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
    // 定位只在开关瞬间建立；close 用 ref 稳定引用，无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return pos
}

function RulesToggle(props: {
  t: TFunc
  rulesHtml: string
  onContentClick: (e: React.MouseEvent) => void
  onGoForum?: (fid: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const btnRef = React.useRef<HTMLButtonElement | null>(null)
  const popRef = React.useRef<HTMLDivElement | null>(null)
  const close = React.useCallback(() => setOpen(false), [])
  const pos = useAnchoredPop(open, btnRef, popRef, close, { align: 'left', gap: 6 })
  return (
    <div className="x-rules-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`x-rules-btn${open ? ' x-rules-btn-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ScrollText size={13} /> {props.t('xdnmb.rules')}
        <ChevronDown size={12} className={open ? 'x-chevron-up' : ''} />
      </button>
      {open && (
        <>
          <div className="x-pop-mask" onClick={close} />
          <div
            ref={popRef}
            className="x-rules-pop"
            role="dialog"
            aria-label={props.t('xdnmb.rulesTitle')}
            style={pos}
          >
            <div className="x-rules-head">
              <strong><ScrollText size={13} /> {props.t('xdnmb.rulesTitle')}</strong>
              <button type="button" className="x-icon-btn" onClick={close} aria-label="close">
                <X size={13} />
              </button>
            </div>
            <RulesBox rulesHtml={props.rulesHtml} onContentClick={props.onContentClick} onGoForum={props.onGoForum} />
          </div>
        </>
      )}
    </div>
  )
}

const XComposer = React.forwardRef<XComposerHandle, {
  mode: ComposerMode
  targetLabel: string
  t: TFunc
  rulesHtml?: string
  canPost: boolean
  collapsible?: boolean
  /** 预填正文（如举报时引用楼层+理由）；组件卸载重挂后生效 */
  initialContent?: string
  onOpenSettings: () => void
  onPosted: (message: string) => void
  onContentClick?: (e: React.MouseEvent) => void
  onGoForum?: (fid: string) => void
}>(function XComposer(props, ref) {
  const { mode, t } = props
  const isThread = mode.kind === 'thread'
  const [expanded, setExpanded] = React.useState(!props.collapsible)
  const [content, setContent] = React.useState(props.initialContent || '')
  const [title, setTitle] = React.useState('')
  const [name, setName] = React.useState('')
  const [water, setWater] = React.useState(true)
  const [more, setMore] = React.useState(false)
  const [image, setImage] = React.useState<PendingImage | null>(null)
  const [panel, setPanel] = React.useState<null | 'kao' | 'sticker'>(null)
  const [kaoTab, setKaoTab] = React.useState('common')
  const [stickerTab, setStickerTab] = React.useState(STICKER_GROUPS[0].id)
  const [stickerBusy, setStickerBusy] = React.useState<string | null>(null)
  const [confirm, setConfirm] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [err, setErr] = React.useState('')
  const taRef = React.useRef<HTMLTextAreaElement | null>(null)
  const rootRef = React.useRef<HTMLElement | null>(null)
  const contentRef = React.useRef(content)
  React.useEffect(() => { contentRef.current = content }, [content])
  React.useEffect(() => () => { if (image) URL.revokeObjectURL(image.preview) }, [image])

  // 发串间隔倒计时（X 岛论坛级冷却，forum.interval 秒；时间戳按版面记忆）
  const threadFid = mode.kind === 'thread' ? mode.fid : ''
  const threadInterval = mode.kind === 'thread' ? mode.interval : 0
  const waitKey = mode.kind === 'thread' ? `sg.xdnmb.lastpost.${mode.fid}` : ''
  const calcWait = React.useCallback(() => {
    if (mode.kind !== 'thread' || !mode.interval) return 0
    const last = Number(localStorage.getItem(`sg.xdnmb.lastpost.${mode.fid}`) || 0)
    if (!last) return 0
    return Math.max(0, mode.interval - Math.floor((Date.now() - last) / 1000))
  }, [threadFid, threadInterval])
  const [wait, setWait] = React.useState(calcWait)
  React.useEffect(() => { setWait(calcWait()) }, [calcWait])
  React.useEffect(() => {
    if (wait <= 0) return
    const tm = window.setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000)
    return () => window.clearTimeout(tm)
  }, [wait])

  const focusCaret = (pos?: number) => {
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      const c = pos ?? ta.value.length
      ta.setSelectionRange(c, c)
    })
  }

  const insertSnippet = (snippet: string, pos?: number) => {
    const ta = taRef.current
    const cur = contentRef.current
    let start = cur.length
    let end = cur.length
    if (ta && document.activeElement === ta) {
      start = ta.selectionStart ?? cur.length
      end = ta.selectionEnd ?? start
    }
    setContent((cur.slice(0, start) + snippet + cur.slice(end)).slice(0, MAX_CONTENT))
    focusCaret(start + (pos ?? snippet.length))
  }

  React.useImperativeHandle(ref, () => ({
    insertQuote(id: number) {
      setExpanded(true)
      setPanel(null)
      const v = contentRef.current
      const prefix = v.trim() ? `${v.trimEnd()}\n` : ''
      const q = `${prefix}>>No.${id}\n`
      setContent(q.slice(0, MAX_CONTENT))
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        focusCaret(q.length)
      })
    },
  }), [])

  const wrapSpoiler = () => {
    const ta = taRef.current
    const cur = contentRef.current
    let start = cur.length
    let end = start
    if (ta && document.activeElement === ta) {
      start = ta.selectionStart ?? cur.length
      end = ta.selectionEnd ?? start
    }
    const sel = cur.slice(start, end)
    setContent(`${cur.slice(0, start)}[h]${sel}[/h]${cur.slice(end)}`.slice(0, MAX_CONTENT))
    focusCaret(start + 3 + sel.length)
  }

  const replaceImage = (file: File, stickerName?: string) => {
    setImage((old) => {
      if (old) URL.revokeObjectURL(old.preview)
      return { file, preview: URL.createObjectURL(file), stickerName }
    })
    setErr('')
  }

  const onPickFile = (file: File | null) => {
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (!IMG_EXT.has(ext)) {
      setErr(t('xdnmb.imgTypeErr'))
      return
    }
    if (file.size > MAX_IMG) {
      setErr(t('xdnmb.imgSizeErr'))
      return
    }
    replaceImage(file)
  }

  const pickSticker = async (s: XSticker) => {
    if (stickerBusy) return
    setStickerBusy(s.name)
    setErr('')
    try {
      const res = await fetch(stickerSrc(s.url))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'gif'
      replaceImage(new File([blob], `sticker.${ext}`, { type: blob.type || 'image/gif' }), s.name)
      setPanel(null)
    } catch (e) {
      setErr(`${t('xdnmb.stickerFail')}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setStickerBusy(null)
    }
  }

  const canSend = !sending && wait <= 0 && (!!content.trim() || !!image)

  const doSend = async () => {
    if (!canSend) return
    setSending(true)
    setErr('')
    try {
      const fd = new FormData()
      if (mode.kind === 'reply') {
        fd.set('action', 'reply')
        fd.set('resto', String(mode.threadId))
      } else {
        fd.set('action', 'postthread')
        fd.set('fid', mode.fid)
      }
      if (content.trim()) fd.set('content', content)
      if (mode.kind === 'thread' && title.trim()) fd.set('title', title.trim().slice(0, 100))
      if (name.trim()) fd.set('name', name.trim().slice(0, 100))
      if (image) {
        fd.set('image', image.file)
        if (water) fd.set('water', 'true')
      }
      const r = await xsubmit(fd)
      setContent(''); setTitle(''); setName(''); setMore(false)
      setImage((old) => { if (old) URL.revokeObjectURL(old.preview); return null })
      setConfirm(false)
      if (mode.kind === 'thread') {
        localStorage.setItem(waitKey, String(Date.now()))
        setWait(mode.interval)
        setExpanded(false)
      }
      props.onPosted(String(r.message || t(mode.kind === 'thread' ? 'xdnmb.threadOk' : 'xdnmb.replyOk')))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  if (!props.canPost) {
    return (
      <section className="panel x-composer">
        <button type="button" className="ghost-button x-composer-login" onClick={props.onOpenSettings}>
          <User size={13} /> {t('xdnmb.replyNeedCookie')}
        </button>
      </section>
    )
  }

  if (props.collapsible && !expanded) {
    return (
      <section className="panel x-composer x-composer-launch">
        <button type="button" className="primary-button x-newthread-btn" onClick={() => setExpanded(true)}>
          <MessageSquare size={14} /> {t('xdnmb.newThread')}
        </button>
        {props.rulesHtml && (
          <RulesToggle t={t} rulesHtml={props.rulesHtml} onContentClick={(e) => props.onContentClick?.(e)} onGoForum={props.onGoForum} />
        )}
        {wait > 0 && (
          <span className="x-wait-hint"><Clock size={12} /> {t('xdnmb.intervalWait').replace('{n}', String(wait))}</span>
        )}
      </section>
    )
  }

  const kaoGroup = KAOMOJI_GROUPS.find((g) => g.id === kaoTab) || KAOMOJI_GROUPS[0]
  const stickerGroup = STICKER_GROUPS.find((g) => g.id === stickerTab) || STICKER_GROUPS[0]

  return (
    <section className="panel x-composer" ref={rootRef}>
      {isThread && (
        <input
          className="x-input x-composer-title"
          value={title}
          maxLength={100}
          placeholder={t('xdnmb.titlePh')}
          onChange={(e) => setTitle(e.target.value.slice(0, 100))}
        />
      )}
      <textarea
        ref={taRef}
        className="x-input x-composer-ta"
        value={content}
        rows={isThread ? 5 : 3}
        maxLength={MAX_CONTENT}
        placeholder={isThread ? t('xdnmb.threadPh') : t('xdnmb.replyPh')}
        onChange={(e) => setContent(e.target.value.slice(0, MAX_CONTENT))}
      />

      {image && (
        <div className="x-img-chip">
          <img src={image.preview} alt="" />
          <span className="x-img-chip-meta">
            {image.stickerName ? <><Sticker size={12} /> {image.stickerName}</> : <><FileImage size={12} /> {image.file.name}</>}
            <em>{(image.file.size / 1024).toFixed(0)} KB</em>
          </span>
          <label className="x-water-check" title={t('xdnmb.watermarkHint')}>
            <input type="checkbox" checked={water} onChange={(e) => setWater(e.target.checked)} />
            {t('xdnmb.watermark')}
          </label>
          <button type="button" className="x-icon-btn" onClick={() => setImage((old) => { if (old) URL.revokeObjectURL(old.preview); return null })} title={t('xdnmb.removeImage')}>
            <X size={13} />
          </button>
        </div>
      )}

      <div className="x-toolbar">
        {/* 阻止工具栏按钮 mousedown 抢焦：黑条包裹/光标插入依赖 textarea 的选区 */}
        <div className="x-toolbar-scroll" onMouseDown={(e) => e.preventDefault()}>
        <button type="button" className="x-tool-btn" onClick={() => setPanel(panel === 'kao' ? null : 'kao')} title={t('xdnmb.tbKaomoji')} aria-pressed={panel === 'kao'}>
          <Smile size={15} /><span>{t('xdnmb.tbKaomoji')}</span>
        </button>
        <button type="button" className="x-tool-btn" onClick={() => setPanel(panel === 'sticker' ? null : 'sticker')} title={t('xdnmb.tbSticker')} aria-pressed={panel === 'sticker'}>
          <Sticker size={15} /><span>{t('xdnmb.tbSticker')}</span>
        </button>
        <button type="button" className="x-tool-btn" onClick={() => insertSnippet('[1,100]')} title={t('xdnmb.tbDiceHint')}>
          <Dices size={15} /><span>{t('xdnmb.tbDice')}</span>
        </button>
        <button type="button" className="x-tool-btn" onClick={wrapSpoiler} title={t('xdnmb.tbSpoilerHint')}>
          <EyeOff size={15} /><span>{t('xdnmb.tbSpoiler')}</span>
        </button>
        <ImagePickButton onPick={onPickFile} t={t} />
        </div>
        {isThread && props.rulesHtml && (
          <RulesToggle t={t} rulesHtml={props.rulesHtml} onContentClick={(e) => props.onContentClick?.(e)} onGoForum={props.onGoForum} />
        )}
        <button
          type="button"
          className={`x-tool-btn x-tool-btn-more${more ? ' x-tool-btn-on' : ''}`}
          onClick={() => setMore((v) => !v)}
          aria-pressed={more}
        >
          <ChevronDown size={15} className={more ? 'x-chevron-up' : ''} /><span>{t('xdnmb.moreOptions')}</span>
        </button>
      </div>

      {more && (
        <div className="x-more-opts">
          <input
            className="x-input x-name-input"
            value={name}
            maxLength={100}
            placeholder={t('xdnmb.namePh')}
            onChange={(e) => setName(e.target.value.slice(0, 100))}
          />
        </div>
      )}

      <div className="x-composer-bar">
        <span className="x-composer-warn">{t('xdnmb.replyIrreversible')}</span>
        <span className={`x-composer-count${content.length >= MAX_CONTENT - 200 ? ' x-count-warn' : ''}`}>{content.length}/{MAX_CONTENT}</span>
        {wait > 0 ? (
          <button type="button" className="primary-button x-composer-send" disabled title={t('xdnmb.intervalWait').replace('{n}', String(wait))}>
            <Clock size={13} /> {wait}s
          </button>
        ) : (
          <button type="button" className="primary-button x-composer-send" disabled={!canSend} onClick={() => setConfirm(true)}>
            <Send size={13} />
            {isThread ? t('xdnmb.threadSend') : t('xdnmb.replySend')}
          </button>
        )}
      </div>

      {err && <div className="x-form-error">{err}</div>}

      {/* 颜文字 / 贴纸：底部弹层（手机为 bottom sheet，桌面居中窄弹层） */}
      {panel === 'kao' && (
        <>
          <div className="x-sheet-mask" onClick={() => setPanel(null)} />
          <div className="x-sheet" role="dialog" aria-label={t('xdnmb.tbKaomoji')}>
            <div className="x-sheet-head">
              <div className="x-sheet-tabs">
                {KAOMOJI_GROUPS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={`x-sheet-tab${kaoTab === g.id ? ' x-sheet-tab-on' : ''}`}
                    onClick={() => setKaoTab(g.id)}
                  >
                    {t(`xdnmb.kaoTab.${g.id}`)}
                  </button>
                ))}
              </div>
              <button type="button" className="x-icon-btn" onClick={() => setPanel(null)} aria-label="close"><X size={14} /></button>
            </div>
            <div className="x-sheet-body">
              {kaoTab === 'all' && (
                <div className="x-snip-row" onMouseDown={(e) => e.preventDefault()}>
                  {SNIPPETS.map((s) => (
                    <button key={s.text} type="button" className="x-snip-btn" onClick={() => insertSnippet(s.text)} title={t(`xdnmb.snip.${s.label}`)}>
                      {t(`xdnmb.snip.${s.label}`)}
                    </button>
                  ))}
                </div>
              )}
              <div className={kaoTab === 'art' ? 'x-kao-grid x-kao-art' : 'x-kao-grid'} onMouseDown={(e) => e.preventDefault()}>
                {kaoGroup.items.map((it, i) => (
                  <button
                    key={`${it.text}-${i}`}
                    type="button"
                    className={kaoTab === 'art' ? 'x-kao-art-btn' : 'x-kao-btn'}
                    title={'label' in it && it.label ? it.label : undefined}
                    onClick={() => insertSnippet(it.text)}
                  >
                    {it.text}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {panel === 'sticker' && (
        <>
          <div className="x-sheet-mask" onClick={() => setPanel(null)} />
          <div className="x-sheet" role="dialog" aria-label={t('xdnmb.tbSticker')}>
            <div className="x-sheet-head">
              <div className="x-sheet-tabs">
                {STICKER_GROUPS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={`x-sheet-tab${stickerTab === g.id ? ' x-sheet-tab-on' : ''}`}
                    onClick={() => setStickerTab(g.id)}
                  >
                    {t(`xdnmb.stickerTab.${g.id}`)}
                  </button>
                ))}
              </div>
              <button type="button" className="x-icon-btn" onClick={() => setPanel(null)} aria-label="close"><X size={14} /></button>
            </div>
            <div className="x-sheet-body">
              <div className="x-sticker-grid">
                {stickerGroup.items.map((s) => (
                  <button
                    key={s.url}
                    type="button"
                    className="x-sticker-btn"
                    title={s.name}
                    disabled={!!stickerBusy}
                    onClick={() => void pickSticker(s)}
                  >
                    {stickerBusy === s.name
                      ? <RefreshCw size={18} className="spin" />
                      : <img src={stickerSrc(s.url)} alt={s.name} loading="lazy" />}
                  </button>
                ))}
              </div>
              <p className="x-sticker-note">{t('xdnmb.stickerNote')}</p>
            </div>
          </div>
        </>
      )}

      {/* 二次确认：防止误触；展示目标/图片/版规与不可逆警告 */}
      {confirm && (
        <div className="x-modal-mask" onClick={() => { if (!sending) setConfirm(false) }}>
          <div className="panel x-modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <div className="x-modal-head">
              <AlertTriangle size={16} />
              <strong>{t('xdnmb.confirmTitle')}</strong>
            </div>
            <div className="x-modal-body">
              <p className="x-confirm-line">
                {isThread ? t('xdnmb.confirmThreadTo') : t('xdnmb.confirmReplyTo')}
                <strong>{props.targetLabel}</strong>
              </p>
              <p className="x-confirm-line">
                {t('xdnmb.confirmChars')}：{content.trim().length}
                {image && <> · {image.stickerName ? t('xdnmb.confirmSticker') : t('xdnmb.confirmImage')}：{image.stickerName || image.file.name}</>}
              </p>
              {isThread && props.rulesHtml && (
                <div className="x-modal-rules">
                  <div className="x-modal-rules-head"><ScrollText size={12} /> {t('xdnmb.rulesTitle')}</div>
                  <RulesBox rulesHtml={props.rulesHtml} onContentClick={(e) => props.onContentClick?.(e)} onGoForum={props.onGoForum} />
                </div>
              )}
              <p className="x-confirm-warn">{t('xdnmb.replyIrreversible')}</p>
            </div>
            <div className="x-modal-actions">
              <button type="button" className="ghost-button" disabled={sending} onClick={() => setConfirm(false)}>{t('xdnmb.confirmCancel')}</button>
              <button type="button" className="primary-button x-confirm-ok" disabled={!canSend} onClick={() => void doSend()}>
                {sending ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
                {sending ? t('xdnmb.replySending') : t('xdnmb.confirmSend')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
})

/** 文件选择按钮（隐藏 input，避免误触直接打开系统对话框） */
function ImagePickButton(props: { onPick: (f: File | null) => void; t: TFunc }) {
  const ref = React.useRef<HTMLInputElement | null>(null)
  return (
    <>
      <button type="button" className="x-tool-btn" onClick={() => ref.current?.click()} title={props.t('xdnmb.tbImageHint')}>
        <ImagePlus size={15} /><span>{props.t('xdnmb.tbImage')}</span>
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="x-hidden-file"
        onChange={(e) => {
          props.onPick(e.target.files?.[0] || null)
          e.target.value = ''
        }}
      />
    </>
  )
}

function PostCard(props: {
  p: XPost
  t: TFunc
  fav: boolean
  sub: boolean
  /** 版块名（DawnIslandK 风格右上角 chip：版块名 • 回复数） */
  forumName?: string
  onOpen: () => void
  onToggleFav: () => void
  onToggleSub: () => void
  onReport: (id: number) => void
  onImg: (src: string) => void
  onContentClick: (e: React.MouseEvent) => void
  summary?: boolean
}) {
  const { p, t } = props
  const img = thumb(p)
  return (
    <section className="panel x-post">
      <div className="x-post-row">
        {img && (
          <img
            src={img}
            alt=""
            loading="lazy"
            onClick={(e) => { e.stopPropagation(); props.onImg(fullImg(p)) }}
            className="x-thumb"
          />
        )}
        <div className="x-post-main" onClick={props.onOpen} role="button" tabIndex={0}>
          <div className="x-post-head">
            {p.title && p.title !== '无标题' && <strong className="x-post-title">{p.title}</strong>}
            <span className="x-no">No.{p.id}</span>
            {p.sage ? <span className="x-badge x-badge-sage">SAGE</span> : null}
            {p.admin ? <span className="x-badge x-badge-admin">ADMIN</span> : null}
            {(props.forumName || typeof p.ReplyCount === 'number') && (
              <span className="x-forum-chip">
                {props.forumName}
                {props.forumName && typeof p.ReplyCount === 'number' ? ' • ' : ''}
                {typeof p.ReplyCount === 'number' ? `${t('xdnmb.replies')} ${p.ReplyCount}` : ''}
              </span>
            )}
          </div>
          <div
            className={`x-content${props.summary ? ' x-content-summary' : ''}`}
            onClickCapture={props.onContentClick}
            dangerouslySetInnerHTML={{ __html: p.content }}
          />
          <div className="x-meta">
            <span>{p.now}</span>
            <span>ID: {p.user_hash}</span>
            {typeof p.RemainReplies === 'number' && p.RemainReplies > 0 && <span>+{p.RemainReplies}</span>}
          </div>
        </div>
      </div>
      <div className="x-actions">
        <button type="button" className="ghost-button x-actbtn" onClick={(e) => { e.stopPropagation(); props.onOpen() }}>
          {t('xdnmb.open')}
        </button>
        <button type="button" className="x-icon-btn x-actbtn" onClick={(e) => { e.stopPropagation(); props.onToggleFav() }} title={t('xdnmb.favs')}>
          {props.fav ? <StarOff size={13} /> : <Star size={13} />}
        </button>
        <button type="button" className="x-icon-btn x-actbtn" onClick={(e) => { e.stopPropagation(); props.onToggleSub() }} title={t('xdnmb.subs')}>
          {props.sub ? <BellOff size={13} /> : <Bell size={13} />}
        </button>
        {p.img && (
          <button type="button" className="x-icon-btn x-actbtn" onClick={(e) => { e.stopPropagation(); props.onImg(fullImg(p)) }} title={t('xdnmb.openImage')}>
            <ImageIcon size={13} />
          </button>
        )}
        <button type="button" className="x-icon-btn x-actbtn x-report-btn" onClick={(e) => { e.stopPropagation(); props.onReport(p.id) }} title={t('xdnmb.report')} aria-label={t('xdnmb.report')}>
          <Flag size={13} />
        </button>
      </div>
    </section>
  )
}

function ThreadView(props: {
  thread: XPost
  page: number
  t: TFunc
  fav: boolean
  sub: boolean
  forumName?: string
  rulesHtml?: string
  immersive: boolean
  canReply: boolean
  onToggleFav: () => void
  onToggleSub: () => void
  onReport: (id: number) => void
  onImg: (src: string) => void
  onContentClick: (e: React.MouseEvent) => void
  onGoForum?: (fid: string) => void
  onOpenSettings: () => void
  onPosted: (message: string) => void
}) {
  const { thread: th, t } = props
  const poImg = th.img && th.ext ? fullImg(th) : ''

  // 第 2 页起：楼主开串留言若较长（>200 纯文本字）默认折叠，把屏幕让给当页回复
  const poPlain = th.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const canCollapsePo = props.page >= 2 && (poPlain.length > 200 || (!!poImg && poPlain.length > 80))
  const [poExpanded, setPoExpanded] = React.useState(false)
  React.useEffect(() => { setPoExpanded(false) }, [th.id, props.page])

  // 只看Po：非 Po 楼层整楼折叠、只显示字数；点单条可临时展开
  const [poOnly, setPoOnly] = React.useState(false)
  const [unfolded, setUnfolded] = React.useState<Set<number>>(() => new Set())
  React.useEffect(() => { setPoOnly(false); setUnfolded(new Set()) }, [th.id])
  const plainLen = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length

  // 回复编辑器（统一组件；网页版端点，一经发送不可修改/删除）
  const composerRef = React.useRef<XComposerHandle>(null)
  const quote = React.useCallback((id: number) => {
    composerRef.current?.insertQuote(id)
  }, [])

  // 导出整串（动态加载，md/html/txt/json）
  const [exportOpen, setExportOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState<{ fmt: string; done: number; total: number } | null>(null)
  const [exportErr, setExportErr] = React.useState('')
  const exportBtnRef = React.useRef<HTMLButtonElement | null>(null)
  const exportMenuRef = React.useRef<HTMLDivElement | null>(null)
  const closeExport = React.useCallback(() => setExportOpen(false), [])
  // 桌面端锚定按钮并做视口钳制；窄屏走 CSS 底部 sheet
  const exportPos = useAnchoredPop(exportOpen, exportBtnRef, exportMenuRef, closeExport, { align: 'right', gap: 4 })

  const doExport = async (fmt: 'md' | 'html' | 'txt' | 'json') => {
    setExportOpen(false)
    setExportErr('')
    setExporting({ fmt, done: 0, total: 1 })
    try {
      const mod = await import('@/lib/xdnmb-export')
      const { thread: full, replies } = await mod.fetchFullThread(
        String(th.id),
        Number(th.ReplyCount) || 0,
        async (p) => {
          const data = await xget({ action: 'thread', id: String(th.id), page: String(p) })
          return data.thread as XPost
        },
        (done, total) => setExporting({ fmt, done, total }),
      )
      const content = mod.buildExport(fmt, full, replies)
      mod.downloadTextFile(mod.safeFileName(full, fmt), mod.exportMime(fmt), content)
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : String(e))
      window.setTimeout(() => setExportErr(''), 4000)
    } finally {
      setExporting(null)
    }
  }

  // 导出控件（顶栏与沉浸模式右上悬浮共用一份；沉浸时顶栏这份隐藏）
  const exportControl = (
    <div className="x-export-wrap">
      {exporting ? (
        <span className="x-export-progress" title={t('xdnmb.exporting')}>
          <RefreshCw size={13} className="spin" />
          {exporting.done}/{exporting.total}
        </span>
      ) : (
        <button
          ref={exportBtnRef}
          type="button"
          className="x-icon-btn"
          onClick={(e) => { e.stopPropagation(); setExportOpen((v) => !v) }}
          title={t('xdnmb.exportThread')}
          aria-label={t('xdnmb.exportThread')}
          aria-expanded={exportOpen}
        >
          <Download size={14} />
        </button>
      )}
      {exportOpen && !exporting && (
        <>
          <div className="x-pop-mask" onClick={closeExport} />
          <div ref={exportMenuRef} className="x-export-menu" role="menu" style={exportPos}>
            <div className="x-export-sheet-title">{t('xdnmb.exportThread')}</div>
            {(['md', 'html', 'txt', 'json'] as const).map((f) => (
              <button key={f} type="button" role="menuitem" onClick={() => void doExport(f)}>
                {t(`xdnmb.export.${f}`)}
              </button>
            ))}
            <button type="button" className="x-export-cancel" onClick={closeExport}>
              {t('xdnmb.cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  )
  const poFilterBtn = (
    <button
      type="button"
      className={`x-icon-btn${poOnly ? ' x-topbtn-active' : ''}`}
      onClick={() => setPoOnly((v) => !v)}
      title={t('xdnmb.poOnly')}
      aria-pressed={poOnly}
      aria-label={t('xdnmb.poOnly')}
    >
      <Eye size={14} />
    </button>
  )

  return (
    <>
      {/* 沉浸模式右上悬浮：只看Po + 导出（顶栏隐藏后的替代入口） */}
      {props.immersive && (
        <div className="x-float-tr">
          {poFilterBtn}
          {exportControl}
        </div>
      )}

      {/* 楼主主串：强调卡片 */}
      <section className="panel x-po" id={`x-${th.id}`}>
        <div className="x-po-ribbon">PO</div>
        <div className="x-post-head">
          {th.title && th.title !== '无标题' && <strong className="x-po-title">{th.title}</strong>}
          <span className="x-no">No.{th.id}</span>
          {th.sage ? <span className="x-badge x-badge-sage">SAGE</span> : null}
          {th.admin ? <span className="x-badge x-badge-admin">ADMIN</span> : null}
          {props.forumName && <span className="x-forum-chip">{props.forumName}</span>}
          {props.rulesHtml && (
            <RulesToggle
              t={t}
              rulesHtml={props.rulesHtml}
              onContentClick={props.onContentClick}
              onGoForum={props.onGoForum}
            />
          )}
          <span className="x-po-spacer" />
          {!props.immersive && poFilterBtn}
          {!props.immersive && exportControl}
          <button type="button" className="x-icon-btn" onClick={props.onToggleFav} title={t('xdnmb.favs')}>
            {props.fav ? <StarOff size={14} /> : <Star size={14} />}
          </button>
          <button type="button" className="x-icon-btn" onClick={props.onToggleSub} title={t('xdnmb.subs')}>
            {props.sub ? <BellOff size={14} /> : <Bell size={14} />}
          </button>
        </div>
        {exportErr && <div className="x-form-error x-export-err">{exportErr}</div>}
        <div className={`x-po-body${canCollapsePo && !poExpanded ? ' x-po-collapsed' : ''}`}>
          <div className="x-content x-content-po" onClickCapture={props.onContentClick} dangerouslySetInnerHTML={{ __html: th.content }} />
          {poImg && (
            <img
              src={poImg}
              alt=""
              loading="lazy"
              onClick={() => props.onImg(poImg)}
              className="x-po-img"
            />
          )}
        </div>
        {canCollapsePo && (
          <button type="button" className="x-po-toggle" onClick={(e) => { e.stopPropagation(); setPoExpanded((v) => !v) }}>
            {poExpanded ? t('xdnmb.poCollapse') : t('xdnmb.poExpand')}
            <ChevronDown size={13} className={poExpanded ? 'x-chevron-up' : ''} />
          </button>
        )}
        <div className="x-meta">
          <span>{th.now}</span>
          <span>ID: {th.user_hash}</span>
          {typeof th.ReplyCount === 'number' && <span>{t('xdnmb.replies')}: {th.ReplyCount}</span>}
          {props.canReply && (
            <button type="button" className="x-quote-btn" onClick={() => quote(th.id)} title={t('xdnmb.quote')}>
              <Quote size={12} /> {t('xdnmb.quote')}
            </button>
          )}
          <button type="button" className="x-quote-btn x-report-btn" onClick={() => props.onReport(th.id)} title={t('xdnmb.report')}>
            <Flag size={12} /> {t('xdnmb.report')}
          </button>
        </div>
      </section>

      {/* 回复楼层；同串内 user_hash 与楼主相同的回复做不打扰的弱突出。
          只看Po 时其余楼层整楼折叠，仅显示字数，点击可展开 */}
      {(th.Replies || []).map((r) => {
        const isPoReply = !!th.user_hash && r.user_hash === th.user_hash
        if (r.user_hash === 'Tips') {
          return (
            <div key={r.id} className="x-tips" dangerouslySetInnerHTML={{ __html: r.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }} />
          )
        }
        if (poOnly && !isPoReply && !unfolded.has(r.id)) {
          return (
            <button
              key={r.id}
              type="button"
              className="x-reply-folded"
              onClick={() => setUnfolded((s) => { const n = new Set(s); n.add(r.id); return n })}
              title={t('xdnmb.poOnly')}
            >
              <span className="x-no">No.{r.id}</span>
              <span className="x-folded-len">
                {t('xdnmb.foldedReply')} · {t('xdnmb.chars').replace('{n}', String(plainLen(r.content)))}
              </span>
              <Eye size={13} />
            </button>
          )
        }
        return (
          <section key={r.id} id={`x-${r.id}`} className={`x-reply${isPoReply ? ' x-reply-po' : ''}`}>
            <div className="x-reply-head">
              <strong className="x-no">No.{r.id}</strong>
              {isPoReply && <span className="x-po-chip">Po</span>}
              <span>{r.now}</span>
              <span>ID: {r.user_hash}</span>
              {r.admin ? <span className="x-badge x-badge-admin">ADMIN</span> : null}
              {props.canReply && (
                <button type="button" className="x-quote-btn" onClick={() => quote(r.id)} title={t('xdnmb.quote')}>
                  <Quote size={12} />
                </button>
              )}
              <button type="button" className="x-quote-btn x-report-btn" onClick={() => props.onReport(r.id)} title={t('xdnmb.report')} aria-label={t('xdnmb.report')}>
                <Flag size={12} />
              </button>
            </div>
            <div className="x-reply-body">
              <div className="x-content" onClickCapture={props.onContentClick} dangerouslySetInnerHTML={{ __html: r.content }} />
              {r.img && r.ext && (
                <img
                  src={`/api/xdnmb?action=img&kind=thumb&p=${encodeURIComponent(r.img + r.ext)}`}
                  alt=""
                  loading="lazy"
                  onClick={() => props.onImg(`/api/xdnmb?action=img&kind=image&p=${encodeURIComponent(r.img + r.ext)}`)}
                  className="x-reply-img"
                />
              )}
            </div>
          </section>
        )
      })}

      {/* 回复编辑器：发送后不可修改/删除，仅能向委员会申诉（含颜文字/贴纸/骰子/黑条/图片） */}
      <XComposer
        ref={composerRef}
        mode={{ kind: 'reply', threadId: th.id }}
        targetLabel={props.forumName ? `${props.forumName} · No.${th.id}` : `No.${th.id}`}
        t={t}
        canPost={props.canReply}
        onOpenSettings={props.onOpenSettings}
        onPosted={props.onPosted}
        onContentClick={props.onContentClick}
        onGoForum={props.onGoForum}
      />
    </>
  )
}

/** 分页器：首页 / 上一页 / 点击页码跳页 / 下一页 / 末页（末页仅串详情，总数已知） */
function Pager(props: {
  page: number
  hasMore: boolean
  lastHint?: number
  t: TFunc
  onGo: (page: number) => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [val, setVal] = React.useState('')
  const last = props.lastHint
  const commit = () => {
    const n = Math.max(1, Number.parseInt(val, 10) || props.page)
    setEditing(false)
    if (n !== props.page) props.onGo(n)
  }
  return (
    <div className="x-pager">
      <button type="button" className="ghost-button x-page-btn" disabled={props.page <= 1} onClick={() => props.onGo(1)} title={props.t('xdnmb.firstPage')}>
        <ChevronsLeft size={14} />
      </button>
      <button type="button" className="ghost-button x-page-btn" disabled={props.page <= 1} onClick={() => props.onGo(props.page - 1)}>
        <ChevronLeft size={14} /> {props.t('xdnmb.prev')}
      </button>
      {editing ? (
        <span className="x-jump">
          <input
            autoFocus
            inputMode="numeric"
            value={val}
            placeholder={String(props.page)}
            onChange={(e) => setVal(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
            onBlur={commit}
          />
          <button type="button" className="ghost-button x-page-btn" onMouseDown={(e) => e.preventDefault()} onClick={commit}>
            {props.t('xdnmb.jump')}
          </button>
        </span>
      ) : (
        <button type="button" className="x-page-center" onClick={() => { setVal(''); setEditing(true) }} title={props.t('xdnmb.pageHint')}>
          {last ? `${props.page} / ${last}` : String(props.page)}
        </button>
      )}
      <button type="button" className="ghost-button x-page-btn" disabled={!props.hasMore} onClick={() => props.onGo(props.page + 1)}>
        {props.t('xdnmb.next')} <ChevronRight size={14} />
      </button>
      {last ? (
        <button
          type="button"
          className="ghost-button x-page-btn"
          disabled={props.page >= last}
          onClick={() => props.onGo(last)}
          title={props.t('xdnmb.lastPage')}
        >
          <ChevronsRight size={14} />
        </button>
      ) : <span className="x-page-btn-placeholder" />}
    </div>
  )
}

function TrackList(props: { items: XdnmbTrack[]; isSub: boolean; t: TFunc; onOpen: (id: number) => void; onRemove: (id: number) => void }) {
  if (props.items.length === 0) {
    return <div className="x-empty">{props.t('xdnmb.empty')}</div>
  }
  return (
    <>
      {props.items.map((it) => (
        <section key={it.id} className="panel x-track">
          <div className="x-track-main" role="button" tabIndex={0} onClick={() => props.onOpen(it.id)}>
            <div className="x-track-title">{it.title || `No.${it.id}`}</div>
            <div className="x-meta">
              <span>No.{it.id}</span>
              {props.isSub && typeof it.lastReplyCount === 'number' ? <span>{props.t('xdnmb.replies')}: {it.lastReplyCount}</span> : null}
            </div>
          </div>
          <button type="button" className="ghost-button x-actbtn" onClick={() => props.onOpen(it.id)}>{props.t('xdnmb.open')}</button>
          <button type="button" className="ghost-button x-actbtn" onClick={() => void props.onRemove(it.id)}>{props.t('xdnmb.remove')}</button>
        </section>
      ))}
    </>
  )
}

/**
 * 我的发言：浏览串时按已绑定的饼干显示名（user_hash）被动采集，
 * X 岛官方没有"按饼干查历史"接口，所以只包含本站访问过的楼层。
 */
function MyPostsList(props: {
  items: MyPost[]
  total: number
  cookieName: string
  t: TFunc
  onOpen: (tid: number, rid: number) => void
  onRemove: (id: number) => Promise<void>
}) {
  if (props.items.length === 0) {
    return (
      <div className="x-empty x-myposts-empty">
        <History size={26} />
        <p>{props.t('xdnmb.myPostsEmpty')}</p>
        {!props.cookieName && <p className="x-hint">{props.t('xdnmb.myPostsNeedName')}</p>}
      </div>
    )
  }
  return (
    <>
      <div className="x-myposts-hint">{props.t('xdnmb.myPostsCount').replace('{n}', String(props.total))}</div>
      {props.items.map((p) => (
        <section key={p.id} className="panel x-mypost">
          <div className="x-mypost-main" role="button" tabIndex={0} onClick={() => props.onOpen(p.tid, p.id)}>
            <div className="x-mypost-head">
              {p.isPo && <span className="x-po-chip">Po</span>}
              <strong className="x-no">No.{p.id}</strong>
              <span className="x-mypost-thread">{p.threadTitle || `No.${p.tid}`}</span>
            </div>
            <div className="x-content x-mypost-body" dangerouslySetInnerHTML={{ __html: p.content }} />
            {p.img && p.ext && (
              <img
                src={`/api/xdnmb?action=img&kind=thumb&p=${encodeURIComponent(p.img + p.ext)}`}
                alt=""
                loading="lazy"
                className="x-reply-img"
              />
            )}
            <div className="x-meta">
              <span>{p.now}</span>
              <span>ID: {p.userHash}</span>
            </div>
          </div>
          <button
            type="button"
            className="ghost-button x-actbtn"
            title={props.t('xdnmb.remove')}
            onClick={() => void props.onRemove(p.id)}
          >
            <X size={14} />
          </button>
        </section>
      ))}
    </>
  )
}

function ForumDrawer(props: {
  groups: XForumGroup[]
  timelines: XTimeline[]
  currentFid: string | null
  currentTid: string | null
  t: TFunc
  onClose: () => void
  onPickForum: (fid: string, name: string) => void
  onPickTimeline: (tid: string, name: string) => void
}) {
  const [q, setQ] = React.useState('')
  // 默认所有分区折叠；用户手动展开/收起的状态按组 ID 记忆
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    const all = new Set(props.groups.map((g) => g.id))
    try {
      const raw = localStorage.getItem(DRAWER_KEY)
      if (raw) {
        const stored: unknown = JSON.parse(raw)
        if (Array.isArray(stored)) return new Set(stored.filter((x): x is string => typeof x === 'string'))
      }
    } catch { /* ignore */ }
    return all
  })
  const ql = q.trim().toLowerCase()
  const searching = ql.length > 0

  const toggleGroup = (id: string) => {
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      try { localStorage.setItem(DRAWER_KEY, JSON.stringify([...n])) } catch { /* ignore */ }
      return n
    })
  }

  return (
    <div className="x-drawer-mask" onClick={props.onClose}>
      <div className="x-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="x-drawer-head">
          <strong>{props.t('xdnmb.forums')}</strong>
          <button type="button" className="x-icon-btn" onClick={props.onClose}><X size={16} /></button>
        </div>

        <div className="x-search-box">
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={props.t('xdnmb.forumSearch')} />
        </div>

        <div className="x-quick">
          <button
            type="button"
            className={`x-quick-item${props.currentFid === '4' ? ' active' : ''}`}
            onClick={() => props.onPickForum('4', props.t('xdnmb.defaultForum'))}
          >
            <Flame size={15} />
            <span>{props.t('xdnmb.defaultForum')}</span>
          </button>
        </div>

        {props.timelines.length > 0 && !searching && (
          <div className="x-tl-section">
            <div className="x-tl-head">
              <Clock size={13} />
              <span>{props.t('xdnmb.timelines')}</span>
              <span className="x-tl-count">{props.timelines.length}</span>
            </div>
            <div className="x-tl-grid">
              {props.timelines.map((tl) => (
                <button
                  key={tl.id}
                  type="button"
                  className={`x-tl-item${props.currentTid === tl.id ? ' active' : ''}`}
                  onClick={() => props.onPickTimeline(tl.id, tl.display_name || tl.name)}
                  title={tl.notice || ''}
                >
                  <span>{tl.display_name || tl.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="x-drawer-list">
          {props.groups.map((g) => {
            const forums = g.forums.filter(
              (f) => f.id !== '-1' && (!searching || f.name.toLowerCase().includes(ql) || (f.showName || '').toLowerCase().includes(ql)),
            )
            if (forums.length === 0) return null
            const isCollapsed = !searching && collapsed.has(g.id)
            return (
              <div key={g.id} className="x-fgroup">
                <button type="button" className="x-fgroup-head" onClick={() => toggleGroup(g.id)}>
                  <ChevronDown size={13} className={isCollapsed ? 'x-chevron' : ''} />
                  <span>{g.name}</span>
                  <span className="x-fgroup-count">{forums.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="x-forum-grid">
                    {forums.map((f) => {
                      const main = (f.showName || f.name).replace(/<[^>]+>/g, '').trim()
                      const active = props.currentFid === f.id
                      return (
                        <button
                          key={f.id}
                          type="button"
                          className={`x-forum-item${active ? ' active' : ''}`}
                          onClick={() => props.onPickForum(f.id, f.name)}
                          title={f.msg || main}
                        >
                          <span className="x-forum-name">{main}</span>
                          {f.thread_count ? <span className="x-forum-count">{f.thread_count}</span> : null}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * 引用预览弹层：先给楼主/被引楼内容预览，再决定定位或跳串。
 * 桌面端贴近点击点；窄屏转为底部卡片（避让浮动按钮）。
 */
function RefPopover(props: {
  spec: RefSpec
  t: TFunc
  inThreadId: string | null
  onClose: () => void
  onReopen: (s: RefSpec) => void
  onLocate: (tid: string, rid: number, setStatus?: (s: string) => void) => Promise<boolean>
  onOpenThread: (id: string) => void
}) {
  const { spec, t } = props
  const [post, setPost] = React.useState<XPost | null>(refCache.get(spec.id) ?? null)
  const [fail, setFail] = React.useState(false)
  const [status, setStatus] = React.useState('')
  const [notFound, setNotFound] = React.useState(false)

  React.useEffect(() => {
    const cached = refCache.get(spec.id)
    if (cached) { setPost(cached); setFail(false); return }
    let cancelled = false
    // 弹层内切换到另一引用：先清掉旧楼内容，避免标题/正文短暂错位
    setPost(null)
    setFail(false)
    setNotFound(false)
    setStatus('')
    void (async () => {
      try {
        const data = await xget({ action: 'ref', id: spec.id })
        if (cancelled) return
        refCache.set(spec.id, data.post as XPost)
        setPost(data.post as XPost)
        setFail(false)
      } catch {
        if (!cancelled) setFail(true)
      }
    })()
    return () => { cancelled = true }
  }, [spec.id])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  // 弹层内部再点引用：原地换楼
  const onInnerClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    let mm = /^xdnmb:ref:(\d+)/.exec(href)
    if (mm) {
      e.preventDefault()
      props.onReopen({ kind: 'ref', id: mm[1], x: e.clientX, y: e.clientY })
      return
    }
    mm = /^xdnmb:thread:(\d+)/.exec(href)
    if (mm) {
      e.preventDefault()
      props.onReopen({ kind: 'thread', id: mm[1], x: e.clientX, y: e.clientY })
    }
  }

  const posStyle = React.useMemo((): React.CSSProperties => {
    if (typeof window === 'undefined') return {}
    if (window.innerWidth <= 600) return {}
    const width = 356
    // 与 CSS 中 .x-ref-pop 的 max-height 保持一致，保证操作栏始终在视口内
    const maxH = Math.min(window.innerHeight * 0.72, 560)
    const left = Math.max(8, Math.min(spec.x - width / 2, window.innerWidth - width - 8))
    const top = Math.min(Math.max(8, spec.y + 12), window.innerHeight - maxH - 8)
    return { left, top, width }
  }, [spec.x, spec.y])

  const img = post && post.img && post.ext
    ? `/api/xdnmb?action=img&kind=thumb&p=${encodeURIComponent(post.img + post.ext)}`
    : ''

  return (
    <>
      <div className="x-ref-mask" onClick={props.onClose} />
      <div className={`x-ref-pop${window.innerWidth <= 600 ? ' x-ref-sheet' : ''}`} style={posStyle}>
        <div className="x-ref-head">
          <span className="x-no">No.{spec.id}</span>
          {post?.admin ? <span className="x-badge x-badge-admin">ADMIN</span> : null}
          <span className="x-ref-kind">{spec.kind === 'thread' ? t('xdnmb.refThread') : t('xdnmb.refPost')}</span>
          <span className="x-po-spacer" />
          <button type="button" className="x-icon-btn" onClick={props.onClose}><X size={13} /></button>
        </div>

        {!post && !fail && <div className="x-ref-loading"><RefreshCw size={15} className="spin" /> {t('xdnmb.refLoading')}</div>}
        {fail && <div className="x-ref-fail">{t('xdnmb.refFail')}</div>}

        {post && (
          <>
            <div className="x-ref-body">
              <div className="x-content x-content-ref" onClickCapture={onInnerClick} dangerouslySetInnerHTML={{ __html: post.content }} />
              {img && <img className="x-ref-img" src={img} alt="" loading="lazy" />}
            </div>
            <div className="x-meta x-ref-meta">
              <span>{post.now}</span>
              <span>ID: {post.user_hash}</span>
            </div>
          </>
        )}

        <div className="x-ref-actions">
          {spec.kind === 'ref' && props.inThreadId && (
            <button
              type="button"
              className="primary-button x-ref-go"
              disabled={!!status}
              onClick={async () => {
                setNotFound(false)
                const ok = await props.onLocate(props.inThreadId!, Number(spec.id), setStatus)
                if (!ok) setNotFound(true)
              }}
            >
              <Crosshair size={13} /> {status || t('xdnmb.locate')}
            </button>
          )}
          {spec.kind === 'thread' && (
            <button type="button" className="primary-button x-ref-go" onClick={() => props.onOpenThread(spec.id)}>
              {t('xdnmb.openThread')}
            </button>
          )}
          {notFound && <span className="x-ref-notfound">{t('xdnmb.notFound')}</span>}
        </div>
      </div>
    </>
  )
}

/** 单块饼干行：备注内联编辑（失焦保存）、7 位 ID、尾部脱敏、设为使用中 / 删除 */
function CookieRow(props: {
  cookie: { userhash: string; alias: string; cookieName: string }
  isActive: boolean
  disabled: boolean
  t: TFunc
  onAlias: (alias: string) => void
  onSetActive: () => void
  onDel: () => void
}) {
  const { t } = props
  const [alias, setAlias] = React.useState(props.cookie.alias)
  React.useEffect(() => { setAlias(props.cookie.alias) }, [props.cookie.alias])
  return (
    <div className={`x-cookie-row${props.isActive ? ' active' : ''}`}>
      <input
        className="x-input x-cookie-alias"
        value={alias}
        maxLength={32}
        placeholder={t('xdnmb.aliasPh')}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setAlias(e.target.value)}
        onBlur={() => { if (alias.trim() !== props.cookie.alias) props.onAlias(alias.trim()) }}
      />
      {props.cookie.cookieName ? <span className="x-cookie-id">ID: {props.cookie.cookieName}</span> : null}
      <span className="x-cookie-tail">…{props.cookie.userhash.slice(-4)}</span>
      <span className="x-cookie-spacer" />
      {props.isActive ? (
        <span className="x-cookie-active-chip">{t('xdnmb.cookieInUse')}</span>
      ) : (
        <button type="button" className="ghost-button x-cookie-use" disabled={props.disabled} onClick={props.onSetActive}>
          {t('xdnmb.cookieUse')}
        </button>
      )}
      <button
        type="button"
        className="x-icon-btn x-cookie-del"
        disabled={props.disabled}
        onClick={props.onDel}
        title={t('xdnmb.cookieDel')}
        aria-label={t('xdnmb.cookieDel')}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

/**
 * 设置弹窗：
 * - 订阅 ID 是论坛身份凭据：官网用户中心登录后凭它最多领取 5 块饼干
 * - 饼干是匿名发言身份，帖子上显示的 ID 就是饼干 ID；增删/切换即时生效且不关弹窗
 * - 保存只提交订阅 ID / 显示名 / TG 推送目标（settings_save），饼干操作走 cookie_* 动作
 */
function SettingsDialog(props: {
  t: TFunc
  onClose: () => void
  onIdentityChange: (names: string[]) => void
  onSaved: (hasCookie: boolean, cookieName: string, names: string[]) => void
}) {
  const { t } = props
  type CookieItem = { userhash: string; alias: string; cookieName: string }
  const mapCookies = (list: unknown): CookieItem[] =>
    (Array.isArray(list) ? list : [])
      .map((c: { userhash?: unknown; alias?: unknown; cookieName?: unknown }) => ({
        userhash: String(c.userhash || ''),
        alias: String(c.alias || ''),
        cookieName: String(c.cookieName || ''),
      }))
      .filter((c) => c.userhash)
  const [cookies, setCookies] = React.useState<CookieItem[]>([])
  const [active, setActive] = React.useState('')
  // 显示名：默认跟随使用中的饼干（即帖子上的 ID），可手动覆盖
  const [cookieName, setCookieName] = React.useState('')
  const [feedUuid, setFeedUuid] = React.useState('')
  const [chat, setChat] = React.useState('')
  const [raw, setRaw] = React.useState('')
  const [loaded, setLoaded] = React.useState(false)
  const [busyUh, setBusyUh] = React.useState('') // 行级操作锁
  const [addBusy, setAddBusy] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [err, setErr] = React.useState('')

  React.useEffect(() => {
    void (async () => {
      try {
        const s = await xpost({ action: 'settings_get' })
        setCookies(mapCookies(s.cookies))
        setActive(String(s.userhash || '').trim())
        setCookieName(String(s.cookieName || ''))
        setFeedUuid(String(s.feedUuid || ''))
        setChat(String(s.tgChat || ''))
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setLoaded(true)
      }
    })()
  }, [])

  // “我的发言”采集身份：手动显示名 + 各饼干 ID（去重）
  const allNames = (list: CookieItem[], manual: string) =>
    Array.from(new Set([manual.trim(), ...list.map((c) => c.cookieName.trim())].filter(Boolean)))

  const runRow = async (uh: string, fn: () => Promise<void>) => {
    setBusyUh(uh)
    setErr('')
    try {
      await fn()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyUh('')
    }
  }

  const addCookie = async () => {
    const body = raw.trim()
    if (!body || addBusy) return
    setAddBusy(true)
    setErr('')
    try {
      const r = await xpost({ action: 'cookie_add', raw: body })
      const list = mapCookies(r.cookies)
      const act = String(r.active || '')
      setCookies(list)
      setActive(act)
      // 使用中饼干的显示名自动同步（首个添加时服务端已写库）
      const hit = list.find((c) => c.userhash === act)
      if (hit?.cookieName) setCookieName(hit.cookieName)
      setRaw('')
      props.onIdentityChange(allNames(list, hit?.cookieName || cookieName))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAddBusy(false)
    }
  }

  const switchActive = (uh: string) =>
    runRow(uh, async () => {
      await xpost({ action: 'cookie_active', userhash: uh })
      setActive(uh)
      const hit = cookies.find((c) => c.userhash === uh)
      const name = hit?.cookieName || ''
      if (name) setCookieName(name)
      props.onIdentityChange(allNames(cookies, name || cookieName))
    })

  const delCookie = (uh: string) =>
    runRow(uh, async () => {
      const wasActive = active === uh
      const r = await xpost({ action: 'cookie_del', userhash: uh })
      const list = mapCookies(r.cookies)
      const act = String(r.active || '')
      setCookies(list)
      setActive(act)
      // 删的是使用中的饼干：显示名顺延到下一块（服务端已同步写库）
      if (wasActive) {
        const hit = list.find((c) => c.userhash === act)
        setCookieName(hit?.cookieName || '')
        props.onIdentityChange(allNames(list, hit?.cookieName || ''))
      } else {
        props.onIdentityChange(allNames(list, cookieName))
      }
    })

  const saveAlias = (uh: string, alias: string) =>
    runRow(uh, async () => {
      await xpost({ action: 'cookie_alias', userhash: uh, alias })
      setCookies((list) => list.map((c) => (c.userhash === uh ? { ...c, alias } : c)))
    })

  const save = async () => {
    setErr('')
    const cleanName = cookieName.trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 16)
    const cleanUuid = feedUuid.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    if (!cleanUuid) {
      setErr(t('xdnmb.uuidRequired'))
      return
    }
    setSaving(true)
    try {
      const r = await xpost({ action: 'settings_save', cookieName: cleanName, feedUuid: cleanUuid, chat })
      setFeedUuid(String(r.feedUuid || cleanUuid))
      const actHit = cookies.find((c) => c.userhash === active)
      props.onSaved(!!active, actHit?.cookieName || cleanName, allNames(cookies, cleanName))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <div className="x-modal-mask" onClick={props.onClose}>
      <div onClick={(e) => e.stopPropagation()} className="panel x-modal">
        <h3 style={{ margin: '0 0 12px' }}>{t('xdnmb.settingsTitle')}</h3>
        {!loaded ? <div style={{ color: 'var(--muted)' }}><RefreshCw size={16} className="spin" /></div> : (
          <>
            <div className="x-bind-status">
              <span className={`x-bind-badge${active ? ' ok' : ''}`}>
                {active ? t('xdnmb.cookieBound') : t('xdnmb.cookieUnbound')}
              </span>
              <span className="x-bind-tail">{t('xdnmb.cookieCount').replace('{n}', String(cookies.length))}</span>
            </div>

            {/* 账号：订阅 ID（身份凭据，官网登录后凭它领取饼干） */}
            <div className="x-settings-section">
              <span className="x-settings-section-title"><User size={13} /> {t('xdnmb.subIdSection')}</span>
              <label className="x-field-label">{t('xdnmb.subIdLabel')}</label>
              <div className="x-uuid-row">
                <input
                  value={feedUuid}
                  onChange={(e) => setFeedUuid(e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64))}
                  placeholder="feed uuid"
                  autoComplete="off"
                  spellCheck={false}
                  className="x-input x-input-mono"
                />
                <button
                  type="button"
                  className="ghost-button x-uuid-gen"
                  onClick={() => setFeedUuid(crypto.randomUUID())}
                >
                  {props.t('xdnmb.genUuid')}
                </button>
              </div>
              <p className="x-hint">{t('xdnmb.subIdHint')}</p>
            </div>

            {/* 饼干：匿名发言身份（最多 5 块），帖子上显示的 ID 就是饼干 ID */}
            <div className="x-settings-section">
              <span className="x-settings-section-title"><ScanLine size={13} /> {t('xdnmb.cookieSection')}</span>
              {cookies.length === 0 && <p className="x-hint">{t('xdnmb.cookieNone')}</p>}
              {cookies.map((c) => (
                <CookieRow
                  key={c.userhash}
                  cookie={c}
                  isActive={c.userhash === active}
                  disabled={busyUh !== ''}
                  t={t}
                  onAlias={(a) => void saveAlias(c.userhash, a)}
                  onSetActive={() => void switchActive(c.userhash)}
                  onDel={() => void delCookie(c.userhash)}
                />
              ))}
              <div className="x-cookie-add">
                <input
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  placeholder={t('xdnmb.cookieAddPh')}
                  autoComplete="off"
                  spellCheck={false}
                  className="x-input x-input-mono"
                />
                <button
                  type="button"
                  className="primary-button x-cookie-add-btn"
                  disabled={!raw.trim() || addBusy || cookies.length >= 5}
                  onClick={() => void addCookie()}
                >
                  {addBusy ? <RefreshCw size={13} className="spin" /> : <ScanLine size={13} />}
                  {t('xdnmb.cookieAdd')}
                </button>
              </div>
              <p className="x-hint" dangerouslySetInnerHTML={{ __html: t('xdnmb.cookieMgmtHint') }} />
              <label className="x-field-label">{t('xdnmb.cookieNameLabel')}</label>
              <input
                value={cookieName}
                onChange={(e) => setCookieName(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 16))}
                placeholder={t('xdnmb.cookieNamePh')}
                autoComplete="off"
                spellCheck={false}
                className="x-input x-input-mono"
              />
              <p className="x-hint">{t('xdnmb.cookieNameHint')}</p>
            </div>

            {/* Telegram 推送（可选） */}
            <div className="x-settings-section">
              <span className="x-settings-section-title"><Bell size={13} /> Telegram</span>
              <label className="x-field-label">{props.t('xdnmb.tgChatLabel')}</label>
              <input
                value={chat}
                onChange={(e) => setChat(e.target.value)}
                placeholder="Telegram chat_id（如 123456789 或 -100...）"
                inputMode="numeric"
                className="x-input"
              />
            </div>

            {err && <div className="x-form-error">{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="ghost-button" onClick={props.onClose}>{t('xdnmb.cancel')}</button>
              <button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{t('xdnmb.save')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
