import { createFileRoute } from '@tanstack/react-router'

import * as dbApi from '../../db/index.js'
import { runInBackground } from '../lib/server-env.js'
import {
  X_IMG,
  addFeed,
  delFeed,
  getFeeds,
  getForums,
  getRef,
  getThread,
  getTimelineList,
  showForum,
  showTimeline,
  xImgUpstream,
  xSubmitPost,
} from '../lib/xdnmb-server.js'
import type { XSubmitInput } from '../lib/xdnmb-server.js'

/**
 * /api/xdnmb —— X 岛匿名版浏览（仅管理员，不开放分享）。
 *
 * - GET  action=forums|timelines|showf|timeline|thread|ref|feed|myposts|img|tracked|search|index_search|index_stats
 * - POST action=settings_get|settings_save|cookie_*|fav_*|feed_add|feed_del|myposts_see|myposts_del|index_crawl|index_seed（JSON）
 * - POST action=reply|postthread（multipart/form-data，可带 image 图片附件与 water 水印）
 *
 * 身份模型（与 X 岛官方一致）：
 * - 订阅 ID（feed uuid）= 论坛身份凭据：官网用户中心登录后凭它获取/管理最多 5 个饼干，
 *   也用于官方 Api/feed 的订阅同步（跨客户端互通）；
 * - 饼干（userhash）= 发言身份：帖子上显示的 7 位 ID 就是饼干 ID（user_hash）。
 *   官方无程序化登录 API，饼干从官网用户中心获取（二维码 JSON 形如 {"cookie","name"}），
 *   本站做本地多饼干管理（备注=黎明岛的饼干备注，用于管理多个身份）；
 * - 发串/回复走网页版端点 doPostThread/doReplyThread.html（无 JSON API），正文上限 10000 字，
 *   图片为可选附件（jpg/png/gif/webp，原图直传）；一经发送不可修改/删除；
 * - 自家 Neon 另存收藏（X 岛无收藏概念）、订阅镜像（供 TG 推送 cron）与"我的发言"采集。
 *
 * 响应一律 no-store + noindex。
 */

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

// 只读列表允许浏览器短缓存（private 不进共享缓存；快速来回翻页/返回零请求），
// 手动刷新（cache: reload）与换饼干后刷新可绕过
const SHORT_CACHE_HEADERS = {
  'Cache-Control': 'private, max-age=30',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

function jsonError(error: string, status = 400, extra?: Record<string, unknown>): Response {
  return Response.json({ ok: false, error, ...extra }, { status, headers: PRIVATE_HEADERS })
}

// ── 图片边缘缓存（图片文件名是内容 hash，永不变；缩略图 7 天 / 原图 30 天）──
// 高强度浏览时图片占请求大头：命中边缘缓存后完全不触达 Azure 网关与 X 岛图床。
const IMG_EDGE_TTL: Record<string, number> = { thumb: 7 * 86400, image: 30 * 86400 }
const IMG_BROWSER_TTL: Record<string, number> = { thumb: 3 * 86400, image: 14 * 86400 }
const imgCacheKey = (kind: string, p: string) => `https://xdnmb-img-cache.local/${kind}/${p}`

async function serveImg(kind: 'thumb' | 'image', p: string): Promise<Response> {
  const cache = (caches as CacheStorage & { default: Cache }).default
  const key = imgCacheKey(kind, p)
  const hit = await cache.match(key).catch(() => undefined)
  if (hit) {
    return new Response(hit.body, {
      status: hit.status,
      headers: {
        'Content-Type': hit.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': `private, max-age=${IMG_BROWSER_TTL[kind]}`,
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Cache': 'HIT',
      },
    })
  }
  const upstream = await xImgUpstream(kind, p)
  // 一份存边缘（s-maxage 决定边缘 TTL），一份回浏览器（private max-age）
  const edgeRes = new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.contentType,
      'Cache-Control': `public, s-maxage=${IMG_EDGE_TTL[kind]}, max-age=${IMG_EDGE_TTL[kind]}`,
    },
  })
  // 响应返回后续跑写入（runInBackground → ctx.waitUntil），不增加首字节延迟
  runInBackground(cache.put(key, edgeRes.clone()).catch(() => {}))
  return new Response(edgeRes.body, {
    status: edgeRes.status,
    headers: {
      'Content-Type': upstream.contentType,
      'Cache-Control': `private, max-age=${IMG_BROWSER_TTL[kind]}`,
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Cache': 'MISS',
    },
  })
}

async function requireAdminOr401(): Promise<Response | null> {
  try {
    await dbApi.requireAdmin()
    return null
  } catch {
    return jsonError('需要管理员登录。', 401)
  }
}

async function handleGet(url: URL): Promise<Response> {
  const denied = await requireAdminOr401()
  if (denied) return denied
  const { userhash, feedUuid } = await dbApi.getXdnmbSettings()
  const action = url.searchParams.get('action') || ''

  // ── 图片代理（无需 DB 饼干；SSRF 白名单 + 经 Azure 网关绕开 Worker 出口 403）──
  if (action === 'img') {
    const kind = url.searchParams.get('kind') === 'thumb' ? 'thumb' : 'image'
    const p = (url.searchParams.get('p') || '').trim()
    if (!/^[\w/-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(p)) return jsonError('非法的图片路径。')
    try {
      return await serveImg(kind, p)
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : '图片拉取失败', 502)
    }
  }

  const page = Math.max(1, Number(url.searchParams.get('page') || '1') | 0 || 1)

  switch (action) {
    case 'forums': {
      const groups = await getForums(userhash)
      return Response.json({ ok: true, groups }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'timelines': {
      const timelines = await getTimelineList()
      return Response.json({ ok: true, timelines }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'showf': {
      const fid = (url.searchParams.get('fid') || '').trim()
      if (!/^-?\d{1,8}$/.test(fid)) return jsonError('缺少版面 ID。')
      const posts = await showForum(fid, page, userhash)
      return Response.json({ ok: true, posts, page }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'timeline': {
      const tid = (url.searchParams.get('id') || '').trim()
      if (!/^\d{1,6}$/.test(tid)) return jsonError('缺少时间线 ID。')
      const posts = await showTimeline(tid, page, userhash)
      return Response.json({ ok: true, posts, page }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'thread': {
      const id = (url.searchParams.get('id') || '').trim()
      if (!/^\d{6,12}$/.test(id)) return jsonError('缺少串 ID。')
      const thread = await getThread(id, page, userhash)
      return Response.json({ ok: true, thread, page }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'ref': {
      const id = (url.searchParams.get('id') || '').trim()
      if (!/^\d{6,12}$/.test(id)) return jsonError('缺少楼 ID。')
      const post = await getRef(id, userhash)
      return Response.json({ ok: true, post }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'search': {
      // X 岛搜索：代理到 nmb-search（4get + Google CSE，专用 X 岛索引）。
      // 上游偶发 Google captcha，返回 { ok:false, error } 由前端提示用户稍后重试。
      const q = (url.searchParams.get('q') || '').trim()
      if (!q) return jsonError('请输入搜索关键词。')
      if (q.length > 100) return jsonError('关键词过长。')
      const upstream = `https://nmb-search.166666666.xyz/api/v1/web?s=${encodeURIComponent(q)}`
      let res: Response
      try {
        res = await fetch(upstream, {
          headers: { 'User-Agent': 'Syntax-Garden-Xdnmb-Search/1.0' },
          signal: AbortSignal.timeout(12000),
        })
      } catch {
        return jsonError('搜索服务暂时不可用，请稍后重试。', 502)
      }
      if (!res.ok) return jsonError(`搜索服务返回 HTTP ${res.status}。`, 502)
      let data: any
      try {
        data = await res.json()
      } catch {
        return jsonError('搜索服务返回了无法解析的响应。', 502)
      }
      if (data?.status && typeof data.status === 'string' && data.status !== 'ok') {
        return jsonError(`搜索失败：${data.status}`)
      }
      // 4get 返回的是 data.web（不是 data.results）
      const results = Array.isArray(data?.web) ? data.web : (Array.isArray(data?.results) ? data.results : [])
      // 提取 X 岛串 ID：URL 形如 /t/<id>、/m/t/<id>（移动端）或 /Forum/po/id/<id>.html
      const items = results
        .map((r: any) => {
          const url = String(r.url || '')
          const m = /\/(?:t|m\/t)\/(\d+)/.exec(url) || /\/Forum\/po\/id\/(\d+)/.exec(url)
          const id = m ? Number(m[1]) : null
          // ?r=<回帖号>：搜索引擎标记的命中楼，用于前端串内定位
          const rm = /[?&]r=(\d+)/.exec(url)
          return {
            id,
            r: rm ? Number(rm[1]) : null,
            url,
            title: String(r.title || '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
            snippet: String(r.snippet || r.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 400),
          }
        })
        .filter((r: any) => r.id)
      return Response.json({ ok: true, query: q, items }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'feed': {
      // 官方订阅列表（按 uuid 同步）；顺手镜像到本地 xdnmb_subs 供 TG 推送 cron
      const posts = await getFeeds(feedUuid, page)
      runInBackground(
        Promise.all(
          posts.map((p) =>
            dbApi
              .addXdnmbSub({ id: p.id, fid: p.fid ?? null, title: p.title || (p.content || '').replace(/<[^>]+>/g, ' ').slice(0, 60) })
              .catch(() => {}),
          ),
        ).then(() => {}),
      )
      return Response.json({ ok: true, posts, page }, { headers: PRIVATE_HEADERS })
    }
    case 'myposts': {
      const { items, total } = await dbApi.listXdnmbMyPosts(page)
      return Response.json({ ok: true, items, total, page }, { headers: PRIVATE_HEADERS })
    }
    case 'tracked': {
      const tracked = await dbApi.getXdnmbTrackedIds()
      return Response.json({ ok: true, ...tracked }, { headers: PRIVATE_HEADERS })
    }
    case 'index_search': {
      // 本地索引搜索：rid=回帖号反查父串；q=关键词全文搜索
      // 解决 >>No.xxx 直跳（X岛 API 无法从楼层号反查父串）与全论坛搜索
      // 覆盖面比 nmb-search 广（爬虫持续索引时间线/版面所有公开串）
      const rid = (url.searchParams.get('rid') || '').trim()
      const q = (url.searchParams.get('q') || '').trim()
      if (rid) {
        if (!/^\d{1,12}$/.test(rid)) return jsonError('非法的楼层 ID。')
        const hit = await dbApi.findXdnmbThreadByPostId(Number(rid))
        return Response.json({ ok: true, rid: Number(rid), hit }, { headers: PRIVATE_HEADERS })
      }
      if (!q) return jsonError('请输入搜索关键词。')
      if (q.length > 100) return jsonError('关键词过长。')
      const hits = await dbApi.searchXdnmbIndex(q, 50)
      return Response.json({ ok: true, query: q, hits }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'index_stats': {
      // 本地索引覆盖量统计（前端显示"已索引 N 串 / M 楼"）
      const stats = await dbApi.getXdnmbIndexStats()
      return Response.json({ ok: true, ...stats }, { headers: SHORT_CACHE_HEADERS })
    }
    default:
      return jsonError('未知的 X 岛动作。', 404)
  }
}

/**
 * 发串/回复（multipart/form-data）——X 岛只有网页版端点，无 JSON API。
 * 图片走原图直传（用户明确不压缩），网关 25MB 上限，这里 20MB 留余量。
 */
async function handleSubmit(request: Request): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonError('表单解析失败。')
  }
  const action = String(form.get('action') || '')
  if (action !== 'reply' && action !== 'postthread') return jsonError('未知的发言动作。', 404)

  const { userhash } = await dbApi.getXdnmbSettings()
  if (!userhash) return jsonError('尚未选用饼干：请先在设置中添加并选用一个饼干。')

  const content = String(form.get('content') || '').trim()
  const title = String(form.get('title') || '').trim().slice(0, 100)
  const name = String(form.get('name') || '').trim().slice(0, 100)
  const water = form.get('water') === 'true'
  if (content.length > 10000) return jsonError('正文过长：上限 10000 字。')

  let image: XSubmitInput['image'] = null
  const file = form.get('image')
  if (file instanceof File && file.size > 0) {
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (!/^(jpg|jpeg|png|gif|webp)$/.test(ext)) {
      return jsonError('只支持 jpg / jpeg / png / gif / webp 格式的图片。')
    }
    if (file.size > 20 * 1024 * 1024) {
      return jsonError('图片超过 20MB，X 岛很可能拒收；请压缩或换一张后再发。')
    }
    // 随机文件名（xdcmd 同款做法），扩展名保持与内容一致
    image = { blob: file, filename: `${crypto.randomUUID().replace(/-/g, '')}.${ext === 'jpeg' ? 'jpg' : ext}` }
  }
  if (!content && !image) return jsonError('正文和附加图片不能同时为空。')

  const input: XSubmitInput = { content, title, name, water, image }
  if (action === 'postthread') {
    const fid = String(form.get('fid') || '').trim()
    if (!/^\d{1,8}$/.test(fid)) return jsonError('缺少版面 ID。')
    input.fid = fid
  } else {
    const tid = String(form.get('resto') || form.get('tid') || '').trim()
    if (!/^\d{6,12}$/.test(tid)) return jsonError('缺少串 ID。')
    input.resto = tid
  }

  try {
    // 不做重试：重试可能造成重复发言（回复一经发送不可修改/删除）
    const message = await xSubmitPost(userhash, input)
    return Response.json({ ok: true, message }, { headers: PRIVATE_HEADERS })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '发送失败。', 502)
  }
}

async function handlePost(request: Request): Promise<Response> {
  const denied = await requireAdminOr401()
  if (denied) return denied

  // 发串/回复（含图片附件）走 multipart/form-data；其余动作仍为 JSON
  if ((request.headers.get('content-type') || '').includes('multipart/form-data')) {
    return handleSubmit(request)
  }

  let body: {
    action?: string
    userhash?: string
    cookieName?: string
    feedUuid?: string
    chat?: string
    raw?: string
    alias?: string
    content?: string
    id?: number
    tid?: number
    tids?: number[]
    favs?: boolean
    deep?: boolean
    startPage?: number
    maxPages?: number
    fid?: number | null
    title?: string
    threadTitle?: string
    posts?: Array<{ id?: number; isPo?: boolean; content?: string; img?: string; ext?: string; now?: string; userHash?: string }>
  } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonError('请求体不是有效的 JSON。')
  }
  const action = body.action || ''
  switch (action) {
    case 'settings_get': {
      const [s, cookies] = await Promise.all([dbApi.getXdnmbSettings(), dbApi.listXdnmbCookies()])
      let { feedUuid } = s
      // 首次进入：订阅 ID 不存在则自动下发一个随机 uuid（与黎明岛默认行为一致）
      if (!feedUuid) {
        feedUuid = crypto.randomUUID()
        await dbApi.setXdnmbFeedUuid(feedUuid)
      }
      // 管理员本人查看：回显饼干/订阅 ID 方便编辑，接口本身有管理员鉴权
      return Response.json(
        { ok: true, userhash: s.userhash, cookieName: s.cookieName, feedUuid, tgChat: s.tgChat, cookies, imgBase: X_IMG },
        { headers: PRIVATE_HEADERS },
      )
    }
    case 'settings_save': {
      // 饼干的选用/增删走 cookie_* 动作，这里只管订阅 ID、显示名与 TG 推送目标
      const cookieName = String(body.cookieName ?? '')
      const feedUuid = String(body.feedUuid ?? '')
      const chat = String(body.chat ?? '')
      // uuid 仅允许字母数字与 - _，避免把异常串透传给上游
      const cleanUuid = feedUuid.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
      if (!cleanUuid) return jsonError('订阅 ID 不能为空（可点"随机生成"获取一个）。')
      await Promise.all([
        dbApi.setXdnmbCookieName(cookieName),
        dbApi.setXdnmbFeedUuid(cleanUuid),
        dbApi.setXdnmbTgChat(chat),
      ])
      return Response.json({ ok: true, feedUuid: cleanUuid }, { headers: PRIVATE_HEADERS })
    }
    case 'cookie_add': {
      // 粘贴官网用户中心二维码 JSON（{"cookie":"...","name":"..."}）或裸 userhash
      const raw = String(body.raw ?? '').trim()
      if (!raw) return jsonError('请粘贴饼干二维码 JSON 或 userhash。')
      let uh = raw
      let name = ''
      try {
        const j = JSON.parse(raw) as { cookie?: unknown; name?: unknown }
        if (j && typeof j.cookie === 'string' && j.cookie.trim()) {
          uh = j.cookie
          if (typeof j.name === 'string') name = j.name
        }
      } catch {
        // 非 JSON：按裸 userhash 处理
      }
      uh = uh.trim().replace(/^userhash=/, '').trim()
      if (!/^[A-Za-z0-9%._~+=-]{1,160}$/.test(uh)) {
        return jsonError('饼干格式不对：请粘贴官网用户中心二维码里的 JSON，或 userhash 值。')
      }
      const cookies = await dbApi.listXdnmbCookies()
      if (cookies.length >= 5 && !cookies.some((c) => c.userhash === uh)) {
        return jsonError('一个订阅 ID 最多 5 个饼干。')
      }
      const cookieName = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)
      await dbApi.addXdnmbCookie({ userhash: uh, alias: String(body.alias ?? '').trim().slice(0, 32), cookieName })
      const { userhash: active } = await dbApi.getXdnmbSettings()
      if (!active) {
        // 首个饼干自动设为使用中，并同步显示名（供"我的发言"采集）
        await dbApi.setXdnmbUserhash(uh)
        if (cookieName) await dbApi.setXdnmbCookieName(cookieName)
      }
      return Response.json({ ok: true, cookies: await dbApi.listXdnmbCookies(), active: active || uh }, { headers: PRIVATE_HEADERS })
    }
    case 'cookie_alias': {
      const uh = String(body.userhash ?? '').trim()
      if (!/^[A-Za-z0-9%._~+=-]{1,160}$/.test(uh)) return jsonError('饼干不合法。')
      await dbApi.setXdnmbCookieAlias(uh, String(body.alias ?? '').trim())
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    }
    case 'cookie_active': {
      const uh = String(body.userhash ?? '').trim()
      const cookies = await dbApi.listXdnmbCookies()
      const hit = cookies.find((c) => c.userhash === uh)
      if (!hit) return jsonError('该饼干不在列表中。')
      await dbApi.setXdnmbUserhash(uh)
      // 切换饼干时同步显示名，"我的发言"采集跟随当前身份
      if (hit.cookieName) await dbApi.setXdnmbCookieName(hit.cookieName)
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    }
    case 'cookie_del': {
      const uh = String(body.userhash ?? '').trim()
      const cookies = await dbApi.listXdnmbCookies()
      const hit = cookies.find((c) => c.userhash === uh)
      await dbApi.delXdnmbCookie(uh)
      const rest = cookies.filter((c) => c.userhash !== uh)
      const { userhash: active } = await dbApi.getXdnmbSettings()
      if (active === uh) {
        // 删的是使用中的饼干：顺延到下一个（没有则清空），显示名同步处理
        const next = rest[0]
        await dbApi.setXdnmbUserhash(next ? next.userhash : '')
        if (hit?.cookieName && (await dbApi.getXdnmbSettings()).cookieName === hit.cookieName) {
          await dbApi.setXdnmbCookieName(next?.cookieName || '')
        }
      }
      return Response.json({ ok: true, cookies: rest, active: (await dbApi.getXdnmbSettings()).userhash }, { headers: PRIVATE_HEADERS })
    }
    case 'setcookie':
      await dbApi.setXdnmbUserhash(String(body.userhash ?? ''))
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    case 'settgchat':
      await dbApi.setXdnmbTgChat(String(body.chat ?? ''))
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    case 'fav_list':
      return Response.json({ ok: true, favs: await dbApi.listXdnmbFavs() }, { headers: PRIVATE_HEADERS })
    case 'sub_list':
      return Response.json({ ok: true, subs: await dbApi.listXdnmbSubs() }, { headers: PRIVATE_HEADERS })
    case 'fav_add':
      await dbApi.addXdnmbFav({ id: Number(body.id), fid: body.fid ?? null, title: body.title || '' })
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    case 'fav_del':
      await dbApi.delXdnmbFav(Number(body.id))
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    case 'sub_add':
      await dbApi.addXdnmbSub({ id: Number(body.id), fid: body.fid ?? null, title: body.title || '' })
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    case 'sub_del':
      await dbApi.delXdnmbSub(Number(body.id))
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    case 'feed_add': {
      // 官方订阅（uuid 同步）+ 本地镜像（TG 推送 cron）
      const { feedUuid } = await dbApi.getXdnmbSettings()
      const tid = String(body.id ?? '').trim()
      if (!/^\d{6,12}$/.test(tid)) return jsonError('缺少串 ID。')
      await addFeed(feedUuid, tid)
      await dbApi.addXdnmbSub({ id: Number(tid), fid: body.fid ?? null, title: body.title || '' })
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    }
    case 'feed_del': {
      // 官方退订失败（如已在其他端退订）不阻塞本地删除，仅把告警带回前端
      const { feedUuid } = await dbApi.getXdnmbSettings()
      const tid = String(body.id ?? '').trim()
      if (!/^\d{6,12}$/.test(tid)) return jsonError('缺少串 ID。')
      let warning = ''
      try {
        await delFeed(feedUuid, tid)
      } catch (e) {
        warning = e instanceof Error ? e.message : String(e)
      }
      await dbApi.delXdnmbSub(Number(tid))
      return Response.json({ ok: true, warning }, { headers: PRIVATE_HEADERS })
    }
    case 'myposts_see': {
      // 浏览串时前端上报 user_hash 命中的楼层（官方无历史接口，被动采集）
      const tid = Number(body.tid)
      if (!Number.isFinite(tid) || tid <= 0) return jsonError('缺少串 ID。')
      const posts = (Array.isArray(body.posts) ? body.posts : [])
        .filter((p) => Number.isFinite(Number(p?.id)) && typeof p?.userHash === 'string')
        .map((p) => ({
          id: Number(p.id),
          isPo: !!p.isPo,
          content: String(p.content || ''),
          img: String(p.img || ''),
          ext: String(p.ext || ''),
          now: String(p.now || ''),
          userHash: String(p.userHash || ''),
        }))
      await dbApi.upsertXdnmbMyPosts({ tid, fid: body.fid ?? null, threadTitle: body.threadTitle || '', posts })
      return Response.json({ ok: true, saved: posts.length }, { headers: PRIVATE_HEADERS })
    }
    case 'myposts_del':
      await dbApi.delXdnmbMyPost(Number(body.id))
      return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
    case 'index_crawl': {
      // 手动触发一次爬虫周期（cron 之外的管理员即时填充入口）
      const { crawlXdnmbIndex } = await import('../lib/xdnmb-crawler.js')
      const r = await crawlXdnmbIndex()
      return Response.json({ ok: true, result: r }, { headers: PRIVATE_HEADERS })
    }
    case 'index_seed': {
      // 手动爬取指定串写入索引：body.tids=[...] 或 body.favs=true 爬取所有收藏
      // body.deep=true 深度索引（逐页爬取长串中段楼层，每批 maxPages 页，返回 nextPage 续爬）
      // 收藏夹常含用户最关心的串，对即时验证 >>No.xxx 直跳尤其有用
      // 单次最多 20 个串（防 Worker 超时；多余的下次再调）
      const { crawlThread } = await import('../lib/xdnmb-crawler.js')
      const { userhash } = await dbApi.getXdnmbSettings()
      let tids: number[] = []
      if (Array.isArray(body.tids)) {
        tids = body.tids.map((t) => Number(t)).filter((t) => Number.isFinite(t) && t > 0)
      } else if (body.favs) {
        const favs = await dbApi.listXdnmbFavs()
        tids = favs.map((f) => f.id)
      } else if (body.tid) {
        tids = [Number(body.tid)]
      }
      const batch = tids.slice(0, 20)
      const deep = !!body.deep
      const startPage = body.startPage ? Number(body.startPage) : undefined
      const maxPages = body.maxPages ? Number(body.maxPages) : undefined
      const results: Array<{ tid: number; title: string; posts: number; nextPage?: number | null; error?: string }> = []
      for (const tid of batch) {
        const r = await crawlThread(tid, userhash, { deep, startPage, maxPages })
        results.push({
          tid: r.tid,
          title: r.title,
          posts: r.posts,
          ...(r.nextPage !== undefined ? { nextPage: r.nextPage } : {}),
          ...(r.error ? { error: r.error } : {}),
        })
      }
      return Response.json(
        { ok: true, seeded: results.length, total: tids.length, results, remaining: Math.max(0, tids.length - batch.length) },
        { headers: PRIVATE_HEADERS },
      )
    }
    default:
      return jsonError('未知的 X 岛动作。', 404)
  }
}

export const Route = createFileRoute('/api/xdnmb')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        try {
          return await handleGet(url)
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : 'X 岛工具内部错误。', 500)
        }
      },
      POST: async ({ request }) => {
        try {
          return await handlePost(request)
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : 'X 岛工具内部错误。', 500)
        }
      },
    },
  },
})
