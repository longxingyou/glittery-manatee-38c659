import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import * as dbApi from '../../db/index.js'
import { isOscaConfigured, oscaDocKey, oscaPutObject, oscaPresignedGetUrl } from '../lib/osca.js'
import { fetchWithTimeout, getWenToken, listWenByTag, LOGIN_TIMEOUT_MS, wenBase, type WenDoc } from '../lib/wenyuan-api.js'

/**
 * 归档到文渊（文档管理器 redbean 单文件服务）：
 *  - POST 仅管理员；浏览器把 X 岛串导出的 Markdown 提交到这里；
 *  - Worker 用 bootstrap admin 密码换会话 token（缓存在 isolate 内，401 自动重登一次）；
 *  - 长文分两条路径（页大小默认 15000 字，比 wen 原生 6000 少建一半以上分页）：
 *    ① ≤20 页：Worker 侧按文渊原生算法预切分，先建目录页再逐批小请求建分页、补页尾导航，
 *       每个请求都很小，天然规避单次大请求超时，产物与 wen autoSplit 逐字节一致；
 *    ② >20 页：回退 wen 原生 autoSplit（单请求，wen 内部切分，无子请求数限制），
 *       并照旧补给目录页补打串标题标签；
 *  - GET ?title= 查询某串的归档状态；DELETE ?tag= 分批删除整串归档；PUT {from,to} 整串改名/移动标签。
 *    分批设计：Workers 免费档每请求最多 50 个子请求，每批限制个数，由前端循环调用直到 remaining=0。
 */
const archiveSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(2_000_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  autoSplit: z.boolean().optional(),
  splitSize: z.number().int().min(100).max(20_000).optional(),
  message: z.string().trim().max(300).optional(),
})

const renameSchema = z.object({
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  limit: z.number().int().min(1).max(15).optional(),
})

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

function jsonError(error: string, status = 400, extra?: Record<string, unknown>): Response {
  return Response.json({ ok: false, error, ...extra }, { status, headers: PRIVATE_HEADERS })
}

// 登录/列表很快；建文档（autoSplit 分页写库+目录页）在长串时可能要几十秒，放宽到 120s
const CREATE_TIMEOUT_MS = 120_000

async function createDocument(
  base: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetchWithTimeout(
    `${base}/api/documents`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    },
    CREATE_TIMEOUT_MS,
  )
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** 归档集 = 打了串标签的文档（分页+修复后的目录）∪ X岛归档 下同名的目录/单文档 */
async function listArchiveDocs(base: string, token: string, tag: string): Promise<WenDoc[]> {
  const [tagged, archived] = await Promise.all([
    listWenByTag(base, token, tag, 200),
    listWenByTag(base, token, 'X岛归档', 100),
  ])
  const seen = new Set(tagged.map((d) => d.id))
  const extra = archived.filter((d) => d.title === tag && !seen.has(d.id))
  return [...tagged, ...extra]
}

function docUrl(base: string, doc: WenDoc, fallbackTitle: string): string {
  return `${base}/wen/?did=${encodeURIComponent(String(doc.id))}&dt=${encodeURIComponent(String(doc.title || fallbackTitle))}`
}

// ── 文渊原生 autoSplit 等价切分（复刻 wen .lua/documents.lua 的 splitUtf8Characters /
// findSmartSplitIndex / appendSegmentNavigation，产物逐字节一致）──
const DEFAULT_SPLIT_SIZE = 15_000
// Worker 侧逐页建档的页数上限：免费档每请求 50 个子请求（登录≤1 + 目录1 + 分页N + 导航N + OSCA≤2）
const WORKER_SPLIT_MAX_PAGES = 20
const PAGE_BATCH = 6

const SENTENCE_BOUNDARY = new Set(['。', '！', '？', '；', '!', '?', ';', '.', '…'])

function findSmartSplitIndex(chars: string[], start: number, target: number, maxChars: number): number {
  const minIndex = Math.min(target, start + Math.floor(maxChars * 0.55))
  for (let i = target - 1; i >= minIndex; i--) {
    if (chars[i] === '\n' && chars[i + 1] === '\n') return i + 1
  }
  for (let i = target; i >= minIndex; i--) {
    if (chars[i] === '\n') return i
  }
  for (let i = target; i >= minIndex; i--) {
    if (SENTENCE_BOUNDARY.has(chars[i])) return i
  }
  return target
}

/** 按码点切分，切点优先级：段落空行 > 换行 > 句界 > 硬切（与 wen 原生一致） */
function splitWenChunks(content: string, maxChars: number): string[] {
  const chars = Array.from(content)
  if (chars.length === 0) return ['']
  const chunks: string[] = []
  let start = 0
  while (start < chars.length) {
    const target = Math.min(start + maxChars - 1, chars.length - 1)
    const split = target < chars.length - 1 ? findSmartSplitIndex(chars, start, target, maxChars) : target
    chunks.push(chars.slice(start, split + 1).join(''))
    start = split + 1
  }
  return chunks
}

/** 分页尾部导航：上一页 · 回到目录 · 下一页（wen 原生 appendSegmentNavigation 格式） */
function appendSegmentNav(content: string, index: number, pageIds: string[], catalogId: string): string {
  const links: string[] = []
  if (index > 0) links.push(`[上一页](/?did=${pageIds[index - 1]})`)
  links.push(`[回到目录](/?did=${catalogId})`)
  if (index < pageIds.length - 1) links.push(`[下一页](/?did=${pageIds[index + 1]})`)
  return `${content}\n\n---\n\n${links.join(' · ')}`
}

/** OSCA 冗余备份：文渊是主路径，OSCA 是异地灾备；失败只记日志不影响归档 */
async function backupToOsca(docId: string, content: string): Promise<{ oscaKey: string | null; oscaUrl: string | null }> {
  if (!isOscaConfigured()) return { oscaKey: null, oscaUrl: null }
  try {
    const key = oscaDocKey(docId)
    const r = await oscaPutObject(key, content, 'text/markdown; charset=utf-8')
    if (!r.ok) {
      console.warn('[osca backup]', r.error)
      return { oscaKey: null, oscaUrl: null }
    }
    // 签 7 天有效的直链，管理界面可复制分享
    return { oscaKey: key, oscaUrl: await oscaPresignedGetUrl(key, 7 * 86400) }
  } catch (e) {
    console.warn('[osca backup]', e)
    return { oscaKey: null, oscaUrl: null }
  }
}

export const Route = createFileRoute('/api/wenyuan')({
  server: {
    handlers: {
      // ── 归档状态查询：GET /api/wenyuan?title=<串标题> ──
      GET: async ({ request }) => {
        try {
          await dbApi.requireAdmin()
        } catch {
          return jsonError('需要管理员登录。', 401)
        }
        try {
          const { base, password } = wenBase()
          if (!password) return jsonError('未配置文渊管理员密码（WENYUAN_ADMIN_PASSWORD）。', 503)

          const title = (new URL(request.url).searchParams.get('title') || '').trim().slice(0, 160)
          if (!title) return jsonError('缺少 title 参数。', 400)

          const token = await getWenToken(base, password)
          const [catalogs] = await Promise.all([listWenByTag(base, token, 'X岛归档', 100)])
          const catalog = catalogs.find((d) => d.title === title) || null
          const tagged = await listWenByTag(base, token, title, 200)
          const pages = tagged.filter((d) => d.id !== catalog?.id).length
          const entry = catalog || tagged[tagged.length - 1] || null
          return Response.json(
            {
              ok: true,
              archived: !!entry,
              tag: title,
              catalogId: catalog?.id ?? null,
              pages: pages || (catalog ? 1 : 0),
              url: entry ? docUrl(base, entry, title) : null,
            },
            { headers: PRIVATE_HEADERS },
          )
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return jsonError(`查询归档状态失败：${msg}`, 502)
        }
      },

      POST: async ({ request }) => {
        try {
          await dbApi.requireAdmin()
        } catch {
          return jsonError('需要管理员登录。', 401)
        }

        try {
          const { base, password } = wenBase()
          if (!password) return jsonError('未配置文渊管理员密码（WENYUAN_ADMIN_PASSWORD）。', 503)

          const parsed = archiveSchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return jsonError(parsed.error.issues[0]?.message || '请求参数不合法。', 400)
          }
          const { title: rawTitle, content, tags, autoSplit, splitSize, message } = parsed.data
          const splitSizeEff = splitSize || DEFAULT_SPLIT_SIZE
          // 文渊在 autoSplit 时用标题拼 [[catalog(tag="...")]]，ASCII 双引号会导致其 400
          const title = autoSplit ? rawTitle.replace(/"/g, '＂') : rawTitle
          const userTags = tags && tags.length ? tags : ['X岛归档']
          const msg = message || '从 Syntax Garden 归档'

          let token = await getWenToken(base, password)
          // 建档统一走这里：会话失效/文渊重启后自动重登一次
          const createAuthed = async (p: Record<string, unknown>) => {
            let r = await createDocument(base, token, p)
            if (r.status === 401) {
              token = await getWenToken(base, password, true)
              r = await createDocument(base, token, p)
            }
            return r
          }
          const expectDoc = (r: { status: number; body: any }, what: string): string | null => {
            if (r.status === 401) return '文渊登录失败：管理员密码不正确。'
            if (![200, 201].includes(r.status) || !r.body?.success || !r.body.data?.id) {
              return `${what}失败：${r.body?.error || r.body?.message || `HTTP ${r.status}`}`
            }
            return null
          }

          // ── Worker 侧逐页建档（≤20 页）：每个请求都很小（单页 ≈ splitSizeEff 字），
          // 天然规避 wen 原生 autoSplit 的单次大请求超时；产物与原生格式逐字节一致。
          // 顺序：目录页（直接带串标题标签，免事后补打）→ 各分页正文 → 补页尾导航。
          // 先用 UTF-16 长度粗估页数（≥码点数，安全高估），巨串不进这里，免白做逐码点展开。
          if (autoSplit && Math.ceil(content.length / splitSizeEff) <= WORKER_SPLIT_MAX_PAGES) {
            const chunks = splitWenChunks(content, splitSizeEff)
            if (chunks.length <= WORKER_SPLIT_MAX_PAGES) {
              const cat = await createAuthed({
                title,
                content: `[[catalog(tag="${title}")]]`,
                type: 'markdown',
                tags: [...userTags, title],
                message: msg,
              })
              const catErr = expectDoc(cat, '创建目录页')
              if (catErr) return jsonError(catErr, 502)
              const catalogId = String(cat.body.data.id)

              // 分页正文先不带导航（页 id 要建完才知道），并发小批次，失败即中断报页码
              const pageIds: string[] = new Array(chunks.length)
              const pageRevs: string[] = new Array(chunks.length)
              for (let i = 0; i < chunks.length; i += PAGE_BATCH) {
                const results = await Promise.all(
                  chunks.slice(i, i + PAGE_BATCH).map((chunk, j) => {
                    const idx = i + j
                    return createAuthed({
                      title: `${title}页${idx + 1}`,
                      content: chunk,
                      type: 'markdown',
                      tags: [title, '分页'],
                      message: msg,
                    }).then((r) => ({ idx, r }))
                  }),
                )
                for (const { idx, r } of results) {
                  const err = expectDoc(r, `创建第 ${idx + 1} 页`)
                  if (err) {
                    return jsonError(`归档中断：${err}。已有文档可在导出菜单「整串删除」清理后重试。`, 502)
                  }
                  pageIds[idx] = String(r.body.data.id)
                  pageRevs[idx] = String(r.body.data.currentRevisionId || '')
                }
              }

              // 补页尾导航（上一页 · 回到目录 · 下一页）。导航失败不致命：分页正文已完整，
              // 仅页尾跳转缺失；照常返回成功，避免用户误判失败重试造成重复归档。
              let navMissing = 0
              for (let i = 0; i < chunks.length; i += PAGE_BATCH) {
                const results = await Promise.all(
                  chunks.slice(i, i + PAGE_BATCH).map((chunk, j) => {
                    const idx = i + j
                    if (!pageIds[idx] || !pageRevs[idx]) return Promise.resolve(false)
                    return fetchWithTimeout(
                      `${base}/api/documents/${pageIds[idx]}`,
                      {
                        method: 'PUT',
                        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                        body: JSON.stringify({
                          title: `${title}页${idx + 1}`,
                          content: appendSegmentNav(chunk, idx, pageIds, catalogId),
                          type: 'markdown',
                          tags: [title, '分页'],
                          baseRevisionId: pageRevs[idx],
                          message: '补充分页导航',
                        }),
                      },
                      CREATE_TIMEOUT_MS,
                    )
                      .then((r) => r.ok)
                      .catch(() => false)
                  }),
                )
                navMissing += results.filter((ok) => !ok).length
              }

              const url = docUrl(base, { id: catalogId, title }, title)
              const backup = await backupToOsca(catalogId, content)
              return Response.json(
                {
                  ok: true,
                  id: catalogId,
                  title,
                  url,
                  autoSplit: true,
                  workerSplit: true,
                  segments: chunks.length,
                  navMissing: navMissing || undefined,
                  oscaKey: backup.oscaKey,
                  oscaUrl: backup.oscaUrl,
                },
                { headers: PRIVATE_HEADERS },
              )
            }
          }

          // ── 巨串（>20 页）回退 wen 原生 autoSplit（单请求、wen 内部切分、无子请求上限），或普通单文档 ──
          const payload: Record<string, unknown> = {
            title,
            content,
            type: 'markdown',
            tags: userTags,
            message: msg,
          }
          if (autoSplit) {
            payload.autoSplit = true
            payload.splitSize = splitSizeEff
          }

          const r = await createAuthed(payload)
          if (r.status === 401) return jsonError('文渊登录失败：管理员密码不正确。', 502)
          if (![200, 201].includes(r.status) || !r.body?.success || !r.body.data?.id) {
            return jsonError(r.body?.error || r.body?.message || `文渊拒绝了归档请求（HTTP ${r.status}）。`, 502)
          }

          const doc = r.body.data
          // wen 的 autoSplit 只给分页打串标题标签，目录页只有 X岛归档/大书库 —— 补上，
          // 这样侧边栏按串标题过滤时目录页和全部分页一起出现
          if (autoSplit && doc.currentRevisionId) {
            try {
              const curTags: string[] = Array.isArray(doc.tags) ? doc.tags.map(String) : []
              if (!curTags.includes(title)) {
                await fetchWithTimeout(
                  `${base}/api/documents/${doc.id}/tags`,
                  {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                    body: JSON.stringify({ tags: [...curTags, title], baseRevisionId: doc.currentRevisionId, message: '同步归档标签' }),
                  },
                  LOGIN_TIMEOUT_MS,
                )
              }
            } catch {
              // 非致命：目录页标签补打失败不影响归档本身
            }
          }

          const url = docUrl(base, doc, title)
          // 巨串回退原生时 wen 不回传分段数；用 UTF-16 长度粗估（避免对超大正文做逐码点展开，耗 CPU）
          const segments = autoSplit ? Math.max(1, Math.ceil(content.length / splitSizeEff)) : 1

          const backup = await backupToOsca(doc.id, content)
          return Response.json(
            { ok: true, id: doc.id, title: doc.title, url, autoSplit: !!autoSplit, segments, oscaKey: backup.oscaKey, oscaUrl: backup.oscaUrl },
            { headers: PRIVATE_HEADERS },
          )
        } catch (e) {
          // 文渊调用失败（网络/超时等）必须兜底成可读错误，而不是裸 500
          const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
          const msg = timedOut
            ? `文渊处理超时（文档过大，超过 ${CREATE_TIMEOUT_MS / 1000} 秒）。可稍后重试。`
            : `无法连接文渊：${e instanceof Error ? e.message : String(e)}`
          return jsonError(msg, 502)
        }
      },

      // ── 整串改名/移动标签：PUT /api/wenyuan {from, to, limit?}，前端循环直到 remaining=0 ──
      PUT: async ({ request }) => {
        try {
          await dbApi.requireAdmin()
        } catch {
          return jsonError('需要管理员登录。', 401)
        }
        try {
          const { base, password } = wenBase()
          if (!password) return jsonError('未配置文渊管理员密码（WENYUAN_ADMIN_PASSWORD）。', 503)

          const parsed = renameSchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) return jsonError('参数不合法：from/to 必填（≤80 字）。', 400)
          // 标签会进 [[catalog(tag="...")]]，双引号必须替换
          const from = parsed.data.from.replace(/"/g, '＂')
          const to = parsed.data.to.replace(/"/g, '＂')
          if (from === to) return jsonError('新标签与当前相同。', 400)
          const limit = parsed.data.limit ?? 10

          const token = await getWenToken(base, password)
          const all = await listArchiveDocs(base, token, from)
          const batch = all.slice(0, limit)

          for (const d of batch) {
            const newTags = (d.tags || []).map((t) => (t === from ? to : t))
            if (!newTags.includes(to)) newTags.push(to)
            try {
              // 列表接口的 content 是截断的（~100 字符），必须先取完整文档再 PUT，否则会清空正文
              const full = await fetchWithTimeout(
                `${base}/api/documents/${d.id}`,
                { headers: { authorization: `Bearer ${token}` } },
                LOGIN_TIMEOUT_MS,
              ).then((x) => x.json().catch(() => null))
              const fd = full?.data
              if (!fd || !fd.currentRevisionId) continue
              // 目录页：同步 [[catalog(tag=...)]] 指令；分页段：标题前缀 xxx页N → yyy页N
              const isIndexDoc = String(fd.content || '').includes(`[[catalog(tag="${from}")]]`)
              const content = isIndexDoc
                ? String(fd.content || '').split(`[[catalog(tag="${from}")]]`).join(`[[catalog(tag="${to}")]]`)
                : fd.content
              const title =
                typeof fd.title === 'string' && fd.title.startsWith(from) ? to + fd.title.slice(from.length) : fd.title
              await fetchWithTimeout(
                `${base}/api/documents/${d.id}`,
                {
                  method: 'PUT',
                  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                  body: JSON.stringify({
                    title,
                    content,
                    type: fd.type || 'markdown',
                    tags: newTags,
                    baseRevisionId: fd.currentRevisionId,
                    message: '归档改名/移动',
                  }),
                },
                LOGIN_TIMEOUT_MS,
              )
            } catch {
              // 单个文档失败不中断整批；重跑即可（已改名的文档不再带 from 标签）
            }
          }
          return Response.json(
            { ok: true, updated: batch.length, remaining: Math.max(0, all.length - batch.length) },
            { headers: PRIVATE_HEADERS },
          )
        } catch (e) {
          return jsonError(`改名/移动失败：${e instanceof Error ? e.message : String(e)}`, 502)
        }
      },

      // ── 整串删除：DELETE /api/wenyuan?tag=<串标签>&limit=15，前端循环直到 remaining=0 ──
      DELETE: async ({ request }) => {
        try {
          await dbApi.requireAdmin()
        } catch {
          return jsonError('需要管理员登录。', 401)
        }
        try {
          const { base, password } = wenBase()
          if (!password) return jsonError('未配置文渊管理员密码（WENYUAN_ADMIN_PASSWORD）。', 503)

          const sp = new URL(request.url).searchParams
          const tag = (sp.get('tag') || '').trim().slice(0, 120)
          if (!tag) return jsonError('缺少 tag 参数。', 400)
          const limit = Math.min(25, Math.max(1, Number(sp.get('limit')) || 15))

          const token = await getWenToken(base, password)
          const all = await listArchiveDocs(base, token, tag)
          const batch = all.slice(0, limit)
          let deleted = 0
          for (const d of batch) {
            // 软删 → 物理删；已软删的文档软删会 404，直接尝试物理删
            await fetchWithTimeout(
              `${base}/api/documents/${d.id}`,
              { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
              LOGIN_TIMEOUT_MS,
            ).catch(() => null)
            const perm = await fetchWithTimeout(
              `${base}/api/documents/${d.id}/permanent`,
              { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
              LOGIN_TIMEOUT_MS,
            ).catch(() => null)
            if (perm && perm.ok) deleted++
          }
          return Response.json(
            { ok: true, deleted, remaining: Math.max(0, all.length - batch.length) },
            { headers: PRIVATE_HEADERS },
          )
        } catch (e) {
          return jsonError(`删除归档失败：${e instanceof Error ? e.message : String(e)}`, 502)
        }
      },
    },
  },
})
