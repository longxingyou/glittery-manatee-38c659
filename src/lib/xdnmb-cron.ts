/**
 * @deprecated X 岛 TG 推送功能已下线。主站 cron 不再调用 checkXdnmbSubs。
 * 此文件保留作为历史参考，不再被任何路径引用。
 *
 * X 岛订阅 cron 检查（worker.ts scheduled 每 5 分钟调用）：
 * 拉取每个订阅串的回复总数，发现增长 → 取末页最新回复做预览 →
 * 经自建 botapi 网关 sendMessage 推送到管理员的 Telegram（x-sg-admin 签名，
 * bot token 不出网关）；推进游标。单串失败不影响其他订阅。
 *
 * 首次订阅（基线为 0）只同步现状不推送，避免订阅瞬间刷屏。
 */
import * as db from '../../db/index.js'
import { gatewayConfig, signGwToken } from './attachment-store.js'
import { getThread } from './xdnmb-server.js'

const PAGE_TOO_LARGE = 999 // 超界页 X 岛按惯例返回最后一页（含最新回复）

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&bull;/g, '•').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

async function tgSend(chatId: string, text: string): Promise<boolean> {
  const gw = gatewayConfig()
  if (!gw) return false
  try {
    const res = await fetch(`${gw.url}/api/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sg-admin': await signGwToken('admin', 'sendMessage', 15 * 60 * 1000),
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function checkXdnmbSubs(): Promise<{ checked: number; pushed: number; errors: number }> {
  const { userhash, tgChat } = await db.getXdnmbSettings()
  const subs = await db.listXdnmbSubsForCron()
  let pushed = 0
  let errors = 0
  for (const s of subs) {
    try {
      // 首页对象带 ReplyCount 总数
      const first = await getThread(String(s.id), 1, userhash)
      const count = Number(first.ReplyCount ?? 0)
      // 首次基线：记录现状，不推送
      if ((s.lastReplyCount ?? 0) === 0 && count > 0) {
        await db.updateXdnmbCursor(s.id, 0, count)
        continue
      }
      if (count <= (s.lastReplyCount ?? 0)) continue

      // 取末页最新回复预览（page 超界时 API 返回最后一页）
      let preview = ''
      let lastId = 0
      try {
        const last = await getThread(String(s.id), PAGE_TOO_LARGE, userhash)
        const replies = (last.Replies || []).filter((r) => r.user_hash !== 'Tips')
        const newest = replies[replies.length - 1]
        if (newest) {
          lastId = Number(newest.id)
          preview = plainText(newest.content).slice(0, 90)
        }
      } catch { /* 预览失败只影响文案，不影响计数推进 */ }

      const title = s.title || `No.${s.id}`
      const delta = count - (s.lastReplyCount ?? 0)
      if (tgChat) {
        const text =
          `🔔 <b>X 岛订阅更新</b>\n` +
          `《${htmlEscape(title)}》\n` +
          `新增 <b>${delta}</b> 条回应（共 ${count}）` +
          (preview ? `\n最新 No.${lastId}：${htmlEscape(preview)}` : '') +
          `\n<a href="https://nmbxd.com/t/${s.id}">打开串</a>`
        const ok = await tgSend(tgChat, text)
        if (!ok) errors++
      }
      pushed++
      await db.updateXdnmbCursor(s.id, lastId, count)
    } catch {
      errors++
    }
  }
  return { checked: subs.length, pushed, errors }
}
