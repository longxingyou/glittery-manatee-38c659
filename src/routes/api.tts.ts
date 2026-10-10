import { createFileRoute } from '@tanstack/react-router'

/**
 * /api/tts —— 俄语神经语音同源反代（公开端点）
 *
 * 网关域名 gw.xn--fpr224a.mom 是灰云直连 Azure IP：在国内被 DNS 污染
 * （解析到无效 IP）且 443 直连不通，浏览器 <audio> 直连网关必然无声。
 * 改为同源请求：浏览器 → Cloudflare Worker（橙云，与站点同域可达）→
 * Worker 从边缘回源拉取网关音频流式转回（网关侧 DNS 正常）。
 *
 * - 仅透传 text/rate/voice 白名单参数，不做通用代理；
 * - 文本长度上限与网关 TTS_MAX_TEXT 对齐（600 字符）；
 * - 音频在网关侧有 sha1 缓存（命中毫秒级），本端点附加浏览器长缓存；
 * - body 流式透传，不在 Worker 内存缓冲整段 mp3。
 */

const TTS_UPSTREAM = 'https://gw.xn--fpr224a.mom/tts'
const TTS_TEXT_MAX = 600

export const Route = createFileRoute('/api/tts')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const text = (url.searchParams.get('text') || '').trim()
        if (!text || text.length > TTS_TEXT_MAX) {
          return Response.json({ ok: false, error: 'bad text' }, { status: 400 })
        }
        const params = new URLSearchParams()
        params.set('text', text)
        params.set('rate', url.searchParams.get('rate') || '0.8')
        if (url.searchParams.get('voice') === 'd') params.set('voice', 'd')
        let upstream: Response
        try {
          upstream = await fetch(`${TTS_UPSTREAM}?${params.toString()}`, {
            signal: AbortSignal.timeout(30_000),
          })
        } catch {
          return Response.json({ ok: false, error: 'tts upstream unreachable' }, { status: 502 })
        }
        if (!upstream.ok) {
          try { await upstream.body?.cancel() } catch { /* ignore */ }
          return Response.json({ ok: false, error: 'tts failed' }, { status: 502 })
        }
        const headers = new Headers()
        headers.set('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg')
        // 合成音频永不变化：同 URL（同 text+rate）可长缓存，重复点读零回源
        headers.set('Cache-Control', 'public, max-age=86400')
        return new Response(upstream.body, { status: 200, headers })
      },
    },
  },
})
