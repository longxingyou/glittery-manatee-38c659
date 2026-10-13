import { createFileRoute } from '@tanstack/react-router'

import * as dbApi from '../../db/index.js'
import { runInBackground } from '../lib/server-env.js'
import {
  C233_BOARD_GROUPS,
  c233Board,
  c233ImgUpstream,
  getCatalog,
  getThread,
  getTimeline,
} from '../lib/chan233-server.js'

/**
 * /api/c233 —— 233chan（里岛匿名版）只读浏览（仅管理员，不开放分享）。
 *
 * - GET  action=boards|catalog|thread|img
 * - 只读不发言：vichan 发帖需过验证码，无可编程发言通道。
 * - 图片走边缘缓存（缩略图 7 天 / 原图与旗帜 30 天），高强度浏览不触达网关与源站。
 * - 响应一律 noindex；列表类短缓存 30 秒（快速翻页/返回零请求）。
 */

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

const SHORT_CACHE_HEADERS = {
  'Cache-Control': 'private, max-age=30',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

// ── 附件边缘缓存（缩略图/原图文件名是内容 hash 永不变；旗帜固定）──
const IMG_EDGE_TTL: Record<string, number> = { thumb: 7 * 86400, src: 30 * 86400, flag: 30 * 86400 }
const IMG_BROWSER_TTL: Record<string, number> = { thumb: 3 * 86400, src: 14 * 86400, flag: 14 * 86400 }
const IMG_PATH_RE: Record<string, RegExp> = {
  thumb: /^[A-Za-z0-9]{1,20}\/thumb\/[\w.+-]+\.(?:png|jpe?g|gif|webp)$/,
  src: /^[A-Za-z0-9]{1,20}\/src\/[\w.+-]+\.(?:png|jpe?g|gif|webp|mp4|webm|mp3|pdf)$/,
  flag: /^assets\/countryballs\/[\w]+\.(?:png|gif)$/,
}
const imgCacheKey = (kind: string, p: string) => `https://c233-img-cache.local/${kind}/${p}`

async function serveImg(kind: 'thumb' | 'src' | 'flag', p: string): Promise<Response> {
  const cache = (caches as CacheStorage & { default: Cache }).default
  const key = imgCacheKey(kind, p)
  const hit = await cache.match(key).catch(() => undefined)
  if (hit) {
    return new Response(hit.body, {
      status: hit.status,
      headers: {
        'Content-Type': hit.headers.get('content-type') || 'image/png',
        'Cache-Control': `private, max-age=${IMG_BROWSER_TTL[kind]}`,
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Cache': 'HIT',
      },
    })
  }
  const upstream = await c233ImgUpstream(p)
  const edgeRes = new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.contentType,
      'Cache-Control': `public, s-maxage=${IMG_EDGE_TTL[kind]}, max-age=${IMG_EDGE_TTL[kind]}`,
    },
  })
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
    return Response.json({ ok: false, error: '需要管理员登录。' }, { status: 401, headers: PRIVATE_HEADERS })
  }
}

async function handleGet(url: URL): Promise<Response> {
  const denied = await requireAdminOr401()
  if (denied) return denied
  const action = url.searchParams.get('action') || ''

  // ── 附件代理（缩略图/原图/国别旗帜；SSRF 白名单 + 网关优先）──
  if (action === 'img') {
    const kindParam = url.searchParams.get('kind') || 'thumb'
    if (!(kindParam in IMG_PATH_RE)) return Response.json({ ok: false, error: '非法的附件类型。' }, { status: 400, headers: PRIVATE_HEADERS })
    const kind = kindParam as 'thumb' | 'src' | 'flag'
    const p = (url.searchParams.get('p') || '').trim()
    if (!IMG_PATH_RE[kind].test(p)) return Response.json({ ok: false, error: '非法的附件路径。' }, { status: 400, headers: PRIVATE_HEADERS })
    try {
      return await serveImg(kind, p)
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : '附件拉取失败' },
        { status: 502, headers: PRIVATE_HEADERS },
      )
    }
  }

  switch (action) {
    case 'boards':
      return Response.json({ ok: true, groups: C233_BOARD_GROUPS }, { headers: PRIVATE_HEADERS })
    case 'timeline': {
      const timeline = await getTimeline()
      return Response.json({ ok: true, ...timeline }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'catalog': {
      const board = (url.searchParams.get('board') || '').trim()
      if (!c233Board(board)) return Response.json({ ok: false, error: '未知版面。' }, { status: 400, headers: PRIVATE_HEADERS })
      const cards = await getCatalog(board)
      return Response.json({ ok: true, board, cards }, { headers: SHORT_CACHE_HEADERS })
    }
    case 'thread': {
      const board = (url.searchParams.get('board') || '').trim()
      const id = (url.searchParams.get('id') || '').trim()
      if (!c233Board(board)) return Response.json({ ok: false, error: '未知版面。' }, { status: 400, headers: PRIVATE_HEADERS })
      if (!/^\d{1,12}$/.test(id)) return Response.json({ ok: false, error: '缺少串 ID。' }, { status: 400, headers: PRIVATE_HEADERS })
      const thread = await getThread(board, id)
      return Response.json({ ok: true, board, id, thread }, { headers: SHORT_CACHE_HEADERS })
    }
    default:
      return Response.json({ ok: false, error: '未知的 233chan 动作。' }, { status: 404, headers: PRIVATE_HEADERS })
  }
}

export const Route = createFileRoute('/api/c233')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        try {
          return await handleGet(url)
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : '233chan 工具内部错误。' },
            { status: 500, headers: PRIVATE_HEADERS },
          )
        }
      },
    },
  },
})
