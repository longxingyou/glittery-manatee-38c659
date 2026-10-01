/**
 * 三级缓存基础设施（Cloudflare Workers 免费额度友好）。
 *
 *   L1 进程内存（TtlCache）—— 免费、无限额，同 isolate 命中 ~0ms
 *   L2 边缘 Cache API（caches.default）—— 免费、无使用限制，同 colo 共享，~5ms
 *   L3 KV —— 跨 colo 全球共享，但免费版有日限额（读 100,000 / 写删 1,000 每天，
 *      具体以 Dashboard 为准）。本模块对 KV 做了熔断器封装：一旦命中日限额
 *      错误（"limit exceeded for the day" / 429），当天剩余时间直接短路，
 *      不再发起 KV 请求，页面无感降级到 L1/L2 → SSR，绝不向用户返回 429。
 *
 * 限额用尽后的访问路径：L1 → L2（挡住同 colo 绝大部分重复访问）→ SSR；
 * SSR 内的数据查询仍有进程内存缓存与 Neon（cron 每 5 分钟 SELECT 1 保活）兜底，
 * DB 故障时数据层还有 KV 过期快照（safeKvGet force 模式）作为最后防线。
 */

// ────────────────────────────────────────────────────────────
// L1：进程内 TTL 缓存（Map + 过期时间 + 容量上限，近似 LRU 淘汰最旧 key）
// ────────────────────────────────────────────────────────────
export class TtlCache<T> {
  private store = new Map<string, { value: T; expireAt: number }>()
  constructor(private readonly maxEntries = 50) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (hit.expireAt < Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expireAt: Date.now() + ttlMs })
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

// ────────────────────────────────────────────────────────────
// L3：KV 熔断器
// ────────────────────────────────────────────────────────────

/** KV 命名空间的最小结构（与 server-env.ts 中定义兼容） */
export interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

// Cloudflare 日限额错误形如：'KV put() limit exceeded for the day. Try again tomorrow.'
// 同时兼容 429 / rate limited / quota exceeded 等变体。
const QUOTA_ERROR_RE = /limit exceeded|too many requests|rate[- ]?limit|quota|^\s*429\s*$/i

let kvReadDisabledUntil = 0
let kvWriteDisabledUntil = 0

/** UTC 当天 00:00（即限额重置时刻）的时间戳 */
function utcNextMidnight(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
}

function isQuotaError(e: unknown): boolean {
  if (e == null) return false
  if (e instanceof Error) return QUOTA_ERROR_RE.test(e.message) || QUOTA_ERROR_RE.test(e.name)
  return QUOTA_ERROR_RE.test(String(e))
}

/** 缓存操作硬超时：任何缓存层都不能拖慢主请求，超时即视为 miss/失败。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cache-op-timeout>${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const KV_OP_TIMEOUT_MS = 4_000
const EDGE_OP_TIMEOUT_MS = 2_500

/** KV 读熔断是否处于打开状态（诊断用） */
export function isKvReadCircuitOpen(): boolean {
  return Date.now() < kvReadDisabledUntil
}

/** KV 写/删熔断是否处于打开状态（诊断用） */
export function isKvWriteCircuitOpen(): boolean {
  return Date.now() < kvWriteDisabledUntil
}

/**
 * 熔断感知的 KV 读。
 * - 熔断期间直接返回 null（等同 cache miss，上层无缝走 L2/SSR）；
 * - 任何错误都吞掉返回 null，缓存层永不抛出；
 * - 硬超时 4s：KV 后端长尾挂起时快速降级，绝不拖慢主请求；
 * - @param force 用于 DB 故障时读取过期快照（stale-while-error）的最后兜底，
 *   即使熔断打开也尝试一次（失败请求不产生费用，且有 try/catch）。
 */
export async function safeKvGet(kv: KvLike | undefined, key: string, force = false): Promise<string | null> {
  if (!kv) return null
  if (!force && Date.now() < kvReadDisabledUntil) return null
  try {
    return await withTimeout(kv.get(key), KV_OP_TIMEOUT_MS)
  } catch (e) {
    if (isQuotaError(e)) kvReadDisabledUntil = utcNextMidnight()
    return null
  }
}

/**
 * 熔断感知的 KV 写。
 * @returns 是否真正写入成功（false 表示熔断/失败，调用方无需关心）
 */
export async function safeKvPut(
  kv: KvLike | undefined,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (!kv) return false
  if (Date.now() < kvWriteDisabledUntil) return false
  try {
    await kv.put(key, value, { expirationTtl: ttlSeconds })
    return true
  } catch (e) {
    if (isQuotaError(e)) kvWriteDisabledUntil = utcNextMidnight()
    return false
  }
}

/** 熔断感知的 KV 删（缓存主动失效用）；熔断期间跳过，旧缓存自然过期。 */
export async function safeKvDelete(kv: KvLike | undefined, key: string): Promise<void> {
  if (!kv || Date.now() < kvWriteDisabledUntil) return
  try {
    await kv.delete(key)
  } catch (e) {
    if (isQuotaError(e)) kvWriteDisabledUntil = utcNextMidnight()
  }
}

// ────────────────────────────────────────────────────────────
// L2：Cloudflare Cache API（caches.default）
// 免费且无使用次数限制；限制是按 colo 隔离（不跨 colo 共享），
// 但小博客访客集中在少数 colo，命中率仍然很高。
// ────────────────────────────────────────────────────────────
const edgeCache: Cache | null = (() => {
  try {
    return (caches as CacheStorage & { default: Cache }).default
  } catch {
    return null
  }
})()

/** 从边缘缓存读文本；任何环境/错误/长尾挂起（2.5s 硬超时）都静默降级为 miss。 */
export async function edgeCacheGet(url: string): Promise<string | null> {
  if (!edgeCache) return null
  try {
    const res = await withTimeout(edgeCache.match(new Request(url)), EDGE_OP_TIMEOUT_MS)
    if (res) return await res.text()
  } catch {
    /* Cache API 不可用/超时时忽略 */
  }
  return null
}

/**
 * 写入边缘缓存。
 * @param ttlSeconds 缓存保留时长（通过 s-maxage 控制）
 */
export async function edgeCacheSet(url: string, body: string, ttlSeconds: number): Promise<void> {
  if (!edgeCache) return
  try {
    await withTimeout(
      edgeCache.put(
        new Request(url),
        new Response(body, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            // Cache API 依据 s-maxage/max-age 决定保留时长；private/no-store 会被拒绝
            'Cache-Control': `public, s-maxage=${ttlSeconds}`,
          },
        }),
      ),
      EDGE_OP_TIMEOUT_MS,
    )
  } catch {
    /* 写入失败不影响主响应 */
  }
}

/**
 * 删除边缘缓存条目（文章保存/删除后主动失效）。
 * caches.default 按 colo 隔离：只能清当前 colo，其它 colo 的旧副本按
 * s-maxage（10 分钟）自然过期；任何错误都静默——失效失败不阻断写操作。
 */
export async function edgeCacheDelete(url: string): Promise<void> {
  if (!edgeCache) return
  try {
    await withTimeout(edgeCache.delete(new Request(url)), EDGE_OP_TIMEOUT_MS)
  } catch {
    /* 删除失败时旧缓存等 TTL 自然过期 */
  }
}
