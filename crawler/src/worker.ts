/**
 * X岛爬虫独立 Worker（与主站同账号不同 Worker 脚本，不抢请求配额）。
 *
 * cron 5min: timeline 增量 + recrawl diff（共享 50-subrequest 预算）
 * cron 6h  : catalog 全版面翻页枚举
 *
 * D1 binding XDNMB_DB 读写不计 subrequest 上限。
 * secrets: TG_GATEWAY_URL / TG_GATEWAY_SECRET / TG_GATEWAY_DL_URL
 */
import type { XdGateway } from '../../src/lib/xdnmb-api.js'
import type { D1Database } from '../../db/d1.js'
import { runTimelineCycle } from './timeline.js'
import { runRecrawlCycle } from './recrawl.js'
import { runCatalogCycle } from './catalog.js'

interface CrawlerEnv {
  XDNMB_DB: D1Database
  TG_GATEWAY_URL?: string
  TG_GATEWAY_SECRET?: string
  TG_GATEWAY_DL_URL?: string
  PUBLIC_ORIGIN?: string
}

interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

/** 从 env secrets 构造网关配置（与主站 attachment-store.gatewayConfig 算法一致） */
function makeGwFromEnv(env: CrawlerEnv): XdGateway | null {
  const url = (env.TG_GATEWAY_URL || '').trim().replace(/\/+$/, '')
  const secret = env.TG_GATEWAY_SECRET || ''
  if (!url || !secret) return null
  const dlUrl = (env.TG_GATEWAY_DL_URL || '').trim().replace(/\/+$/, '') || url
  return { url, dlUrl, secret }
}

export default {
  async scheduled(
    event: { cron?: string; scheduledTime?: number },
    env: CrawlerEnv,
    ctx: ExecutionCtx,
  ): Promise<void> {
    const cron = event.cron || ''
    const gw = makeGwFromEnv(env)
    const db = env.XDNMB_DB

    ctx.waitUntil(
      (async () => {
        if (cron === '0 */6 * * *') {
          const r = await runCatalogCycle(db, gw)
          console.log('[crawler] catalog:', JSON.stringify(r))
        } else {
          // 5min: timeline + recrawl（共享 50-subrequest 预算）
          const tr = await runTimelineCycle(db, gw)
          console.log('[crawler] timeline:', tr ? JSON.stringify(tr) : 'null')
          const rr = await runRecrawlCycle(db, gw, 5)
          console.log('[crawler] recrawl:', JSON.stringify(rr))
        }
      })().catch((e) => console.error('[crawler] cycle failed:', e instanceof Error ? (e.stack || e.message) : e)),
    )
  },

  async fetch(request: Request, env: CrawlerEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true, time: new Date().toISOString() })
    }
    // 调试：手动触发一轮爬取（令牌保护 = 网关 secret），返回真实错误便于排障
    if (url.pathname === '/debug/run') {
      const k = url.searchParams.get('k') || ''
      if (!env.TG_GATEWAY_SECRET || k !== env.TG_GATEWAY_SECRET) {
        return Response.json(
          {
            ok: false,
            error: 'forbidden',
            configured: !!env.TG_GATEWAY_SECRET,
            storedLen: env.TG_GATEWAY_SECRET ? env.TG_GATEWAY_SECRET.length : 0,
            givenLen: k.length,
          },
          { status: 403 },
        )
      }
      const gw = makeGwFromEnv(env)
      const db = env.XDNMB_DB
      const mode = url.searchParams.get('mode') || '5min'
      try {
        // probe: 诊断 timeline id 类型与 cursor 匹配（不写库）
        if (mode === 'probe') {
          const { getTimelineList } = await import('../../src/lib/xdnmb-api.js')
          const { listXdnmbIndexCursorsD1: listC } = await import('../../db/d1.js')
          const tl = await getTimelineList(gw)
          const cursors = await listC(db)
          const first = tl[0]
          return Response.json({
            ok: true,
            timelineFirst: first ? { id: first.id, idType: typeof first.id, name: first.name } : null,
            timelineCount: tl.length,
            cursors: cursors.map((c) => ({ kind: c.kind, targetId: c.targetId, page: c.page, updatedAt: c.updatedAt })),
          })
        }
        if (mode === '6h') {
          return Response.json({ ok: true, mode, result: await runCatalogCycle(db, gw) })
        }
        const timeline = await runTimelineCycle(db, gw)
        const recrawl = await runRecrawlCycle(db, gw, 5)
        return Response.json({ ok: true, mode, timeline, recrawl })
      } catch (e) {
        return Response.json(
          {
            ok: false,
            mode,
            error: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? (e.stack || null) : null,
          },
          { status: 500 },
        )
      }
    }
    return new Response('xdnmb-crawler', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  },
}
