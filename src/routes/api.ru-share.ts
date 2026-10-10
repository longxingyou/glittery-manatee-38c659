import { createFileRoute } from '@tanstack/react-router'

import * as dbApi from '../../db/index.js'

/**
 * /api/ru-share —— 俄语工具箱分享系统
 *
 * 与网络工具 /api/net 的"单设备独占"不同：每条链接允许多个不同 IP 同时
 * 访问（默认 10），同 IP 下设备数不限。绑定逻辑在 db/index.ts。
 *
 * GET
 *   action=claim&t=<token>  打开链接，绑定本设备（IP+cookie），302 → /share/russian
 *   action=info             /share/russian 挂载时自检（JSON）
 * POST（仅管理员）
 *   ru_share_list / create / delete / reset / toggle / set_ips
 */

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

function jsonError(error: string, status = 400): Response {
  return Response.json({ ok: false, error }, { status, headers: PRIVATE_HEADERS })
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return null
}

/** 真实客户端 IP：Cloudflare 注入 cf-connecting-ip；dev/其他代理逐级回退 */
function getClientIp(request: Request): string | null {
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return cf.trim()
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return null
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** 拒绝/提示页（顶层导航直接打开时的可读落地页） */
function messagePage(title: string, message: string, status: number): Response {
  const page =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font:15px system-ui;padding:48px 24px;max-width:560px;margin:0 auto;line-height:1.7">` +
    `<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2><p style="margin:0;color:#57606a">${escapeHtml(message)}</p></body></html>`
  return new Response(page, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } })
}

// ──────────── GET：claim / info ────────────

async function handleClaimGet(request: Request, url: URL): Promise<Response> {
  const token = (url.searchParams.get('t') || '').trim()
  if (!token) return messagePage('链接无效', '缺少分享令牌，请核对链接是否完整。', 400)
  const result = await dbApi.claimRuShareLink(token, readCookie(request, dbApi.RU_SHARE_COOKIE_NAME), getClientIp(request))

  if (result.status === 'invalid') return messagePage('链接无效', '链接不存在或已被删除，请向分享者确认。', 400)
  if (result.status === 'disabled') return messagePage('分享已关闭', '管理员已关闭分享模式，全部链接已失效。', 403)
  if (result.status === 'full') {
    return messagePage(
      '访问人数已满',
      `该链接允许的 ${result.max} 个同时访问名额已全部占用，暂时无法加入。可稍后再试（长期未访问者会自动释放名额），或联系分享者。`,
      403,
    )
  }

  const headers = new Headers(PRIVATE_HEADERS)
  if (result.status === 'bound') {
    headers.set(
      'Set-Cookie',
      `${dbApi.RU_SHARE_COOKIE_NAME}=${result.id}.${result.secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${dbApi.RU_SHARE_COOKIE_MAX_AGE}`,
    )
  }
  headers.set('Location', '/share/russian')
  return new Response(null, { status: 302, headers })
}

async function handleInfoGet(request: Request): Promise<Response> {
  const ok = await dbApi.verifyRuShareCookie(readCookie(request, dbApi.RU_SHARE_COOKIE_NAME), getClientIp(request))
  return Response.json({ ok }, { headers: PRIVATE_HEADERS })
}

// ──────────── POST：管理员管理动作 ────────────

async function handlePost(request: Request): Promise<Response> {
  let body: { action?: string; id?: string; enabled?: boolean; maxIps?: number } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonError('请求体不是有效的 JSON。')
  }
  const action = body.action || ''
  if (action === 'ru_share_list') {
    return Response.json({ ok: true, ...(await dbApi.listRuShareLinks()) }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'ru_share_create') {
    const result = await dbApi.createRuShareLink(typeof body.maxIps === 'number' ? body.maxIps : 10)
    return Response.json({ ok: true, ...result }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'ru_share_delete') {
    if (!body.id) return jsonError('缺少链接 id。')
    await dbApi.deleteRuShareLink(body.id)
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'ru_share_reset') {
    if (!body.id) return jsonError('缺少链接 id。')
    await dbApi.resetRuShareLink(body.id)
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'ru_share_set_ips') {
    if (!body.id) return jsonError('缺少链接 id。')
    if (typeof body.maxIps !== 'number') return jsonError('缺少上限数值。')
    await dbApi.setRuShareMaxIps(body.id, body.maxIps)
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'ru_share_toggle') {
    const result = await dbApi.setRuShareEnabled(body.enabled === true)
    return Response.json({ ok: true, enabled: body.enabled === true, ...result }, { headers: PRIVATE_HEADERS })
  }
  return jsonError('未知的分享管理动作。', 404)
}

export const Route = createFileRoute('/api/ru-share')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        try {
          if (action === 'claim') return await handleClaimGet(request, url)
          if (action === 'info') return await handleInfoGet(request)
          return jsonError('未知动作。', 404)
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : '分享系统内部错误。', 500)
        }
      },
      POST: async ({ request }) => {
        try {
          return await handlePost(request)
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : '分享系统内部错误。', 500)
        }
      },
    },
  },
})
