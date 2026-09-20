import { HeadContent, Outlet, Scripts, createRootRoute, createRoute, useLocation } from '@tanstack/react-router'
import { useEffect } from 'react'
import { allPosts } from 'content-collections'
import { SiteShell } from '@/components/site-shell'
import { publicServerFns } from '@/components/public-fns'
import { PickupPreviewHost } from '@/components/pickup-preview'
import 'katex/dist/katex.min.css'
import '../styles.css'
import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE, type CategoryLabel } from '@/lib/utils'
import { I18nProvider, setCategoryLabels, useT } from '@/lib/i18n'
import { initFontPrefs } from '@/lib/font-prefs'

const themeScript = `(function(){try{var t=localStorage.getItem('theme');document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')}catch(e){document.documentElement.dataset.theme='dark'}})()`

// 首帧前同步字体偏好属性（CSS 字体文件随后按需加载，font-display:swap 保证先出字、不变空白）
const fontScript = `(function(){try{var v=localStorage.getItem('sg-font-pref');var ok={'zh-sans':1,'zh-serif':1,'zh-wenkai':1,'zh-smiley':1,'zh-kuaile':1,'zh-mashan':1,'zh-lisu':1,'en-inter':1,'en-lora':1,'en-playfair':1,'en-syne':1,'en-caveat':1,'ru-inter':1,'ru-manrope':1,'ru-ptserif':1,'ru-yeseva':1,'ru-marck':1};if(v&&ok[v])document.documentElement.setAttribute('data-font',v)}catch(e){}})()`

// 开发阶段的 head 补丁（在 HeadContent 加载 @vite/client 之前执行）：
// 1) Vite 7 在中国大陆/部分缓存状态下 env.mjs 的 __DEFINES__ 替换会失效（第一行就崩溃），
//    导致整个客户端 module import 链中断、SSR fallback 永不 Hydrate。
//    先注入 window.__DEFINES__ 空对象兜底；
// 2) TanStack Start HMR 在 Router 挂载前访问 window.__TSR_ROUTER__.routesById 会抛错，
//    先预装一个空 mock，真实 router 挂载后会被覆盖；
// 3) pg/postgres-bytea 如果在客户端 chunk 中被误加载会抛 ReferenceError: Buffer is not defined，
//    提供最小够用的 Buffer 替代实现（提供 byteLength / Uint8Array 兼容接口）。
// 全部放在 try/catch 里，生产环境即使 HeadContent 不需要这些也完全无害。
const clientBootstrapPatch = `(function(){try{
  window.__DEFINES__ = window.__DEFINES__ || {}
  if (!window.__TSR_ROUTER__) {
    window.__TSR_ROUTER__ = { routesById: {}, state: { matches: [], pendingMatches: [] } }
  }
  /* Node core module polyfills for edge case where pg/drizzle accidentally end up in client bundle. */
  if (typeof process === 'undefined') { window.process = window.process || {} }
  const p = window.process
  if (!p.nextTick) p.nextTick = function(fn) { setTimeout(fn, 0) }
  if (!p.emitWarning) p.emitWarning = function(msg) { try { console.warn('[process.emitWarning]', msg) } catch {} }
  if (typeof module === 'undefined') { /* no-op */ }
  if (typeof require === 'function' && typeof window !== 'undefined') {
    try {
      const orig = window.require
      window.require = function(spec) {
        if (spec === 'util') return window.__UTIL__ || (window.__UTIL__ = makeUtilPolyfill())
        return orig.apply(this, arguments)
      }
    } catch {}
  }
  function makeUtilPolyfill() {
    function deprecate(fn, msg) {
      let warned = false
      const wrapped = function() {
        if (!warned) { warned = true; try { console.warn('[deprecation]', msg) } catch {} }
        return fn.apply(this, arguments)
      }
      return wrapped
    }
    return {
      deprecate,
      promisify: function(fn) { return function() { const self=this, args=[].slice.call(arguments); return new Promise(function(res,rej){ fn.apply(self, args.concat([function(err,v){ if(err) rej(err); else res(v) }])) } ) } },
      debuglog: function() { return function() {} },
      format: function() { return [].slice.call(arguments).map(function(a){ try{return String(a)}catch{return ''} }).join(' ') },
      inspect: function(o) { try { return JSON.stringify(o) } catch { return String(o) } },
      inherits: function(ctor, superCtor) { ctor.super_ = superCtor; ctor.prototype = Object.create(superCtor.prototype, { constructor: { value: ctor, enumerable: false, writable: true, configurable: true } }) },
      types: { isNativeError: function() { return false } },
    }
  }
  if (typeof window.__UTIL__ !== 'object' || !window.__UTIL__) window.__UTIL__ = makeUtilPolyfill()
  if (typeof window.require !== 'function') {
    window.require = function(spec) {
      if (spec === 'util') return window.__UTIL__
      if (spec === 'buffer') return { Buffer: (typeof Buffer === 'undefined' ? window.Buffer : window.Buffer) }
      if (spec === 'stream') return {}
      throw new Error('shimmed window.require: unsupported spec ' + spec)
    }
  }
  /* pg/drizzle accidentally in client bundle → fs.deprecate / fs.stat / fs.createReadStream. Provide noops. */
  if (typeof window.__FS__ !== 'object' || !window.__FS__) {
    const U = window.__UTIL__
    window.__FS__ = {
      deprecate: U && U.deprecate ? function(fn,msg){return U.deprecate(fn,msg)} : function(fn){return fn},
      stat: function(_path, cb) { try { cb && cb(new Error('fs.stat disabled in browser shim')) } catch {} },
      createReadStream: function() {
        const ret = {}
        if (typeof window.__UTIL__ === 'object' && window.__UTIL__.inherits) { /* pass */ }
        ret.on = function(){return ret}; ret.once = function(){return ret}; ret.emit = function(){return ret}; ret.removeListener = function(){return ret}
        ret.pipe = function(){return ret}; ret.unpipe = function(){return ret}
        return ret
      },
      constants: {},
      existsSync: function(){return false},
      readFileSync: function(){throw new Error('fs.readFileSync disabled in browser shim')},
      writeFileSync: function(){throw new Error('fs.writeFileSync disabled in browser shim')},
    }
  }
  if (typeof window.fs !== 'object' || !window.fs) { window.fs = window.__FS__ }
  if (typeof Buffer === 'undefined') {
    function Buf(x, enc) {
      if (typeof x === 'number') { this.bytes = new Uint8Array(x >>> 0); this.length = this.bytes.length; return this }
      if (typeof x === 'string') {
        if (enc === 'hex') {
          const bytes = new Uint8Array(x.length / 2);
          for (let i = 0; i < x.length; i += 2) bytes[i / 2] = parseInt(x.substr(i, 2), 16);
          this.bytes = bytes; this.length = bytes.length; return this;
        }
        const u8 = new TextEncoder().encode(x);
        this.bytes = u8; this.length = u8.length; return this;
      }
      if (x instanceof Uint8Array) { this.bytes = x; this.length = x.length; return this; }
      if (Array.isArray(x)) { const u = new Uint8Array(x); this.bytes = u; this.length = u.length; return this; }
      this.bytes = new Uint8Array(0); this.length = 0; return this;
    }
    Object.defineProperty(Buf.prototype, 'buffer', { get() { return this.bytes.buffer } })
    Object.defineProperty(Buf.prototype, 'byteOffset', { get() { return this.bytes.byteOffset } })
    Object.defineProperty(Buf.prototype, 'byteLength', { get() { return this.length } })
    Buf.prototype.slice = function(s, e) { const b = this.bytes.subarray(s, e); return new Buf(b) }
    Buf.prototype.toString = function(enc) {
      if (enc === 'hex') {
        let out = ''; for (let i = 0; i < this.length; i++) out += this.bytes[i].toString(16).padStart(2, '0');
        return out;
      }
      if (enc === 'base64') {
        let bin = ''; for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this.bytes[i]);
        return btoa(bin)
      }
      if (enc === 'utf8' || !enc) return new TextDecoder('utf-8').decode(this.bytes)
      return String.fromCharCode.apply(null, this.bytes)
    }
    Buf.prototype.readUInt32BE = function(o) { const b = this.bytes; return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3]) >>> 0 }
    Buf.prototype.readInt32BE = function(o) { const b = this.bytes; return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3]) | 0 }
    Buf.prototype.readUInt16BE = function(o) { const b = this.bytes; return (b[o]<<8)|b[o+1] }
    Buf.prototype.readInt8 = function(o) { return (this.bytes[o]<<24)>>24 }
    Buf.prototype.readDoubleBE = function(o) {
      const u = new Uint8Array(8); for (let i=0;i<8;i++) u[i]=this.bytes[o+i]
      return new DataView(u.buffer, u.byteOffset, 8).getFloat64(0, false)
    }
    Buf.prototype.readFloatBE = function(o) {
      const u = new Uint8Array(4); for (let i=0;i<4;i++) u[i]=this.bytes[o+i]
      return new DataView(u.buffer, u.byteOffset, 4).getFloat32(0, false)
    }
    Buf.prototype.copy = function(target, tStart, sStart, sEnd) {
      const b=this.bytes; sEnd=sEnd==null?b.length:sEnd; tStart=tStart||0
      for (let i=(sStart||0);i<sEnd;i++) target[i+tStart-(sStart||0)]=b[i]
      return Math.max(0, sEnd-(sStart||0))
    }
    Buf.prototype.equals = function(other) {
      if (!(other instanceof Buf)) return false
      if (other.length!==this.length) return false
      for (let i=0;i<this.length;i++) if (this.bytes[i]!==other.bytes[i]) return false
      return true
    }
    Buf.prototype.writeUInt32BE = function(v,o) {
      const b=this.bytes; b[o]=(v>>>24)&255; b[o+1]=(v>>>16)&255; b[o+2]=(v>>>8)&255; b[o+3]=v&255; return o+4
    }
    Buf.prototype.writeUInt16BE = function(v,o) { const b=this.bytes; b[o]=(v>>>8)&255; b[o+1]=v&255; return o+2 }
    Buf.prototype.writeInt32BE = function(v,o) {
      const b=this.bytes; b[o]=(v>>>24)&255; b[o+1]=(v>>>16)&255; b[o+2]=(v>>>8)&255; b[o+3]=v&255; return o+4
    }
    Buf.prototype.writeInt8 = function(v,o) { const b=this.bytes; b[o]=(v&255); return o+1 }
    Buf.prototype.write = function(s, o, l, enc) {
      /* buf.write(string, encoding) / buf.write(string, offset, length, encoding) compatible */
      if (typeof o === 'string') { enc = o; o = 0; l = this.length }
      else if (typeof l === 'string') { enc = l; l = Math.max(0, this.length - (o||0)) }
      else { l = l == null ? Math.max(0, this.length - (o||0)) : l }
      o = o || 0; enc = enc || 'utf8'
      let bytes = null
      if (enc === 'utf8' || enc === 'utf-8') bytes = new TextEncoder().encode(s)
      else if (enc === 'hex') {
        const h = s.length % 2 ? '0' + s : s
        bytes = new Uint8Array(h.length / 2)
        for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.substr(i, 2), 16)
      } else if (enc === 'base64') {
        const bin = atob(s); bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 255
      } else bytes = new TextEncoder().encode(s)
      const written = Math.min(bytes.length, l | 0, this.length - o)
      for (let i = 0; i < written; i++) this.bytes[o + i] = bytes[i]
      return written
    }
    Buf.prototype.fill = function(v, s, e) {
      s = s || 0; e = e == null ? this.length : e
      const val = (typeof v === 'number') ? (v & 255) : ((typeof v === 'string') ? (new TextEncoder().encode(v)[0] || 0) : 0)
      for (let i = s; i < e; i++) this.bytes[i] = val
      return this
    }
    Buf.prototype.subarray = function(s,e) { return new Buf(this.bytes.subarray(s,e)) }
    Buf.prototype.toJSON = function() { return { type:'Buffer', data: Array.from(this.bytes) } }
    Buf.prototype.indexOf = function(v) {
      const b=this.bytes; if (typeof v === 'number') { for (let i=0;i<this.length;i++) if (b[i]===v) return i; return -1 }
      if (typeof v === 'string') { const s=new TextEncoder().encode(v); outer: for (let i=0;i<=this.length-s.length;i++){ for (let j=0;j<s.length;j++) if (b[i+j]!==s[j]) continue outer; return i } return -1 }
      return -1
    }
    Buf.alloc = function(n) { return new Buf(n>>>0) }
    Buf.allocUnsafe = Buf.alloc
    Buf.from = function(x,enc) { return new Buf(x,enc) }
    Buf.isBuffer = function(o) { return o instanceof Buf }
    Buf.isEncoding = function(e) {
      const low = (e || '').toLowerCase()
      return ['utf8','utf-8','utf16le','utf-16le','latin1','binary','base64','hex','ascii','ucs2','ucs-2'].indexOf(low) >= 0
    }
    Buf.byteLength = function(x, enc) {
      if (typeof x === 'string') {
        if (enc === 'hex') return Math.ceil(x.length / 2)
        return new TextEncoder().encode(x).length
      }
      if (x instanceof Uint8Array) return x.length
      if (x instanceof ArrayBuffer || ArrayBuffer.isView(x)) return x.byteLength
      return Number(x?.length ?? 0)
    }
    Buf.concat = function(list, total) {
      if (total==null){ total=0; for (let i=0;i<list.length;i++) total+=list[i].length }
      const out=new Uint8Array(total); let off=0
      for (let i=0;i<list.length;i++) { const b=list[i].bytes; for (let j=0;j<b.length;j++) out[off++]=b[j] }
      return new Buf(out)
    }
    Buf.TYPED_ARRAY_SUPPORT = true
    Buf.BYTES_PER_ELEMENT = 1
    window.Buffer = Buf
  }
}catch(e){}})()`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: DEFAULT_SITE_TITLE },
      { name: 'description', content: DEFAULT_SITE_DESCRIPTION },
    ],
    links: [
      { rel: 'alternate', type: 'application/rss+xml', title: `${DEFAULT_SITE_TITLE} · RSS`, href: '/rss.xml' },
    ],
  }),
  loader: async () => {
    const staticLabels: CategoryLabel[] = Array.from(new Set(allPosts.flatMap((p: { categories: string[] }) => p.categories)))
      .sort()
      .map((name) => ({ name, nameEn: null, nameRu: null }))
    const [settingsResult, categoriesResult] = await Promise.all([
      publicServerFns.settingsFn().catch(() => ({ public: { siteTitle: DEFAULT_SITE_TITLE, siteDescription: DEFAULT_SITE_DESCRIPTION, customCss: '' }, isAdmin: false as const })),
      publicServerFns.allCategoriesFn().catch(() => staticLabels),
    ])
    return {
      settings: settingsResult.public,
      isAdmin: settingsResult.isAdmin,
      categories: categoriesResult,
    }
  },
  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
})

function RootComponent() {
  const { settings, categories } = Route.useLoaderData()
  const loc = useLocation()
  const inAdmin = loc.pathname.startsWith('/admin')

  // 渲染子树前注入分类译名表（模块级注册表；SSR/CSR 同构，数据对所有访客一致）
  setCategoryLabels(categories || [])

  // 客户端挂载后按需加载已选字体的 CSS（data-font 属性已由内联脚本在首帧前置好）
  useEffect(() => { initFontPrefs() }, [])

  // 客户端同步标题到站点设置
  if (typeof document !== 'undefined') {
    if (document.title === DEFAULT_SITE_TITLE && settings.siteTitle !== DEFAULT_SITE_TITLE) {
      document.title = settings.siteTitle
    }
  }

  if (inAdmin) {
    return (
      <>
        {settings.customCss ? <style data-role="site-custom-css" dangerouslySetInnerHTML={{ __html: settings.customCss }} /> : null}
        <Outlet />
      </>
    )
  }

  return (
    <>
      {settings.customCss ? <style data-role="site-custom-css" dangerouslySetInnerHTML={{ __html: settings.customCss }} /> : null}
      <SiteShell categories={categories || []}>
        <Outlet />
      </SiteShell>
      <PickupPreviewHost />
    </>
  )
}

function HttpCatImage({ code, title }: { code: number; title: string }) {
  return (
    <div className="error-cat">
      <div className="error-cat-code">{code}</div>
      <img
        src={`https://http.cat/${code}.jpg`}
        alt={title}
        className="error-cat-img"
        loading="lazy"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
      <p className="error-cat-title">{title}</p>
    </div>
  )
}

function NotFoundPage() {
  const t = useT()
  return (
    <main className="error-page">
      <HttpCatImage code={404} title={t('error.404.title')} />
      <p className="error-desc">{t('error.404.desc')}</p>
      <a href="/" className="error-home">{t('error.home')}</a>
    </main>
  )
}

function ErrorPage({ error }: { error: Error }) {
  const t = useT()
  const code = 500
  const msg = error?.message || t('error.500.title')
  return (
    <main className="error-page">
      <HttpCatImage code={code} title={msg} />
      <p className="error-desc">{t('error.500.desc')}</p>
      <a href="/" className="error-home">{t('error.home')}</a>
    </main>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: fontScript }} />
        {import.meta.env.DEV ? <script dangerouslySetInnerHTML={{ __html: clientBootstrapPatch }} /> : null}
        <HeadContent />
      </head>
      <body>
        <I18nProvider>{children}</I18nProvider>
        <Scripts />
      </body>
    </html>
  )
}

// 防止 createRoute / Route 未使用告警（实际用于顶层 loader）
void createRoute
