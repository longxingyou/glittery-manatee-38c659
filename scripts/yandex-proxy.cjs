/**
 * Yandex Cloud Function：反代 wow.xn--fpr224a.mom（俄国手机流量兜底线路）
 * ============================================================================
 *
 * 背景：俄国手机流量限制时仅放行「社会重要服务登记册」白名单（Yandex/Sber/OZON 等），
 * Cloudflare 不在名单内，因此无法直连自己的网站。本函数部署在 Yandex Cloud Function
 * 上（白名单内），由 Yandex 服务器代为请求 Cloudflare Worker，再把内容返回给手机。
 *
 * 部署步骤（用 yc CLI 或控制台）：
 *   1. 安装 yc CLI，登录 `yc init`，选 cloud + folder
 *   2. 创建服务账号并授权 functions.functionEditor + iam.serviceAccounts.user
 *   3. 创建函数：
 *        yc function create --name sg-proxy --runtime nodejs18
 *   4. 把本文件 + 同目录 package.json 打包上传：
 *        yc function version create \
 *          --function-name sg-proxy \
 *          --runtime nodejs18 \
 *          --entrypoint index.handler \
 *          --memory 256m \
 *          --execution-timeout 30s \
 *          --source-path ./scripts/yandex-proxy
 *   5. 设置环境变量 TARGET_ORIGIN=https://wow.xn--fpr224a.mom
 *        yc function version create ... --environment TARGET_ORIGIN=https://wow.xn--fpr224a.mom
 *   6. 公开访问：yc function allow-unauthenticated-invoke --name sg-proxy
 *   7. 拿到访问 URL：https://functions.yandexcloud.net/<function-id>
 *
 * 使用方法：
 *   - 浏览器访问 https://functions.yandexcloud.net/<id>?integration=raw&u=https://wow.xn--fpr224a.mom/
 *   - 之后所有点击会自动通过 ?u= 包装再次走代理
 *   - 登录/评论的 POST 请求也会经代理转发，cookie 会自动绑定到代理域
 *
 * 注意：
 *   - URL 必须带 ?integration=raw 才能拿到原始响应体（不是 JSON 包装）
 *   - 单次请求/响应上限约 3.5 MiB（Yandex 同步函数硬限制）；阅读模式/搜索均在此范围内
 *   - Yandex Cloud Function 每月免费额度：前 100 万次调用 + 10 GB·时执行时间
 */

'use strict'

const TARGET_ORIGIN = process.env.TARGET_ORIGIN || 'https://wow.xn--fpr224a.mom'

// 允许透传给上游的请求头（避免泄漏代理身份/转发链等无关头）
const PASSTHROUGH_REQ_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language',
  'user-agent', 'referer', 'origin',
  'if-modified-since', 'if-none-match', 'if-range', 'range',
  'content-type', 'content-length',
])

// 允许透传给客户端的响应头（剥离安全策略头以免阻止代理工作）
const PASSTHROUGH_RES_HEADERS = new Set([
  'content-type', 'content-length', 'content-disposition', 'content-range',
  'accept-ranges', 'cache-control', 'etag', 'last-modified', 'vary', 'expires',
])

// HTML 属性正则：href / src / action，匹配单双引号包裹的值
const ATTR_RE = /(\b(?:href|src|action)\s*=\s*)(["'])([^"']+)\2/gi
// CSS url(...) 引用
const CSS_URL_RE = /url\((['"]?)([^'")]+)\1\)/gi

/** 把任意 URL（含相对）规范化为绝对，再判断是否同源上游；同源则包装成 ?u= */
function wrapUrl(raw, baseUrl) {
  let abs
  try {
    abs = baseUrl ? new URL(raw, baseUrl) : new URL(raw)
  } catch {
    return raw
  }
  if (abs.origin === TARGET_ORIGIN) {
    return '?integration=raw&u=' + encodeURIComponent(abs.toString())
  }
  return raw
}

/** HTML 重写：把所有同源 URL（含相对路径）改写为 ?u= 包装形式 */
function rewriteHtml(html, baseUrl) {
  return html
    .replace(ATTR_RE, (m, attr, q, url) => `${attr}${q}${wrapUrl(url, baseUrl)}${q}`)
    .replace(CSS_URL_RE, (m, q, url) => `url(${q}${wrapUrl(url, baseUrl)}${q})`)
    // 一些 JS 模板里裸写的 location.href='...' 也兜底重写
    .replace(/(location(?:\.href)?\s*=\s*)(["'])([^"']+)\2/gi, (m, a, q, u) => `${a}${q}${wrapUrl(u, baseUrl)}${q}`)
}

/** CSS 重写：把 url(...) 改写为代理包装 */
function rewriteCss(css, baseUrl) {
  return css.replace(CSS_URL_RE, (m, q, url) => `url(${q}${wrapUrl(url, baseUrl)}${q})`)
}

/** Set-Cookie 重写：去掉 Domain=<上游域>，让 cookie 落到代理域；
 *  强制 SameSite=Lax（避免代理跨域跳转时丢失 cookie；现代浏览器默认 Lax，
 *  这里显式标注避免歧义） */
function rewriteSetCookie(value) {
  let v = value.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*samesite=[^;]+/gi, '')
  if (!/samesite=/i.test(v)) v += '; SameSite=Lax'
  return v
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParams || {}
    let u = qs.u
    if (!u || typeof u !== 'string') {
      // 引导：默认跳到 TARGET_ORIGIN 根
      return {
        statusCode: 302,
        headers: { location: '?integration=raw&u=' + encodeURIComponent(TARGET_ORIGIN + '/') },
        body: '',
      }
    }

    let upstream
    try {
      upstream = new URL(u)
    } catch {
      return { statusCode: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Bad u param' }
    }
    // 仅放行同源上游，禁止开放代理（避免被滥用刷流量）
    if (upstream.origin !== TARGET_ORIGIN) {
      return { statusCode: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Only same-origin allowed' }
    }

    // 构造上游请求头
    const inHeaders = event.headers || {}
    const reqHeaders = {}
    for (const [k, v] of Object.entries(inHeaders)) {
      if (PASSTHROUGH_REQ_HEADERS.has(k.toLowerCase())) reqHeaders[k] = v
    }
    // 关键：Host 必须是上游域（CF Worker 按 host 路由）
    reqHeaders['host'] = upstream.host
    // Cookie 透传，保留 sg_auth / SG_SHARE 会话
    if (inHeaders.cookie) reqHeaders.cookie = inHeaders.cookie

    const method = (event.httpMethod || 'GET').toUpperCase()
    const init = { method, headers: reqHeaders, redirect: 'manual' }
    if (event.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      init.body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body
    }

    const res = await fetch(upstream.toString(), init)
    const buf = Buffer.from(await res.arrayBuffer())

    // 构造响应头
    const outHeaders = {}
    const setCookies = []
    // undici / Node 18+ 的 Headers 提供 getSetCookie() 取回多个 Set-Cookie 原值数组；
    // 旧版回退到拆分 get('set-cookie')。
    if (typeof res.headers.getSetCookie === 'function') {
      for (const c of res.headers.getSetCookie()) setCookies.push(rewriteSetCookie(c))
    } else {
      const raw = res.headers.get('set-cookie')
      if (raw) {
        for (const c of raw.split(/,(?=\s*[^=;]+=)/)) setCookies.push(rewriteSetCookie(c))
      }
    }
    for (const [k, v] of res.headers.entries()) {
      const lower = k.toLowerCase()
      if (lower === 'set-cookie') continue // 已单独处理
      if (lower === 'location') {
        // 3xx 跳转：上游绝对 URL 改写为 ?u= 包装；相对 URL 用 upstream 为基准
        outHeaders['location'] = wrapUrl(v, upstream)
      } else if (PASSTHROUGH_RES_HEADERS.has(lower)) {
        outHeaders[lower] = v
      }
      // 显式丢弃：content-security-policy / x-frame-options / strict-transport-security
      // / x-content-type-options 等安全策略头（在代理域上会反而阻止资源加载）
    }
    const out = {
      statusCode: res.status,
      headers: outHeaders,
      body: '',
    }
    if (setCookies.length === 1) out.headers['set-cookie'] = setCookies[0]
    else if (setCookies.length > 1) out.multiValueHeaders = { 'set-cookie': setCookies }

    const ct = (res.headers.get('content-type') || '').toLowerCase()
    // 文本类型：重写后原样返回（避免 base64 编码浪费）
    if (ct.startsWith('text/html')) {
      out.body = rewriteHtml(buf.toString('utf8'), upstream.toString())
      return out
    }
    if (ct.startsWith('text/css') || ct.includes('javascript')) {
      const text = buf.toString('utf8')
      out.body = ct.includes('javascript') ? text : rewriteCss(text, upstream.toString())
      return out
    }
    if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml')) {
      out.body = buf.toString('utf8')
      return out
    }

    // 二进制：base64 编码返回
    out.body = buf.toString('base64')
    out.isBase64Encoded = true
    return out
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Proxy error: ' + (e && e.message ? e.message : String(e)),
    }
  }
}
