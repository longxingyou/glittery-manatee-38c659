// 元素名称「真人发音」抓取脚本（手动执行，构建期不联网）。
// 运行：node scripts/fetch-element-audio.mjs [--force] [--only=80,79] [--langs=en,ru,zh]
//
// 数据来源：Wiktionary 三个语言版本（en / ru / zh）元素词条页面上挂载的音频。
// 这些音频实际托管在 Wikimedia Commons，按文件名前缀可判定语言：
//   Ru-водород.ogg                  → 俄语
//   En-us-mercury.ogg / EN-AU …     → 英语
//   Zh-yǎng.oga / zh-jīn.ogg        → 汉语（普通话）
//   LL-Q7737 (rus)-…-водород.wav    → Lingua Libre，Q7737 = 俄语（Q1860 英语 / Q7850 普通话）
// 关键点：一个词条页会挂多语言音频（如 en.wiktionary 的「ртуть」带俄语、乌克兰语），
// 因此按「目标语言」筛文件，而不是按页面所在站点语言。
//
// 产出：
//   public/audio/elements/<z>-<lang>.mp3|ogg   自托管音频（访客无需翻墙）
//   src/lib/element-audio.json                 清单：src / file / credit / license / licenseUrl / sourceUrl
//
// 说明：本机 Node 直连 wikimedia 不通，故所有请求都借 Playwright Chromium 的页面上下文发起；
// API 请求走同源 /w/api.php，音频下载走 upload.wikimedia.org（该域带 CORS 头）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'public', 'audio', 'elements')
const OUT_JSON = path.join(ROOT, 'src', 'lib', 'element-audio.json')
const CACHE_JSON = path.join(os.tmpdir(), 'sg-element-audio-discovery.json')
const FORCE = process.argv.includes('--force')

const EDITIONS = ['en', 'ru', 'zh']
const UA = 'syntax-garden/1.0 (element pronunciation mirror; +https://loong.me.uk)'
const API_GAP_MS = 1600 // 每个站点两次 API 请求的最小间隔（Wikimedia 速率礼仪）
const DL_GAP_MS = 700
const AUDIO_RE = /\.(ogg|oga|mp3|wav|flac|opus)$/i

// ── 汉字 → 普通话拼音（数字声调），由 Unihan kMandarin 生成，用于同音字回退 ──
const HANZI_PINYIN = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'hanzi-pinyin.json'), 'utf8'))
  } catch {
    return {}
  }
})()

const TONE_LETTERS = {
  ā: ['a', 1], á: ['a', 2], ǎ: ['a', 3], à: ['a', 4],
  ē: ['e', 1], é: ['e', 2], ě: ['e', 3], è: ['e', 4],
  ī: ['i', 1], í: ['i', 2], ǐ: ['i', 3], ì: ['i', 4],
  ō: ['o', 1], ó: ['o', 2], ǒ: ['o', 3], ò: ['o', 4],
  ū: ['u', 1], ú: ['u', 2], ǔ: ['u', 3], ù: ['u', 4],
  ǖ: ['v', 1], ǘ: ['v', 2], ǚ: ['v', 3], ǜ: ['v', 4], ü: ['v', 5],
  ń: ['n', 2], ň: ['n', 3], ǹ: ['n', 4],
}

/** "měi" / "mei3" → "mei3"。无声调信息时返回 ''——绝不猜测声调。 */
function toneToNumber(s) {
  let out = ''
  let tone = 0
  for (const ch of String(s).toLowerCase().trim()) {
    if (TONE_LETTERS[ch]) { out += TONE_LETTERS[ch][0]; tone = TONE_LETTERS[ch][1] }
    else if (/[1-5]/.test(ch)) tone = Number(ch)
    else if (/[a-z]/.test(ch)) out += ch
  }
  return tone ? out + tone : ''
}

/** 单音节判定：归一化后字母数 ≤ 6（普通话最长 zhuang/shuang） */
function isSingleSyllable(py) {
  return !!py && py.replace(/\d$/, '').length <= 6
}

/** 从 wikitext 提取可确定声调的拼音集合 */
function extractPinyin(wt) {
  const out = new Set()
  for (const m of String(wt).matchAll(/[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹ]{2,6}[1-5]?/g)) {
    const p = toneToNumber(m[0])
    if (isSingleSyllable(p)) out.add(p)
  }
  return out
}

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}
const ONLY = new Set(
  argValue('only').split(',').map((s) => Number(s.trim())).filter(Boolean),
)
const LANGS = (argValue('langs') || 'zh,en,ru').split(',').map((s) => s.trim()).filter((s) => ['zh', 'en', 'ru'].includes(s))

// ── 元素数据（elements.json 紧凑行：[z, sym, en, ru, zh, …]） ──
function readElements() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'elements.json'), 'utf8'))
  return raw.map((row) => ({ z: row[0], sym: row[1], en: row[2], ru: row[3], zh: row[4] }))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stripTags = (s) => (s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

// ── 文件名 → 语言判定 ──
// 只认「该语言」的录音；乌克兰语(ukr/Q8798)、保加利亚语、马其顿语等一律排除。
// 中文里粤语/闽南语/吴语等方言文件也不当作普通话（yue/nan/hak/wuu/gan/hsn/lzh）。
function classifyLang(base) {
  const n = base.toLowerCase()
  const langs = []
  if (/^ru[\s-]/.test(n) || /\(rus\)/.test(n)) langs.push('ru')
  if (/^en[\s-]/.test(n) || /\(eng\)/.test(n)) langs.push('en')
  const dialect = /(yue|cantonese|\(nan\)|hokkien|\(hak\)|hakka|\(wuu\)|shanghainese|\(gan\)|\(hsn\)|lzh)/.test(n)
  if (!dialect && (/^zh[\s-]/.test(n) || /\(cmn\)/.test(n) || /\(zho\)/.test(n) || /\(mandarin\)/.test(n) || /\(chinese\)/.test(n))) {
    langs.push('zh')
  }
  return langs
}

/** 候选打分：页面标题与目标词一致 > 传统单文件 > 目标语言前缀 > 名字短 */
function rankCandidates(candidates, lang, word) {
  const target = word.trim().toLowerCase()
  const seen = new Set()
  return candidates
    .filter((c) => c.langs.includes(lang))
    .sort((a, b) => score(b) - score(a))
    .filter((c) => {
      const k = c.base.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

  function score(c) {
    const base = c.base.toLowerCase()
    let s = 0
    if (c.pageTitle.trim().toLowerCase() === target) s += 60
    if (!/^ll-/.test(base)) s += 25
    if (base.startsWith(`${lang}-`) || base.startsWith(`${lang} `)) s += 15
    if (lang === 'en' && /^en-us[\s-]/.test(base)) s += 4
    if (lang === 'en' && /^en-uk[\s-]/.test(base)) s += 2
    s -= base.length * 0.15
    return s
  }
}

// 从文件名提取「词」部分：
//   LL-Q7737 (rus)-Speaker-词.wav   → 词
//   Zh-pinyin.ogg / Ru-word.ogg     → pinyin / word
function wordOf(base) {
  const noExt = base.replace(/\.(ogg|oga|mp3|wav|flac|opus)$/i, '')
  const m = noExt.match(/^LL-Q\d+\s*\([a-z]+\)-[^-]*-(.+)$/i)
  if (m) return m[1].trim()
  const m2 = noExt.match(/^(?:zh|en|ru)[\s-](.+)$/i)
  if (m2) return m2[1].trim()
  return noExt.trim()
}

// Commons 搜索回退的查询串（按语言）。
// en 已 118/118 全覆盖，不搜索；zh/ru 只在版本词条页找不到候选时才走这里。
const SEARCH_QUERIES = {
  zh: (el) => [`${el.zh} pronunciation`, `${el.zh} (cmn)`, `${el.zh}`],
  ru: (el) => [`${el.ru} (rus)`, `LL-Q7737 ${el.ru}`, `${el.ru}`],
  en: () => [],
}

// 校验搜索到的文件确实是「该元素」的录音，避免同音/复合词误命中：
//   Lingua Libre（旧模板）：| transcription = 词 | 等于目标词
//   Lingua Libre（新模板 {{Lingua Libre record}} 无内联转录）+ 传统单文件：文件名词等于目标词
//   zh 拼音文件（Shtooka "Pronunciation of tiě (铁)"）：描述 wikitext 含目标字
// 匹配容差：大小写不敏感、ё→е、и/й 首字母互容（数据偶有 Иод/Йод 拼写差异）。
function normWord(s) {
  return String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е')
}
function nameVariants(target) {
  const n = normWord(target)
  const out = new Set([n])
  if (n[0] === 'и') out.add('й' + n.slice(1))
  if (n[0] === 'й') out.add('и' + n.slice(1))
  return out
}
function isCorrectCandidate(cand, target, wikitext) {
  const raw = String(target ?? '').trim()
  if (!raw) return false
  const want = nameVariants(raw)
  const tr = wikitext.match(/\|\s*transcription\s*=\s*([^\n|]+)/)
  if (tr?.[1]?.trim() && want.has(normWord(tr[1]))) return true
  if (cand.word && want.has(normWord(cand.word))) return true
  if (/^zh[\s-]/i.test(cand.base)) return wikitext.includes(raw)
  return false
}

// Commons File 命名空间搜索（必须在 commons.wikimedia.org 源上，en.wiktionary 的 search 搜不到 Commons）
async function commonsSearch(api, query) {
  const p = `/w/api.php?action=query&format=json&formatversion=2&list=search&srnamespace=6&srlimit=40&srsearch=${encodeURIComponent(query)}`
  const json = await api(p)
  const out = []
  for (const r of json.query?.search ?? []) {
    const title = String(r.title ?? '')
    if (!AUDIO_RE.test(title)) continue
    const base = title.replace(/^[^:]+:/, '').replace(/_/g, ' ')
    const langs = classifyLang(base)
    if (!langs.length) continue
    out.push({ title: `File:${base}`, base, pageTitle: '', langs, word: wordOf(base) })
  }
  return out
}

// ── 同音字池（仅 zh）──
// 汉语元素名（大多为单字）在 Commons 常常没有专名录音，但同一拼音+声调的单音节
// 录音很多（Shtooka 的 Zh-pinyin 文件、Lingua Libre 的单字文件）。
// 这里建「拼音+声调 → 文件」索引，供主流程在同名词条缺失时严格同音回退。
const ZH_POOL_CACHE = path.join(os.tmpdir(), 'sg-zh-homophone-index.json')
const ZH_CATEGORIES = [
  'Category:Chinese pronunciation',
  'Category:Mandarin pronunciation',
  'Category:Lingua Libre pronunciation-cmn',
]
const ZH_DIALECT_RE = /(yue|cantonese|\(nan\)|hokkien|\(hak\)|hakka|\(wuu\)|shanghainese|\(gan\)|\(hsn\)|lzh|cdo)/

async function ensureZhPool(api) {
  if (!FORCE) {
    try { return JSON.parse(fs.readFileSync(ZH_POOL_CACHE, 'utf8')) } catch { /* 首次构建 */ }
  }
  // 1) 枚举分类文件（不递归子分类——子分类会带出粤语/闽语/福州话等方言巨树）
  const files = new Set()
  for (const cat of ZH_CATEGORIES) {
    let cont = ''
    do {
      const p = `/w/api.php?action=query&format=json&formatversion=2&list=categorymembers&cmtitle=${encodeURIComponent(cat)}&cmlimit=500&cmtype=file${cont ? `&cmcontinue=${encodeURIComponent(cont)}` : ''}`
      let json
      try { json = await api(p) } catch (e) { console.log(`  ! 分类失败 ${cat}: ${e.message}`); break }
      for (const m of json.query?.categorymembers ?? []) files.add(String(m.title ?? ''))
      cont = json.continue?.cmcontinue ?? ''
    } while (cont)
    console.log(`  · ${cat} → 累计 ${files.size} 个文件`)
  }

  // 2) 建索引
  const pool = {}
  const pending = [] // 文件名无调，需读 wikitext 定声调
  const addHit = (py, title, base) => {
    if (!py || !isSingleSyllable(py)) return
    ;(pool[py] ??= []).push({ title, base })
  }

  for (const title of files) {
    const base = title.replace(/^[^:]+:/, '').replace(/_/g, ' ')
    if (!AUDIO_RE.test(base)) continue
    const n = base.toLowerCase()
    if (ZH_DIALECT_RE.test(n)) continue
    if (!/\(cmn\)|^zh[\s-]/i.test(n)) continue

    if (/^zh[\s-]/i.test(n)) {
      const noExt = base.replace(/\.(ogg|oga|mp3|wav|flac|opus)$/i, '')
      const after = noExt.replace(/^zh[\s-]+/i, '')
      // 含空格 = 词组 / 整句（如 Zh-nǐ hǎo.ogg），不是单字发音
      if (!after || /\s/.test(after)) continue
      const py = toneToNumber(after)
      if (py) addHit(py, title, base)
      else pending.push({ title, base })
      continue
    }

    // Lingua Libre 单字：只有 transcription 恰好 1 个汉字才可用
    const m = base.match(/^LL-Q\d+\s*\(cmn\)-[^-]*-(.+?)\.(ogg|oga|mp3|wav|flac|opus)$/i)
    if (m) {
      const t = m[1].trim()
      if (t.length !== 1) continue
      addHit(HANZI_PINYIN[t], title, base)
    }
  }

  // 3) 无调文件批量取 wikitext（每批 50）确定声调；只有唯一音节时才采用
  for (let i = 0; i < pending.length; i += 50) {
    const chunk = pending.slice(i, i + 50)
    const byTitle = new Map(chunk.map((c) => [c.title, c]))
    try {
      const p = `/w/api.php?action=query&format=json&formatversion=2&prop=revisions&rvprop=content&titles=${encodeURIComponent(chunk.map((c) => c.title).join('|'))}`
      const json = await api(p)
      for (const page of json.query?.pages ?? []) {
        const cand = byTitle.get(page.title)
        if (!cand) continue
        const pys = extractPinyin(page.revisions?.[0]?.content ?? '')
        if (pys.size === 1) addHit([...pys][0], cand.title, cand.base)
      }
    } catch (e) { console.log(`  ! 无调 wikitext 失败: ${e.message}`) }
  }

  try { fs.writeFileSync(ZH_POOL_CACHE, JSON.stringify(pool)) } catch { /* ignore */ }
  const total = Object.values(pool).reduce((n, v) => n + v.length, 0)
  console.log(`✓ 同音字池：${Object.keys(pool).length} 个音节 / ${total} 个文件`)
  return pool
}

// ── 汉典（zdic.net）音节录音回退 ──
// 汉典主站依 CC0 1.0 贡献其作品，其拼音音频为人工录制的单音节（按音节共享）。
// Commons 没有任何对应录音时，用它补齐剩下的汉语元素名（同音，声调一致）。
const ZDIC_BASE = 'https://img.zdic.net/audio/zd/py/'
const VOWEL_MARKS = {
  a: ['ā', 'á', 'ǎ', 'à'], e: ['ē', 'é', 'ě', 'è'], i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'], u: ['ū', 'ú', 'ǔ', 'ù'], v: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
}

/** "gong3" → "gǒng"（数字声调转带调拼音，按普通话标调规则） */
function toneMarked(py) {
  const m = /^([a-z]+)([1-5])$/.exec(String(py ?? ''))
  if (!m) return ''
  const syl = m[1]
  const tone = Number(m[2])
  if (tone === 5) return syl.replace(/v/g, 'ü')
  let idx = -1
  if (syl.includes('a')) idx = syl.indexOf('a')
  else if (syl.includes('e')) idx = syl.indexOf('e')
  else if (syl.includes('ou')) idx = syl.indexOf('o')
  else {
    for (let i = syl.length - 1; i >= 0; i--) {
      if ('iouv'.includes(syl[i])) { idx = i; break }
    }
  }
  if (idx < 0) return ''
  return syl.slice(0, idx) + VOWEL_MARKS[syl[idx]][tone - 1] + syl.slice(idx + 1)
}

async function zdicFallback(el) {
  const py = HANZI_PINYIN[el.zh]
  if (!py) return null
  const marked = toneMarked(py)
  if (!marked) return null
  const url = `${ZDIC_BASE}${encodeURIComponent(marked)}.mp3`
  const r = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.zdic.net/' },
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${marked}`)
  const raw = Buffer.from(await r.arrayBuffer())
  if (raw.length < 1000) throw new Error(`文件过小 ${raw.length}B`)
  // 个别文件带前导 0 填充，去掉后再校验
  let start = 0
  while (start < raw.length && raw[start] === 0) start++
  const buf = start ? raw.subarray(start) : raw
  if (!(buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) && !(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    throw new Error(`非 MP3 ${marked}`)
  }
  const dest = path.join(OUT_DIR, `${el.z}-zh.mp3`)
  fs.writeFileSync(dest, buf)
  return {
    src: `/audio/elements/${el.z}-zh.mp3`,
    file: `汉典 py/${marked}.mp3`,
    credit: '汉典 zdic.net',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sourceUrl: `https://www.zdic.net/hans/${encodeURIComponent(el.zh)}`,
    via: `汉典音节 ${marked}`,
  }
}

// ── 浏览器侧请求 ──
function makeClient(page) {
  let last = 0
  return async function api(apiPath) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = API_GAP_MS - (Date.now() - last)
      if (wait > 0) await sleep(wait)
      last = Date.now()
      let out
      try {
        out = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { accept: 'application/json' } })
          return { status: r.status, text: await r.text() }
        }, apiPath)
      } catch (e) {
        out = { status: 0, text: String(e) }
      }
      if (out.status === 200) {
        try {
          const json = JSON.parse(out.text)
          if (json.error) throw new Error(json.error.info || json.error.code)
          return json
        } catch (e) {
          if (attempt === 3) throw e
        }
      } else if (out.status === 429 || out.status === 503 || out.status === 0) {
        await sleep(3000 * (attempt + 1))
        // 页面可能已失效，重新挂到站点首页
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }) } catch { /* ignore */ }
      } else {
        throw new Error(`HTTP ${out.status} ${apiPath}`)
      }
    }
    throw new Error(`请求失败：${apiPath}`)
  }
}

async function openEdition(browser, edition) {
  const page = await browser.newPage({ userAgent: UA })
  await page.goto(`https://${edition}.wiktionary.org/wiki/Main_Page`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  return page
}

/** 抓取某元素在某个 Wiktionary 版本上的全部音频文件名 */
async function discoverOnEdition(page, el) {
  const api = makeClient(page)
  const found = []

  async function queryWord(word) {
    const base = `/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=images&imlimit=500&titles=${encodeURIComponent(word)}`
    let cont = ''
    let exists = false
    do {
      const json = await api(base + (cont ? `&imcontinue=${encodeURIComponent(cont)}` : ''))
      if (process.env.SG_AUDIO_DEBUG) {
        console.log(`    [debug] ${el.sym} «${word}» pages=${json.query?.pages?.length} titles=${(json.query?.pages ?? []).map((p) => `${p.title}:${(p.images ?? []).length}`).join(', ')}`)
      }
      for (const p of json.query?.pages ?? []) {
        if (p.missing) continue
        exists = true
        const pageTitle = String(p.title ?? '')
        for (const img of p.images ?? []) {
          const title = String(img.title ?? '')
          if (!AUDIO_RE.test(title)) continue
          const baseName = title.replace(/^[^:]+:/, '').replace(/_/g, ' ')
          const langs = classifyLang(baseName)
          if (!langs.length) continue
          // 各语言版本的命名空间前缀不同（File / Файл / 文件），统一成 Commons 认的 File:
          found.push({ title: `File:${baseName}`, base: baseName, pageTitle, langs })
        }
      }
      cont = json.continue?.imcontinue ?? ''
      if (cont) await sleep(API_GAP_MS)
    } while (cont)
    return exists
  }

  // Wiktionary 词条名大小写敏感（$wgCapitalLinks=false）：元素数据里是 "Iron"，
  // 而词典条目是 "iron"。先查小写，命中词条页即止；小写页不存在再试原样。
  for (const word of [el.en, el.ru, el.zh]) {
    if (!word) continue
    const variants = [...new Set([word.trim().toLowerCase(), word.trim()])].filter(Boolean)
    for (const variant of variants) {
      const before = found.length
      const exists = await queryWord(variant)
      if (exists || found.length > before) break
    }
  }
  return found
}

// ── Commons 元数据 ──
async function fileInfo(api, titles) {
  const out = new Map()
  for (let i = 0; i < titles.length; i += 20) {
    const chunk = titles.slice(i, i + 20)
    const p = `/w/api.php?action=query&format=json&formatversion=2&prop=videoinfo&viprop=url%7Csize%7Cderivatives%7Cextmetadata&titles=${encodeURIComponent(chunk.join('|'))}`
    const json = await api(p)
    for (const page of json.query?.pages ?? []) {
      const info = page.videoinfo?.[0]
      if (!info) continue
      const meta = info.extmetadata ?? {}
      out.set(page.title, {
        url: info.url,
        size: info.size,
        derivatives: info.derivatives ?? [],
        credit: stripTags(meta.Artist?.value).slice(0, 140) || 'Wikimedia Commons',
        license: meta.LicenseShortName?.value ?? 'CC BY-SA',
        licenseUrl: meta.LicenseUrl?.value ?? 'https://commons.wikimedia.org/wiki/Commons:Licensing',
        sourceUrl: info.descriptionurl ?? '',
      })
    }
  }
  return out
}

function pickAudioUrl(info) {
  const mp3 = (info.derivatives ?? []).find((d) => d.transcodekey === 'mp3' || d.type === 'audio/mpeg')
  if (mp3?.src) return { url: mp3.src, ext: 'mp3' }
  const orig = info.url ?? ''
  const m = orig.match(/\.(ogg|oga|mp3|wav|flac|opus)(?:\?|$)/i)
  if (!m) return null
  const ext = m[1].toLowerCase().replace('oga', 'ogg')
  return { url: orig, ext }
}

async function download(page, url) {
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u)
    if (!r.ok) return { status: r.status }
    const bytes = new Uint8Array(await r.arrayBuffer())
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return { status: 200, b64: btoa(bin) }
  }, url)
  if (b64.status !== 200 || !b64.b64) throw new Error(`下载失败 HTTP ${b64.status}`)
  return Buffer.from(b64.b64, 'base64')
}

// ── 主流程 ──
const elements = readElements().filter((el) => !ONLY.size || ONLY.has(el.z))
const targets = elements.map((el) => ({ ...el, words: { zh: el.zh, en: el.en, ru: el.ru } }))

fs.mkdirSync(OUT_DIR, { recursive: true })

let discoveryCache = {}
try {
  discoveryCache = JSON.parse(fs.readFileSync(CACHE_JSON, 'utf8'))
} catch { /* 首次运行 */ }
function saveCache() {
  try { fs.writeFileSync(CACHE_JSON, JSON.stringify(discoveryCache)) } catch { /* ignore */ }
}

const browser = await chromium.launch({ headless: true })
const editionPages = {}
const editionApis = {}
for (const ed of EDITIONS) {
  editionPages[ed] = await openEdition(browser, ed)
  editionApis[ed] = makeClient(editionPages[ed])
  console.log(`✓ 已连接 ${ed}.wiktionary.org`)
}

// Commons 搜索专用页面（list=search 必须在 commons 源；元数据/下载仍走 en 页的 instant commons + CORS）
const searchPage = await browser.newPage({ userAgent: UA })
await searchPage.goto('https://commons.wikimedia.org/wiki/Main_Page', { waitUntil: 'domcontentloaded', timeout: 60000 })
const searchApi = makeClient(searchPage)
console.log('✓ 已连接 commons.wikimedia.org（搜索回退）')

// 1) 发现：三个版本并行扫描（不同域名，各自遵守速率）
await Promise.all(
  EDITIONS.map(async (ed) => {
    let done = 0
    for (const el of targets) {
      const cached = discoveryCache[el.z]?.[ed]
      if (!FORCE && Array.isArray(cached)) { done++; continue }
      let found = []
      try {
        found = await discoverOnEdition(editionPages[ed], el)
      } catch (e) {
        console.log(`  ! ${ed} ${el.z} ${el.sym} 发现失败：${e.message}`)
      }
      discoveryCache[el.z] ??= {}
      discoveryCache[el.z][ed] = found
      done++
      if (done % 10 === 0) {
        saveCache()
        console.log(`  ${ed}: ${done}/${targets.length}`)
      }
    }
    saveCache()
    console.log(`✓ ${ed} 扫描完成`)
  }),
)

// 2) 选源 + 元数据 + 下载
const manifest = (() => {
  try { return JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')) } catch { return {} }
})()

const commonsPage = editionPages.en
const commonsApi = editionApis.en
const failures = []
let downloaded = 0
let bytesTotal = 0

for (let idx = 0; idx < targets.length; idx++) {
  const el = targets[idx]
  const candidates = []
  for (const ed of EDITIONS) {
    for (const c of discoveryCache[el.z]?.[ed] ?? []) {
      // 跨版本去重（File:/Файл: 前缀差异）
      const key = c.base.toLowerCase()
      if (!candidates.some((x) => x.base.toLowerCase() === key)) candidates.push(c)
    }
  }

  // 版本候选排序 + 一次批量预取元数据（所有语言合并，省请求）
  const editionRanked = {}
  for (const lang of LANGS) editionRanked[lang] = rankCandidates(candidates, lang, el.words[lang] ?? '')
  const infos = new Map()
  {
    const topTitles = [...new Set(LANGS.flatMap((lang) => editionRanked[lang].slice(0, 5).map((c) => c.title)))]
    if (topTitles.length) {
      try {
        const m = await fileInfo(commonsApi, topTitles)
        for (const [k, v] of m) infos.set(k, v)
      } catch (e) { console.log(`  ! 元数据失败 ${el.z}: ${e.message}`) }
    }
  }

  // 尝试下载某语言的候选：逐个试，成功返回 entry，元数据按需补取
  async function tryDownload(lang, cands) {
    const titles = [...new Set(cands.slice(0, 5).map((c) => c.title))]
    const missing = titles.filter((t) => !infos.has(t))
    if (missing.length) {
      try {
        const m = await fileInfo(commonsApi, missing)
        for (const [k, v] of m) infos.set(k, v)
      } catch (e) { console.log(`  ! 元数据失败 ${el.z} ${lang}: ${e.message}`) }
    }
    for (const cand of cands) {
      const info = infos.get(cand.title)
      if (!info) continue
      const pick = pickAudioUrl(info)
      if (!pick) continue
      const dest = path.join(OUT_DIR, `${el.z}-${lang}.${pick.ext}`)
      try {
        const buf = await download(commonsPage, pick.url)
        if (buf.length < 1000) throw new Error(`文件过小 ${buf.length}B`)
        fs.writeFileSync(dest, buf)
        downloaded++
        bytesTotal += buf.length
        return {
          src: `/audio/elements/${el.z}-${lang}.${pick.ext}`,
          file: cand.base,
          credit: info.credit,
          license: info.license,
          licenseUrl: info.licenseUrl,
          sourceUrl: info.sourceUrl,
        }
      } catch (e) {
        failures.push(`${el.z} ${el.sym} ${lang} ${cand.base}: ${e.message}`)
      }
      await sleep(DL_GAP_MS)
    }
    return null
  }

  // 保留已有条目，避免 --langs 子集覆盖掉其它语言
  const entry = { ...(manifest[el.z] ?? {}) }
  for (const lang of LANGS) {
    const prev = manifest[el.z]?.[lang]
    if (!FORCE && prev?.src) {
      const prevFile = path.join(OUT_DIR, path.basename(prev.src))
      if (fs.existsSync(prevFile) && fs.statSync(prevFile).size > 1000) { entry[lang] = prev; continue }
    }
    // 先试版本词条页候选
    let got = await tryDownload(lang, editionRanked[lang])
    // 没成功 → Commons 搜索回退（带校验，避免同音/复合词误命中）
    if (!got) {
      const cached = discoveryCache[el.z]?.search?.[lang]
      let found = []
      if (!FORCE && Array.isArray(cached)) {
        found = cached
      } else {
        const queries = SEARCH_QUERIES[lang]?.(el) ?? []
        const seen = new Map() // base → candidate（跨查询去重）
        for (const q of queries) {
          let hits = []
          try { hits = await commonsSearch(searchApi, q) } catch (e) { console.log(`  ! 搜索失败 ${el.z} ${lang} «${q}»: ${e.message}`) }
          for (const h of hits) {
            const k = h.base.toLowerCase()
            if (!seen.has(k)) seen.set(k, h)
          }
        }
        const all = [...seen.values()]
        // 批量取 wikitext（每批 20 个），避免逐个请求拖慢
        const wtMap = new Map()
        for (let i = 0; i < all.length; i += 20) {
          const chunk = all.slice(i, i + 20)
          try {
            const p = `/w/api.php?action=query&format=json&formatversion=2&prop=revisions&rvprop=content&titles=${encodeURIComponent(chunk.map((c) => c.title).join('|'))}`
            const json = await searchApi(p)
            for (const page of json.query?.pages ?? []) {
              wtMap.set(page.title, page.revisions?.[0]?.content ?? '')
            }
          } catch (e) { console.log(`  ! wikitext 失败 ${el.z} ${lang}: ${e.message}`) }
        }
        for (const h of all) {
          if (isCorrectCandidate(h, el.words[lang] ?? '', wtMap.get(h.title) ?? '')) found.push(h)
        }
        discoveryCache[el.z] ??= {}
        discoveryCache[el.z].search ??= {}
        discoveryCache[el.z].search[lang] = found
        saveCache()
      }
      if (found.length) {
        const merged = [...candidates]
        for (const h of found) if (!merged.some((x) => x.base.toLowerCase() === h.base.toLowerCase())) merged.push(h)
        got = await tryDownload(lang, rankCandidates(merged, lang, el.words[lang] ?? ''))
      }
    }
    // 同音字回退（仅 zh）：严格按「拼音 + 声调」完全相等匹配 Commons 单音节录音
    if (!got && lang === 'zh' && el.zh && HANZI_PINYIN[el.zh]) {
      try {
        const pool = await ensureZhPool(searchApi)
        const py = HANZI_PINYIN[el.zh]
        const seenHit = new Set()
        const hits = (pool[py] ?? [])
          .filter((h) => {
            const k = h.base.toLowerCase()
            if (seenHit.has(k) || candidates.some((c) => c.base.toLowerCase() === k)) return false
            seenHit.add(k)
            return true
          })
          // 同分排序：传统单文件优先于 LL，文件名短者优先
          .sort((a, b) => {
            const s = (x) => (/^ll-/i.test(x.base) ? 1 : 0) * 1000 + x.base.length
            return s(a) - s(b)
          })
        if (hits.length) {
          got = await tryDownload('zh', hits.map((h) => ({ title: h.title, base: h.base, langs: ['zh'], word: '' })))
          if (got) got.via = `同音字 ${py}`
        }
      } catch (e) { console.log(`  ! 同音字失败 ${el.z}: ${e.message}`) }
    }
    // 最后兜底：汉典（CC0）单音节人工录音
    if (!got && lang === 'zh') {
      try {
        got = await zdicFallback(el)
        if (got) {
          downloaded++
          bytesTotal += fs.statSync(path.join(OUT_DIR, path.basename(got.src))).size
        }
      } catch (e) { console.log(`  ! 汉典失败 ${el.z} ${el.zh}: ${e.message}`) }
    }
    if (got) entry[lang] = got
    else delete entry[lang]
  }

  if (Object.keys(entry).length) manifest[el.z] = entry
  else delete manifest[el.z]

  // 按 z 排序写盘，便于 diff；每处理完一个元素即落盘，可断点续跑
  const ordered = {}
  for (const z of Object.keys(manifest).map(Number).sort((a, b) => a - b)) ordered[z] = manifest[z]
  fs.writeFileSync(OUT_JSON, JSON.stringify(ordered, null, 2) + '\n')

  const got = LANGS.filter((l) => entry[l]).join('/') || '—'
  console.log(`[${idx + 1}/${targets.length}] ${el.z} ${el.sym} → ${got}`)
}

await browser.close()

// 3) 汇总
const all = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'))
const stat = {}
for (const lang of LANGS) stat[lang] = Object.values(all).filter((e) => e[lang]).length
const totalBytes = Object.values(all).flatMap((e) => Object.keys(e)).length
console.log('')
console.log(`✓ 清单 ${path.relative(ROOT, OUT_JSON)}：${Object.keys(all).length} 个元素`)
for (const lang of LANGS) console.log(`  ${lang}: ${stat[lang]}/${targets.length}`)
console.log(`✓ 本次下载 ${downloaded} 个文件，${(bytesTotal / 1024 / 1024).toFixed(2)} MB`)
console.log(`✓ 音频目录 ${path.relative(ROOT, OUT_DIR)}（共 ${totalBytes} 条记录）`)
if (failures.length) {
  console.log(`\n✗ 失败 ${failures.length} 条：`)
  for (const f of failures.slice(0, 40)) console.log('  ' + f)
}
