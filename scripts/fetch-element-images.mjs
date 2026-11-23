// 元素实物图自托管脚本（手动执行，构建期不联网）。
// 运行：node scripts/fetch-element-images.mjs [--force]
//
// 图源：
//   · 1–104（除下列例外）：https://images-of-elements.com/ ，CC BY 3.0，按元素页首图抓取
//   · 89 Ac / 91 Pa / 96 Cm：Wikimedia Commons 公有领域图（站方声明的 4 张版权例外之一，
//     以及 Cm 的 images-of-elements 图版权保留，故改用 Commons）
//   · 104 Rf / 105–118：无可用实物照片，清单里标记 placeholder，前端渲染设计占位卡
//
// 产出：
//   public/elements/<z>.<ext>  本地图片（400×400 左右）
//   src/lib/element-images.json 清单：src / title / credit / license / licenseUrl / sourceUrl

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'public', 'elements')
const OUT_JSON = path.join(ROOT, 'src', 'lib', 'element-images.json')
const FORCE = process.argv.includes('--force')

const UA = 'syntax-garden/1.0 (element image mirror; +https://loong.me.uk)'
const IOE = 'https://images-of-elements.com'

// 站方页面名与英文名不同（或英文名有多种拼写）的元素
const PAGE_OVERRIDES = {
  13: 'aluminium',
  55: 'caesium',
  74: 'tungsten',
  80: 'mercury',
  16: 'sulfur',
}

// 版权例外 / 需要换源的 4 张，改用 Wikimedia Commons 文件（含精确文件名）
const COMMONS = {
  89: { file: 'Actinium_sample_(31481701837).png', title: 'Actinium-225 radioisotope in a vial at ORNL' },
  91: { file: 'Protactinium-233.jpg', title: 'Protactinium-233 photographed by its own radiation' },
  96: { file: 'Cm-Fluoreszenz.png', title: 'Curium fluorescence' },
}

// 无可用实物照片的元素（版权例外且 Commons 无合适图 / 超重元素）
const PLACEHOLDER = {
  104: 'Резерфордий синтезируется в единичных атомах и не имеет видимой навески.',
  105: 'Дубний синтезируется в единичных атомах и не имеет видимой навески.',
  106: 'Сиборгий синтезируется в единичных атомах и не имеет видимой навески.',
  107: 'Борий синтезируется в единичных атомах и не имеет видимой навески.',
  108: 'Хассий синтезируется в единичных атомах и не имеет видимой навески.',
  109: 'Мейтнерий синтезируется в единичных атомах и не имеет видимой навески.',
  110: 'Дармштадтий синтезируется в единичных атомах и не имеет видимой навески.',
  111: 'Рентгений синтезируется в единичных атомах и не имеет видимой навески.',
  112: 'Коперниций синтезируется в единичных атомах и не имеет видимой навески.',
  113: 'Нихоний синтезируется в единичных атомах и не имеет видимой навески.',
  114: 'Флеровий синтезируется в единичных атомах и не имеет видимой навески.',
  115: 'Московий синтезируется в единичных атомах и не имеет видимой навески.',
  116: 'Ливерморий синтезируется в единичных атомах и не имеет видимой навески.',
  117: 'Теннессин синтезируется в единичных атомах и не имеет видимой навески.',
  118: 'Оганесон синтезируется в единичных атомах и не имеет видимой навески.',
}

function readElements() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'elements.json'), 'utf8'))
  // 字段顺序见 src/lib/elements.ts 的 FIELDS；这里只需要 z / sym / en
  return raw.map((row) => ({ z: row[0], sym: row[1], en: row[2] }))
}

async function get(url, tries = 3) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      return res
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

/** 页面 → 首张展示图。返回 { src, title } */
async function discoverIoe(slug) {
  const res = await get(`${IOE}/${slug}.php`)
  const html = await res.text()
  const m = html.match(/<img src="(s\/[^"]+\.(?:jpg|jpeg|png))"[^>]*alt="([^"]*)"/i)
  if (!m) throw new Error(`页面无展示图：${slug}`)
  return { src: `${IOE}/${m[1]}`, title: m[2] || slug }
}

async function commonsInfo(file) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo' +
    '&iiprop=url%7Cextmetadata&iiurlwidth=400&titles=' +
    encodeURIComponent(`File:${file}`)
  const res = await get(url)
  const json = await res.json()
  const page = Object.values(json.query?.pages ?? {})[0]
  const info = page?.imageinfo?.[0]
  if (!info) throw new Error(`Commons 无此文件：${file}`)
  const meta = info.extmetadata ?? {}
  return {
    // 优先取 800px 缩略图：Commons 原图常有数 MB，前台只需要卡片尺寸
    src: info.thumburl || info.url,
    title: (meta.ImageDescription?.value ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 220) || file,
    credit: (meta.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim() || 'Wikimedia Commons',
    license: meta.LicenseShortName?.value ?? 'Public domain',
    licenseUrl: meta.LicenseUrl?.value ?? 'https://commons.wikimedia.org/wiki/Commons:Licensing',
    sourceUrl: info.descriptionurl,
  }
}

function extOf(url) {
  const m = url.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i)
  return (m?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg')
}

async function download(url, dest) {
  const res = await get(url)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1500) throw new Error(`文件过小（${buf.length}B）：${url}`)
  fs.writeFileSync(dest, buf)
  return buf.length
}

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let i = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      results[idx] = await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
  return results
}

const elements = readElements()
const manifest = {}
const failures = []
let totalBytes = 0

fs.mkdirSync(OUT_DIR, { recursive: true })

// 1–104：抓取 / 下载
const targets = elements.filter((e) => e.z <= 104)
await pool(targets, 5, async (el) => {
  try {
    let entry
    if (COMMONS[el.z]) {
      const info = await commonsInfo(COMMONS[el.z].file)
      entry = {
        src: info.src,
        title: COMMONS[el.z].title || info.title,
        credit: info.credit,
        license: info.license,
        licenseUrl: info.licenseUrl,
        sourceUrl: info.sourceUrl,
        provider: 'wikimedia',
      }
    } else if (PLACEHOLDER[el.z]) {
      manifest[el.z] = { placeholder: true, note: PLACEHOLDER[el.z], sym: el.sym }
      return
    } else {
      const slug = PAGE_OVERRIDES[el.z] ?? el.en.toLowerCase()
      const found = await discoverIoe(slug)
      entry = {
        src: found.src,
        title: found.title,
        credit: 'images-of-elements.com',
        license: 'CC BY 3.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
        sourceUrl: `${IOE}/${slug}.php`,
        provider: 'images-of-elements',
      }
    }

    const ext = extOf(entry.src)
    const file = `${el.z}.${ext}`
    const dest = path.join(OUT_DIR, file)
    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 1500) {
      totalBytes += fs.statSync(dest).size
    } else {
      totalBytes += await download(entry.src, dest)
    }
    manifest[el.z] = {
      src: `/elements/${file}`,
      title: entry.title,
      credit: entry.credit,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      sourceUrl: entry.sourceUrl,
      provider: entry.provider,
    }
  } catch (e) {
    failures.push(`${el.z} ${el.sym} ${el.en}: ${e.message}`)
  }
})

// 104–118：占位
for (const el of elements) {
  if (el.z >= 104 && !manifest[el.z]) {
    manifest[el.z] = { placeholder: true, note: PLACEHOLDER[el.z] ?? '', sym: el.sym }
  }
}

// 按序写入清单，便于 diff
const ordered = {}
for (const z of Object.keys(manifest).map(Number).sort((a, b) => a - b)) ordered[z] = manifest[z]
fs.writeFileSync(OUT_JSON, JSON.stringify(ordered, null, 2) + '\n')

const withImg = Object.values(ordered).filter((v) => v.src).length
console.log(`✓ 本地图片 ${withImg} 张，占位 ${118 - withImg} 个，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`✓ 清单写入 ${path.relative(ROOT, OUT_JSON)}`)
if (failures.length) {
  console.log(`\n✗ 失败 ${failures.length} 条：`)
  for (const f of failures) console.log('  ' + f)
  process.exitCode = 1
}
