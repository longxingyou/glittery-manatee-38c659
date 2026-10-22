/**
 * 文渊 → OSCA 对象存储的对账式同步（cron 驱动）。
 *
 * 文渊文档既会经 Worker 路由批量增删，也会直接在文渊 UI 编辑/删除——后者
 * Worker 完全感知不到。因此不靠事件钩子，而靠周期对账：
 *  - 每次运行分页列出文渊全部文档（id + currentRevisionId）；
 *  - 与 SG_CACHE 里的状态（docId → revision）比对：
 *      revision 变化/新文档 → 取全文重新 PUT 桶（wenyuan/docs/<id>.md）；
 *      状态里有而文渊没有的 → 从桶 DELETE 对应对象；
 *  - 每拍限量（Workers 免费档每请求 50 个子请求），大量变更分多拍追平；
 *    稳定态一次运行只有 1~2 个列表请求，不产生 KV 写入。
 *
 * 防误删护栏：列表为空 / 超过 MAX_DOCS / 任一页拉取失败 → 本次直接中止，绝不删除。
 * 状态损坏视作空 → 全量重传（幂等），下一拍建立新状态。
 */
import { getEnv } from './server-env.js'
import { isOscaConfigured, oscaDocKey, oscaPutObject, oscaDeleteObject } from './osca.js'
import { wenBase, getWenToken, listAllWenDocs, getWenDocFull } from './wenyuan-api.js'

const STATE_KEY = 'osca:wensync:v1'
/** 文档数超过此值说明列表可能不完整，禁止删除（fail-safe） */
const MAX_DOCS = 600
/** 每拍最多重传的文档数：12×(GET全文+PUT) + 10×DELETE + 列表/登录/KV ≈ 40 < 50 */
const MAX_PUTS = 12
const MAX_DELETES = 10

/** SG_CACHE 里的对账状态：docId → 备份成功时的 currentRevisionId */
type SyncState = { v: 1; docs: Record<string, string> }

export interface SyncResult {
  skipped?: string
  scanned?: number
  updated?: number
  deleted?: number
  pendingPuts?: number
  pendingDeletes?: number
}

export async function runWenyuanOscaSync(): Promise<SyncResult> {
  const { base, password } = wenBase()
  if (!password) return { skipped: 'no-wenyuan-password' }
  if (!isOscaConfigured()) return { skipped: 'no-osca-config' }
  const kv = getEnv().SG_CACHE
  if (!kv) return { skipped: 'no-kv' }

  const token = await getWenToken(base, password)
  const docs = await listAllWenDocs(base, token)
  if (docs.length === 0) return { skipped: 'empty-list', scanned: 0 }
  if (docs.length > MAX_DOCS) return { skipped: 'too-many-docs', scanned: docs.length }

  let state: SyncState = { v: 1, docs: {} }
  try {
    const raw = await kv.get(STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as SyncState | null
      if (parsed?.v === 1 && parsed.docs && typeof parsed.docs === 'object') {
        state = { v: 1, docs: parsed.docs }
      }
    }
  } catch {
    // 状态损坏视作空：全部重传（幂等），下一拍建立新状态
  }

  const current = new Map(docs.map((d) => [d.id, d.rev]))
  const toPut = docs.filter((d) => state.docs[d.id] !== d.rev)
  const toDelete = Object.keys(state.docs).filter((id) => !current.has(id))

  let updated = 0
  for (const d of toPut.slice(0, MAX_PUTS)) {
    try {
      const full = await getWenDocFull(base, token, d.id)
      if (!full || typeof full.content !== 'string' || !full.content) continue
      const r = await oscaPutObject(oscaDocKey(d.id), full.content, 'text/markdown; charset=utf-8')
      if (r.ok) {
        state.docs[d.id] = String(full.currentRevisionId || d.rev)
        updated++
      } else {
        console.warn('[wenyuan-osca-sync] put failed', d.id, r.error)
      }
    } catch (e) {
      console.warn('[wenyuan-osca-sync] put error', d.id, e instanceof Error ? e.message : e)
    }
  }

  let deleted = 0
  for (const id of toDelete.slice(0, MAX_DELETES)) {
    try {
      const r = await oscaDeleteObject(oscaDocKey(id))
      if (!r.ok) {
        console.warn('[wenyuan-osca-sync] delete failed', id, r.error)
        continue
      }
    } catch (e) {
      console.warn('[wenyuan-osca-sync] delete error', id, e instanceof Error ? e.message : e)
      continue
    }
    delete state.docs[id]
    deleted++
  }

  // 只有实际发生变化才写 KV（免费档每天 1000 次写入，稳定态零写入）
  if (updated > 0 || deleted > 0) {
    await kv.put(STATE_KEY, JSON.stringify(state))
  }

  return {
    scanned: docs.length,
    updated,
    deleted,
    pendingPuts: Math.max(0, toPut.length - updated),
    pendingDeletes: Math.max(0, toDelete.length - deleted),
  }
}
