import { createFileRoute } from '@tanstack/react-router'

import * as dbApi from '../../db/index.js'
import { getEnv } from '../lib/server-env.js'

/**
 * /api/traffic —— 管理后台「流量监控」的只读数据源。
 *
 * - 仅管理员可用（sg_auth + ADMIN_EMAILS，复用 dbApi.requireAdmin）；
 * - 服务端代理 Azure 网关的 /traffic（agent 要求 X-Traffic-Key），
 *   浏览器永远拿不到该密钥；
 * - 4 秒进程内缓存，多个标签页/轮询只打一次上游；
 * - 不写 KV、不碰 Neon，单次响应 <1 KB。
 */

const ENDPOINT = 'https://gw.loong.me.uk/traffic'
const CACHE_MS = 4_000

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

export interface TrafficSnapshot {
  ok: true
  now: number
  uptimeSec: number
  rxBytes: number
  txBytes: number
  vnstat: null | {
    month: { label: string; rx: number; tx: number }
    day: { label: string; rx: number; tx: number }
  }
  load: number[]
  mem: { total: number; available: number }
  services: { singbox: string }
}

let cached: { at: number; data: TrafficSnapshot } | null = null

class TrafficError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function loadSnapshot(): Promise<TrafficSnapshot> {
  const key = (getEnv().TRAFFIC_KEY || '').trim()
  if (!key) throw new TrafficError(503, '未配置 TRAFFIC_KEY，流量监控暂不可用。')

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      headers: { 'X-Traffic-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
  } catch (e) {
    throw new TrafficError(502, `连接流量接口失败：${e instanceof Error ? e.message : '网络错误'}`)
  }
  if (!res.ok) throw new TrafficError(502, `流量接口返回 HTTP ${res.status}`)

  let data: TrafficSnapshot
  try {
    data = (await res.json()) as TrafficSnapshot
  } catch {
    throw new TrafficError(502, '流量接口返回的不是 JSON。')
  }
  if (data?.ok !== true || typeof data.rxBytes !== 'number' || typeof data.txBytes !== 'number') {
    throw new TrafficError(502, '流量接口返回格式异常。')
  }
  return data
}

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: PRIVATE_HEADERS })
}

export const Route = createFileRoute('/api/traffic')({
  server: {
    handlers: {
      GET: async () => {
        try {
          await dbApi.requireAdmin()
        } catch {
          return jsonError('需要管理员登录。', 401)
        }

        try {
          if (!cached || Date.now() - cached.at > CACHE_MS) {
            cached = { at: Date.now(), data: await loadSnapshot() }
          }
          return Response.json(cached.data, { headers: PRIVATE_HEADERS })
        } catch (e) {
          return jsonError(
            e instanceof Error ? e.message : '流量接口内部错误。',
            e instanceof TrafficError ? e.status : 500,
          )
        }
      },
    },
  },
})
