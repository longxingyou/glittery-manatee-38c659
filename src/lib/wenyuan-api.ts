/**
 * 文渊（gw.叫我.mom 上的 redbean 文档管理器）最小 API 客户端。
 *
 * 供 /api/wenyuan 路由与 wenyuan-sync cron 对账任务共用：
 *  - wenBase()：从 Worker 环境读文渊地址与管理员密码；
 *  - getWenToken()：管理员密码换会话 token（isolate 内缓存到接近过期，401 可 force 重登）；
 *  - listWenByTag() / listAllWenDocs()：分页列表（列表接口的 content 是截断的，仅供元数据）；
 *  - getWenDocFull()：取单个完整文档（全文 + currentRevisionId）。
 */
import { getEnv } from './server-env.js'

export const DEFAULT_BASE = 'https://gw.loong.me.uk'
export const LOGIN_TIMEOUT_MS = 25_000

export type WenDoc = {
  id: string
  title?: string
  content?: string
  type?: string
  tags?: string[]
  currentRevisionId?: string
}

/** 对账用的文档引用：id + 当前 revision */
export interface WenDocRef {
  id: string
  rev: string
  title: string
}

export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

/** 文渊地址 + 管理员密码（Worker 环境变量统一出口） */
export function wenBase(): { base: string; password: string } {
  const env = getEnv()
  return {
    base: (env.WENYUAN_API_URL || DEFAULT_BASE).trim().replace(/\/+$/, ''),
    password: (env.WENYUAN_ADMIN_PASSWORD || '').trim(),
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null

/** 用管理员密码换会话 token；成功后缓存到接近过期（文渊会话 TTL 为 86400s） */
export async function getWenToken(base: string, password: string, force = false): Promise<string> {
  if (!force && tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token
  const res = await fetchWithTimeout(
    `${base}/api/admin/login`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    },
    LOGIN_TIMEOUT_MS,
  )
  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: { token?: string; sessionExpiresAt?: number }; error?: string }
    | null
  if (!res.ok || !data?.success || !data.data?.token) {
    throw new Error(data?.error || `文渊登录失败（HTTP ${res.status}）`)
  }
  const ttl = Number(data.data.sessionExpiresAt)
  const expiresAt = Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 - 60_000 : Date.now() + 12 * 3600_000
  tokenCache = { token: data.data.token, expiresAt }
  return tokenCache.token
}

/** 文渊列表接口的 items 在为空时是 {} 而不是数组 */
function parseItems(body: unknown): WenDoc[] {
  const items = (body as { data?: { items?: unknown } } | null)?.data?.items
  if (Array.isArray(items)) return items.filter(Boolean) as WenDoc[]
  return Object.values(items || {}).filter(Boolean) as WenDoc[]
}

export async function listWenByTag(base: string, token: string, tag: string, limit: number): Promise<WenDoc[]> {
  const res = await fetchWithTimeout(
    `${base}/api/documents?tags=${encodeURIComponent(tag)}&limit=${limit}`,
    { headers: { authorization: `Bearer ${token}` } },
    LOGIN_TIMEOUT_MS,
  )
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`文渊列表失败（HTTP ${res.status}）`)
  return parseItems(body)
}

/**
 * 分页拉取文渊全量文档（id / currentRevisionId / 标题）。
 * 任一页失败直接抛错——对账方绝不基于残缺列表做删除。
 */
export async function listAllWenDocs(base: string, token: string, maxDocs = 1000): Promise<WenDocRef[]> {
  const out: WenDocRef[] = []
  const limit = 100
  for (let page = 1; page <= 10 && out.length < maxDocs; page++) {
    const res = await fetchWithTimeout(
      `${base}/api/documents?limit=${limit}&page=${page}`,
      { headers: { authorization: `Bearer ${token}` } },
      LOGIN_TIMEOUT_MS,
    )
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`文渊列表失败（HTTP ${res.status}）`)
    const items = parseItems(body)
    for (const it of items) {
      if (it?.id) {
        out.push({ id: String(it.id), rev: String(it.currentRevisionId || ''), title: String(it.title || '') })
      }
    }
    const data = (body as { data?: { totalPages?: number; hasNextPage?: boolean } } | null)?.data
    if (!items.length) break
    if (typeof data?.totalPages === 'number' && page >= data.totalPages) break
    if (data?.hasNextPage === false) break
  }
  return out
}

/** 取单个完整文档（列表接口的 content 是截断的，这里才是全文）；失败/不存在返回 null */
export async function getWenDocFull(base: string, token: string, id: string): Promise<WenDoc | null> {
  const res = await fetchWithTimeout(
    `${base}/api/documents/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${token}` } },
    LOGIN_TIMEOUT_MS,
  )
  const body = (await res.json().catch(() => null)) as { data?: WenDoc } | null
  if (!res.ok || !body?.data) return null
  return body.data
}
