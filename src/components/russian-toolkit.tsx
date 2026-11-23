import * as React from 'react'
import { BookA, BookOpen, Boxes, Check, Copy, Delete, Keyboard, Repeat, Type } from 'lucide-react'

import { useLang, useT } from '@/lib/i18n'
import type { Phrase } from '@/lib/russian-phrases'
// 语音栈（本地合成 / 神经 TTS）已抽到 russian-voice.ts：每日一句面板
// （russian-daily-phrase.tsx，含 878KB 短语库）拆为 lazy chunk 后共用此模块
import { playRu, stopRu } from './russian-voice'
// 每日一句面板：短语库 878KB 只被它消费，React.lazy 独立 chunk 按需加载
const DailyPhrase = React.lazy(() => import('./russian-daily-phrase'))
import { LEX_SECTIONS, type LexSectionId } from '@/lib/russian-lexicon'
// 西里尔文本专用字体：Inter Variable 自带 cyrillic 子集（@font-face 按 unicode-range
// 声明，浏览器只在出现西里尔字符时下载对应分片），不受站点主题字体影响
import '@fontsource-variable/inter'

// 学习资料库标签页：内容文件较大（构建期内联 .md/.opml），懒加载独立 chunk
const MaterialsTab = React.lazy(() => import('./russian-materials').then((m) => ({ default: m.MaterialsTab })))

// =================================================================
// 俄语工具箱（/admin/russian，纯前端离线，无 server fn、无数据库）
// ① 音译输入器：拉丁 ↔ 西里尔双向转换 + ЙЦУКЕН 虚拟键盘（光标处插入）
// ② 字母表：33 字母卡片，点击用浏览器语音合成听发音（不可用静默降级）
// ③ 数字速查：基数词 / 序数词 + 用法备注
// ④ 变格速查：名词（阳/阴中/复数）、形容词、人称代词
// ⑤ 动词变位：第一/第二变位法、过去时、将来时、命令式
// =================================================================

type ToolkitTab = 'translit' | 'alphabet' | 'nouns' | 'verbs' | 'polymer' | 'lexicon' | 'materials'

// ── 音译映射（拉丁 → 西里尔；多字母组合在前，最长匹配优先）──
const LAT2CYR: Array<[string, string]> = [
  ['shch', 'щ'], ['yo', 'ё'], ['yu', 'ю'], ['ya', 'я'], ['zh', 'ж'],
  ['sh', 'ш'], ['ch', 'ч'], ['ts', 'ц'], ['eh', 'э'],
  ["''", 'ъ'], ["'", 'ь'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
  ['i', 'и'], ['j', 'й'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'],
  ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'],
  ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ы'],
]

const CYR2LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: "''", ы: 'y', ь: "'", э: 'eh', ю: 'yu', я: 'ya',
}

function latToCyr(input: string): string {
  let out = ''
  let i = 0
  const lower = input.toLowerCase()
  while (i < input.length) {
    let matched = false
    for (const [src, dst] of LAT2CYR) {
      if (lower.startsWith(src, i)) {
        const ch = input[i]
        const isUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase()
        out += isUpper ? dst.toUpperCase() : dst
        i += src.length
        matched = true
        break
      }
    }
    if (!matched) {
      out += input[i]
      i += 1
    }
  }
  return out
}

function cyrToLat(input: string): string {
  let out = ''
  for (const ch of input) {
    const lower = ch.toLowerCase()
    const mapped = CYR2LAT[lower]
    if (mapped === undefined) {
      out += ch
    } else {
      out += ch === lower ? mapped : mapped[0].toUpperCase() + mapped.slice(1)
    }
  }
  return out
}

// ЙЦУКЕН 键盘三排 + Ё 在第三排末位
const KB_ROWS = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбюё']

// ── 字母表数据：гlyph / 字母名 / 拉丁转写 / zh、en 近似音 ──
type Letter = { u: string; l: string; name: string; lat: string; zh: string; en: string }
const ALPHABET: Letter[] = [
  { u: 'А', l: 'а', name: 'а', lat: 'a', zh: '啊', en: 'a as in father' },
  { u: 'Б', l: 'б', name: 'бэ', lat: 'b', zh: '波', en: 'b as in boy' },
  { u: 'В', l: 'в', name: 'вэ', lat: 'v', zh: 'v（咬唇）', en: 'v as in van' },
  { u: 'Г', l: 'г', name: 'гэ', lat: 'g', zh: '哥', en: 'g as in go' },
  { u: 'Д', l: 'д', name: 'дэ', lat: 'd', zh: '得', en: 'd as in door' },
  { u: 'Е', l: 'е', name: 'е', lat: 'ye', zh: '耶', en: 'ye as in yes' },
  { u: 'Ё', l: 'ё', name: 'ё', lat: 'yo', zh: '腰', en: 'yo as in yolk' },
  { u: 'Ж', l: 'ж', name: 'жэ', lat: 'zh', zh: '日', en: 's as in pleasure' },
  { u: 'З', l: 'з', name: 'зэ', lat: 'z', zh: '兹', en: 'z as in zoo' },
  { u: 'И', l: 'и', name: 'и', lat: 'i', zh: '伊', en: 'ee as in see' },
  { u: 'Й', l: 'й', name: 'и краткое', lat: 'y', zh: '短伊（滑音）', en: 'short glide as in boy' },
  { u: 'К', l: 'к', name: 'ка', lat: 'k', zh: '科', en: 'k as in kite' },
  { u: 'Л', l: 'л', name: 'эль', lat: 'l', zh: '勒', en: 'l as in lamp' },
  { u: 'М', l: 'м', name: 'эм', lat: 'm', zh: '摸', en: 'm as in map' },
  { u: 'Н', l: 'н', name: 'эн', lat: 'n', zh: '讷', en: 'n as in no' },
  { u: 'О', l: 'о', name: 'о', lat: 'o', zh: '哦', en: 'o as in more' },
  { u: 'П', l: 'п', name: 'пэ', lat: 'p', zh: '坡', en: 'p as in pen' },
  { u: 'Р', l: 'р', name: 'эр', lat: 'r', zh: '舌尖颤 r', en: 'rolled r' },
  { u: 'С', l: 'с', name: 'эс', lat: 's', zh: '丝', en: 's as in sun' },
  { u: 'Т', l: 'т', name: 'тэ', lat: 't', zh: '特', en: 't as in top' },
  { u: 'У', l: 'у', name: 'у', lat: 'u', zh: '乌', en: 'oo as in boot' },
  { u: 'Ф', l: 'ф', name: 'эф', lat: 'f', zh: '夫', en: 'f as in fan' },
  { u: 'Х', l: 'х', name: 'ха', lat: 'h', zh: '赫', en: 'ch as in Bach' },
  { u: 'Ц', l: 'ц', name: 'це', lat: 'ts', zh: '呲', en: 'ts as in cats' },
  { u: 'Ч', l: 'ч', name: 'че', lat: 'ch', zh: '吃', en: 'ch as in chair' },
  { u: 'Ш', l: 'ш', name: 'ша', lat: 'sh', zh: '什', en: 'sh as in shut' },
  { u: 'Щ', l: 'щ', name: 'ща', lat: 'shch', zh: '什（软）', en: 'soft sh as in sheep' },
  { u: 'Ъ', l: 'ъ', name: 'твёрдый знак', lat: "''", zh: '硬音符号（不发音）', en: 'hard sign (silent)' },
  { u: 'Ы', l: 'ы', name: 'ы', lat: 'y', zh: '额（扁唇）', en: 'i as in bit (hard)' },
  { u: 'Ь', l: 'ь', name: 'мягкий знак', lat: "'", zh: '软音符号（不发音）', en: 'soft sign (silent)' },
  { u: 'Э', l: 'э', name: 'э', lat: 'eh', zh: '埃', en: 'e as in met' },
  { u: 'Ю', l: 'ю', name: 'ю', lat: 'yu', zh: '由', en: 'u as in universe' },
  { u: 'Я', l: 'я', name: 'я', lat: 'ya', zh: '亚', en: 'ya as in yard' },
]

const NUMS: Array<[string, string]> = [
  ['0', 'ноль'], ['1', 'один'], ['2', 'два'], ['3', 'три'], ['4', 'четыре'], ['5', 'пять'],
  ['6', 'шесть'], ['7', 'семь'], ['8', 'восемь'], ['9', 'девять'], ['10', 'десять'],
  ['11', 'одиннадцать'], ['12', 'двенадцать'], ['13', 'тринадцать'], ['14', 'четырнадцать'],
  ['15', 'пятнадцать'], ['16', 'шестнадцать'], ['17', 'семнадцать'], ['18', 'восемнадцать'],
  ['19', 'девятнадцать'], ['20', 'двадцать'],
  ['30', 'тридцать'], ['40', 'сорок'], ['50', 'пятьдесят'], ['60', 'шестьдесят'],
  ['70', 'семьдесят'], ['80', 'восемьдесят'], ['90', 'девяносто'],
  ['100', 'сто'], ['200', 'двести'], ['300', 'триста'], ['400', 'четыреста'],
  ['500', 'пятьсот'], ['600', 'шестьсот'], ['700', 'семьсот'], ['800', 'восемьсот'],
  ['900', 'девятьсот'], ['1000', 'тысяча'], ['1 000 000', 'миллион'],
]

const ORDINALS: Array<[string, string]> = [
  ['1-й', 'первый'], ['2-й', 'второй'], ['3-й', 'третий'], ['4-й', 'четвёртый'],
  ['5-й', 'пятый'], ['6-й', 'шестой'], ['7-й', 'седьмой'], ['8-й', 'восьмой'],
  ['9-й', 'девятый'], ['10-й', 'десятый'],
]

// ── 变格表数据 ──
type CheatCol = { word: string; glossZh?: string; glossEn?: string }
type CaseKey = 'n' | 'g' | 'd' | 'a' | 'i' | 'p'
type CheatRow = { c: CaseKey; forms: string[] }

// 词尾用 [..] 包裹渲染为强调色，如 стол[а] → стол+а
function Mark({ s }: { s: string }) {
  const parts = s.split(/[\[\]]/)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <b key={i}>{p}</b> : <React.Fragment key={i}>{p}</React.Fragment>,
      )}
    </>
  )
}

const MASC_COLS: CheatCol[] = [
  { word: 'стол', glossZh: '桌子', glossEn: 'table' },
  { word: 'музей', glossZh: '博物馆', glossEn: 'museum' },
  { word: 'учитель', glossZh: '教师', glossEn: 'teacher' },
]
const MASC_ROWS: CheatRow[] = [
  { c: 'n', forms: ['стол', 'музей', 'учитель'] },
  { c: 'g', forms: ['стол[а]', 'музей[а]', 'учител[я]'] },
  { c: 'd', forms: ['стол[у]', 'музей[ю]', 'учител[ю]'] },
  { c: 'a', forms: ['стол', 'музей', 'учител[я]'] },
  { c: 'i', forms: ['стол[ом]', 'музей[ем]', 'учител[ем]'] },
  { c: 'p', forms: ['(о) стол[е]', '(о) музей[е]', '(об) учител[е]'] },
]

const FEMNEUT_COLS: CheatCol[] = [
  { word: 'мама', glossZh: '妈妈', glossEn: 'mum' },
  { word: 'тётя', glossZh: '阿姨', glossEn: 'aunt' },
  { word: 'Мария', glossZh: '玛丽亚', glossEn: 'Maria' },
  { word: 'окно', glossZh: '窗', glossEn: 'window' },
  { word: 'море', glossZh: '海', glossEn: 'sea' },
]
const FEMNEUT_ROWS: CheatRow[] = [
  { c: 'n', forms: ['мама', 'тётя', 'Мария', 'окно', 'море'] },
  { c: 'g', forms: ['мам[ы]', 'тёт[и]', 'Мари[и]', 'окн[а]', 'мор[я]'] },
  { c: 'd', forms: ['мам[е]', 'тёт[е]', 'Мари[и]', 'окн[у]', 'мор[ю]'] },
  { c: 'a', forms: ['мам[у]', 'тёт[ю]', 'Мари[ю]', 'окно', 'море'] },
  { c: 'i', forms: ['мам[ой]', 'тёт[ей]', 'Мари[ей]', 'окн[ом]', 'мор[ем]'] },
  { c: 'p', forms: ['(о) мам[е]', '(о) тёт[е]', '(о) Мари[и]', '(об) окн[е]', '(о) море'] },
]

const PLURAL_COLS: CheatCol[] = [
  { word: 'столы', glossZh: '桌（复）', glossEn: 'tables' },
  { word: 'книги', glossZh: '书（复）', glossEn: 'books' },
  { word: 'музеи', glossZh: '博物馆（复）', glossEn: 'museums' },
]
const PLURAL_ROWS: CheatRow[] = [
  { c: 'n', forms: ['стол[ы]', 'книг[и]', 'музей[и]'] },
  { c: 'g', forms: ['стол[ов]', 'книг', 'музей[ев]'] },
  { c: 'd', forms: ['стол[ам]', 'книг[ам]', 'музей[ям]'] },
  { c: 'a', forms: ['стол[ы]', 'книг[и]', 'музей[и]'] },
  { c: 'i', forms: ['стол[ами]', 'книг[ами]', 'музей[ями]'] },
  { c: 'p', forms: ['(о) стол[ах]', '(о) книг[ах]', '(о) музей[ях]'] },
]

const ADJ_COLS: CheatCol[] = [
  { word: 'новый (м.)', glossZh: '新的', glossEn: 'new (m.)' },
  { word: 'новая (ж.)', glossZh: '新的', glossEn: 'new (f.)' },
  { word: 'новое (ср.)', glossZh: '新的', glossEn: 'new (n.)' },
  { word: 'новые (мн.)', glossZh: '新的', glossEn: 'new (pl.)' },
  { word: 'синий', glossZh: '蓝色的（软变化）', glossEn: 'blue (soft)' },
]
const ADJ_ROWS: CheatRow[] = [
  { c: 'n', forms: ['новый', 'новая', 'новое', 'новые', 'синий'] },
  { c: 'g', forms: ['нов[ого]', 'нов[ой]', 'нов[ого]', 'нов[ых]', 'син[его]'] },
  { c: 'd', forms: ['нов[ому]', 'нов[ой]', 'нов[ому]', 'нов[ым]', 'син[ему]'] },
  { c: 'a', forms: ['новый / нов[ого]', 'нов[ую]', 'новое', 'новые / нов[ых]', 'синий / син[его]'] },
  { c: 'i', forms: ['нов[ым]', 'нов[ой]', 'нов[ым]', 'нов[ыми]', 'син[им]'] },
  { c: 'p', forms: ['(о) нов[ом]', '(о) нов[ой]', '(о) нов[ом]', '(о) нов[ых]', '(о) син[ем]'] },
]

const PRON_COLS: CheatCol[] = [
  { word: 'я' }, { word: 'ты' }, { word: 'он / оно' }, { word: 'она' },
  { word: 'мы' }, { word: 'вы' }, { word: 'они' },
]
const PRON_ROWS: CheatRow[] = [
  { c: 'n', forms: ['я', 'ты', 'он / оно', 'она', 'мы', 'вы', 'они'] },
  { c: 'g', forms: ['меня', 'тебя', 'его', 'её', 'нас', 'вас', 'их'] },
  { c: 'd', forms: ['мне', 'тебе', 'ему', 'ей', 'нам', 'вам', 'им'] },
  { c: 'a', forms: ['меня', 'тебя', 'его', 'её', 'нас', 'вас', 'их'] },
  { c: 'i', forms: ['мной', 'тобой', 'им', 'ей', 'нами', 'вами', 'ими'] },
  { c: 'p', forms: ['(обо) мне', '(о) тебе', '(о) нём', '(о) ней', '(о) нас', '(о) вас', '(о) них'] },
]

// ── 动词表数据 ──
type Person = { r: string; zh?: string; en?: string }
const PERSONS: Person[] = [
  { r: 'я', zh: '我', en: 'I' },
  { r: 'ты', zh: '你', en: 'you (sg.)' },
  { r: 'он / она', zh: '他 / 她', en: 'he / she' },
  { r: 'мы', zh: '我们', en: 'we' },
  { r: 'вы', zh: '您 / 你们', en: 'you (pl.)' },
  { r: 'они', zh: '他们', en: 'they' },
]

function CheatTable({ cols, rows }: { cols: CheatCol[]; rows: CheatRow[] }) {
  const t = useT()
  const lang = useLang()
  return (
    <div className="ru-table-wrap">
      <table className="ru-cheat">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c.word}>
                {c.word}
                {lang !== 'ru' && (lang === 'zh' ? c.glossZh : c.glossEn) && (
                  <small>{lang === 'zh' ? c.glossZh : c.glossEn}</small>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.c}>
              <th scope="row">{t(`ru.dc.case.${r.c}`)}</th>
              {r.forms.map((f, i) => (
                <td key={i}><Mark s={f} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ═══════════════ ① 音译输入器 ═══════════════
function TranslitTool() {
  const t = useT()
  const [mode, setMode] = React.useState<'lat2ru' | 'ru2lat'>('lat2ru')
  const [input, setInput] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)

  const output = React.useMemo(
    () => (mode === 'lat2ru' ? latToCyr(input) : cyrToLat(input)),
    [input, mode],
  )

  const insert = (text: string) => {
    const el = inputRef.current
    if (!el) {
      setInput((v) => v + text)
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    setInput(el.value.slice(0, start) + text + el.value.slice(end))
    const pos = start + text.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const backspace = () => {
    const el = inputRef.current
    if (!el) {
      setInput((v) => v.slice(0, -1))
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    if (start !== end) {
      setInput(el.value.slice(0, start) + el.value.slice(end))
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(start, start)
      })
    } else if (start > 0) {
      setInput(el.value.slice(0, start - 1) + el.value.slice(start))
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(start - 1, start - 1)
      })
    }
  }

  const copyOut = async () => {
    try {
      await navigator.clipboard.writeText(output)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = output
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const latMode = mode === 'lat2ru'

  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
        <Keyboard size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
        {t('ru.tr.title')}
      </h2>
      <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('ru.tr.sub')}</p>

      <div className="ru-tabs" style={{ margin: '0 0 12px' }}>
        <button type="button" className={`ru-tab${latMode ? ' active' : ''}`} onClick={() => setMode('lat2ru')}>
          {t('ru.tr.mode.lat2ru')}
        </button>
        <button type="button" className={`ru-tab${!latMode ? ' active' : ''}`} onClick={() => setMode('ru2lat')}>
          {t('ru.tr.mode.ru2lat')}
        </button>
      </div>

      <div className="ru-grid-2">
        <div className="ru-field">
          <span className="ru-field-label">{latMode ? t('ru.tr.in.lat') : t('ru.tr.in.cyr')}</span>
          <textarea
            ref={inputRef}
            className="ru-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={latMode ? t('ru.tr.in.ph') : t('ru.tr.in.ph.cyr')}
            spellCheck={false}
          />
        </div>
        <div className="ru-field">
          <span className="ru-field-label">{latMode ? t('ru.tr.out.cyr') : t('ru.tr.out.lat')}</span>
          <textarea
            className="ru-textarea"
            value={output}
            readOnly
            placeholder={t('ru.tr.out.ph')}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="ru-actions" style={{ marginTop: 10 }}>
        <button type="button" className="primary-button" disabled={!output} onClick={() => void copyOut()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? t('ru.tr.copied') : t('ru.tr.copy')}
        </button>
        <button type="button" className="ghost-button" disabled={!input} onClick={() => setInput('')}>
          <Delete size={14} /> {t('ru.tr.clear')}
        </button>
      </div>

      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>{t('ru.tr.kbd.title')}</h3>
      <div className="ru-kbd">
        {KB_ROWS.map((row, ri) => (
          <div className="ru-kbd-row" key={ri}>
            {Array.from(row).map((ch, ci) => (
              <button type="button" className="ru-key" key={ci} onClick={() => insert(ch)}>{ch}</button>
            ))}
          </div>
        ))}
        <div className="ru-kbd-row">
          <button type="button" className="ru-key wide" onClick={() => insert(' ')}>{t('ru.tr.kbd.space')}</button>
          <button type="button" className="ru-key icon" title={t('ru.tr.kbd.backspace')} onClick={backspace}>
            <Delete size={14} />
          </button>
        </div>
      </div>

      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>{t('ru.tr.rules')}</h3>
      <div className="ru-chips">
        {[['shch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['zh', 'ж'], ['ts', 'ц'], ['yo', 'ё'], ['yu', 'ю'], ['ya', 'я'], ['eh', 'э'], ['j', 'й'], ['h', 'х'], ['c', 'ц'], ['y', 'ы'], ["'", 'ь'], ["''", 'ъ']].map(([lat, cyr]) => (
          <span className="ru-chip" key={lat}><b>{lat}</b> → {cyr}</span>
        ))}
      </div>
      <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 12 }}>{t('ru.tr.tip')}</p>
    </section>
  )
}

// ═══════════════ ② 字母表 + 数字 ═══════════════
function AlphabetTab() {
  const t = useT()
  const lang = useLang()
  const [noVoice, setNoVoice] = React.useState(false)

  const speakLetter = (x: Letter) => {
    // ъ / ь 单独发音无音，读字母名称
    void (async () => {
      if (!(await playRu(x.lat === "''" || x.lat === "'" ? x.name : x.l))) setNoVoice(true)
    })()
  }

  return (
    <>
      <section className="panel" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
          <Type size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          {t('ru.ab.title')}
        </h2>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>
          {noVoice ? t('ru.ab.nosound') : t('ru.ab.sub')}
        </p>
        <div className="ru-alpha-grid">
          {ALPHABET.map((x) => (
            <button type="button" className="ru-letter" key={x.l} onClick={() => speakLetter(x)}>
              <span className="glyph">{x.u} {x.l}</span>
              <span className="name">{x.name}</span>
              <span className="sound">{x.lat}{lang === 'zh' ? ` · ${x.zh}` : lang === 'en' ? ` · ${x.en}` : ''}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
          <Type size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          {t('ru.num.title')}
        </h2>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>
          {t('ru.num.cardinal')}
        </p>
        <div className="ru-num-grid">
          {NUMS.map(([n, w]) => (
            <button type="button" className="ru-num" key={n} onClick={() => { void (async () => { if (!(await playRu(w))) setNoVoice(true) })() }}>
              <b>{n}</b> {w}
            </button>
          ))}
        </div>
        <p style={{ margin: '14px 0 8px', color: 'var(--muted)', fontSize: 13 }}>
          {t('ru.num.ordinal')}
        </p>
        <div className="ru-num-grid">
          {ORDINALS.map(([n, w]) => (
            <button type="button" className="ru-num" key={n} onClick={() => { void (async () => { if (!(await playRu(w))) setNoVoice(true) })() }}>
              <b>{n}</b> {w}
            </button>
          ))}
        </div>
        <h3 style={{ margin: '14px 0 4px', fontSize: 13 }}>{t('ru.num.note.title')}</h3>
        <ul className="ru-note-list">
          <li>{t('ru.num.note.1')}</li>
          <li>{t('ru.num.note.2')}</li>
          <li>{t('ru.num.note.3')}</li>
        </ul>
      </section>
    </>
  )
}

// ═══════════════ ③ 变格速查 ═══════════════
function NounsTab() {
  const t = useT()
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
        <BookOpen size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
        {t('ru.dc.title')}
      </h2>

      <h3 style={{ margin: '10px 0 6px', fontSize: 13 }}>{t('ru.dc.masc')}</h3>
      <CheatTable cols={MASC_COLS} rows={MASC_ROWS} />

      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>{t('ru.dc.femneut')}</h3>
      <CheatTable cols={FEMNEUT_COLS} rows={FEMNEUT_ROWS} />

      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>{t('ru.dc.plural')}</h3>
      <CheatTable cols={PLURAL_COLS} rows={PLURAL_ROWS} />

      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>{t('ru.dc.adj')}</h3>
      <CheatTable cols={ADJ_COLS} rows={ADJ_ROWS} />

      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>{t('ru.dc.pron')}</h3>
      <CheatTable cols={PRON_COLS} rows={PRON_ROWS} />

      <h3 style={{ margin: '14px 0 4px', fontSize: 13 }}>{t('ru.dc.note.title')}</h3>
      <ul className="ru-note-list">
        <li>{t('ru.dc.note.1')}</li>
        <li>{t('ru.dc.note.2')}</li>
        <li>{t('ru.dc.note.3')}</li>
        <li>{t('ru.dc.note.4')}</li>
      </ul>
    </section>
  )
}

// ═══════════════ ④ 动词变位 ═══════════════
function ConjTable({ cols, forms }: { cols: CheatCol[]; forms: string[][] }) {
  return (
    <div className="ru-table-wrap">
      <table className="ru-cheat">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c.word}>
                {c.word}
                {(c.glossZh || c.glossEn) && <small>{c.glossZh} / {c.glossEn}</small>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERSONS.map((p, i) => (
            <tr key={p.r}>
              <th scope="row">{p.r}{(p.zh || p.en) && <small style={{ fontWeight: 400 }}>{p.zh} / {p.en}</small>}</th>
              {forms[i].map((f, j) => <td key={j}>{f}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VerbsTab() {
  const t = useT()
  const lang = useLang()
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
        <Repeat size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
        {t('ru.vb.title')}
      </h2>

      <h3 style={{ margin: '10px 0 4px', fontSize: 13 }}>{t('ru.vb.rule.title')}</h3>
      <ul className="ru-note-list">
        <li>{t('ru.vb.rule.1')}</li>
        <li>{t('ru.vb.rule.2')}</li>
        <li>{t('ru.vb.rule.3')}</li>
      </ul>

      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>{t('ru.vb.conj1')}</h3>
      <ConjTable
        cols={[{ word: 'работать', glossZh: '工作', glossEn: 'to work' }, { word: 'жить', glossZh: '生活', glossEn: 'to live' }]}
        forms={[
          ['работаю', 'живу'],
          ['работаешь', 'живёшь'],
          ['работает', 'живёт'],
          ['работаем', 'живём'],
          ['работаете', 'живёте'],
          ['работают', 'живут'],
        ]}
      />

      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>{t('ru.vb.conj2')}</h3>
      <ConjTable
        cols={[{ word: 'говорить', glossZh: '说', glossEn: 'to speak' }, { word: 'учиться', glossZh: '学习', glossEn: 'to study' }]}
        forms={[
          ['говорю', 'учусь'],
          ['говоришь', 'учишься'],
          ['говорит', 'учится'],
          ['говорим', 'учимся'],
          ['говорите', 'учитесь'],
          ['говорят', 'учатся'],
        ]}
      />

      <h3 style={{ margin: '14px 0 4px', fontSize: 13 }}>{t('ru.vb.past')}</h3>
      <p style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 12.5 }}>{t('ru.vb.past.rule')}</p>
      <div className="ru-table-wrap">
        <table className="ru-cheat">
          <thead>
            <tr>
              <th />
              {['работать', 'жить', 'говорить', 'идти'].map((w) => <th key={w}>{w}</th>)}
            </tr>
          </thead>
          <tbody>
            {(['m', 'f', 'n', 'pl'] as const).map((k, i) => (
              <tr key={k}>
                <th scope="row">{t(`ru.vb.g.${k}`)}</th>
                {[
                  ['работал', 'жил', 'говорил', 'шёл'],
                  ['работала', 'жила', 'говорила', 'шла'],
                  ['работало', 'жило', 'говорило', 'шло'],
                  ['работали', 'жили', 'говорили', 'шли'],
                ][i].map((f, j) => <td key={j}>{f}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: '14px 0 4px', fontSize: 13 }}>{t('ru.vb.fut')}</h3>
      <p style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 12.5 }}>{t('ru.vb.fut.rule')}</p>
      <div className="ru-table-wrap">
        <table className="ru-cheat">
          <thead>
            <tr><th /><th>быть</th></tr>
          </thead>
          <tbody>
            {PERSONS.map((p, i) => (
              <tr key={p.r}>
                <th scope="row">{p.r}</th>
                <td>{['буду', 'будешь', 'будет', 'будем', 'будете', 'будут'][i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: '14px 0 4px', fontSize: 13 }}>{t('ru.vb.imp')}</h3>
      <p style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 12.5 }}>{t('ru.vb.imp.rule')}</p>
      <div className="ru-table-wrap">
        <table className="ru-cheat">
          <thead>
            <tr>
              <th />
              <th>{lang === 'ru' ? 'читать' : 'читать (读 / to read)'}</th>
              <th>{lang === 'ru' ? 'говорить' : 'говорить (说 / to speak)'}</th>
              <th>{lang === 'ru' ? 'учиться' : 'учиться (学习 / to study)'}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">ты</th>
              <td>читай</td><td>говори</td><td>учись</td>
            </tr>
            <tr>
              <th scope="row">вы</th>
              <td>читайте</td><td>говорите</td><td>учитесь</td>
            </tr>
          </tbody>
        </table>
      </div>

      <ul className="ru-note-list" style={{ marginTop: 10 }}>
        <li>{t('ru.vb.note.2')}</li>
        <li>{t('ru.vb.note.3')}</li>
      </ul>
    </section>
  )
}


// ═══════════════ ⑤ 高分子术语点读（聚合物加工工艺方向）═══════════════
type PolymerCatId = 'base' | 'mat' | 'proc' | 'add'

// 数据中的重音用组合锐音符 U+0301 标注（如 поли́мер）。组合变音符号依赖字体
// 的定位锚点，在 Inter 等西文字体上常错位、与相邻字母重叠甚至渲染成方块。
// 显示层改用「重读元音高亮」标注（对记重音也更直观），朗读层照旧剥离。
function stressNodes(text: string): React.ReactNode[] {
  if (!text.includes('\u0301')) return [text]
  const out: React.ReactNode[] = []
  let buf = ''
  for (const ch of text) {
    if (ch === '\u0301') {
      const stressed = buf.slice(-1)
      if (stressed) {
        if (buf.length > 1) out.push(buf.slice(0, -1))
        out.push(<span key={out.length} className="stressed">{stressed}</span>)
        buf = ''
      }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

const POLYMER_CATS: Array<{ id: PolymerCatId; items: Phrase[] }> = [
  {
    id: 'base',
    items: [
      { ru: 'поли́мер', zh: '聚合物', en: 'polymer' },
      { ru: 'мономе́р', zh: '单体', en: 'monomer' },
      { ru: 'макромоле́кула', zh: '大分子', en: 'macromolecule' },
      { ru: 'олиго́мер', zh: '低聚物', en: 'oligomer' },
      { ru: 'сополи́мер', zh: '共聚物', en: 'copolymer' },
      { ru: 'полимериза́ция', zh: '聚合反应', en: 'polymerization' },
      { ru: 'поликонденса́ция', zh: '缩聚反应', en: 'polycondensation' },
      { ru: 'сте́пень полимериза́ции', zh: '聚合度', en: 'degree of polymerization' },
      { ru: 'молекуля́рная ма́сса', zh: '分子量', en: 'molecular mass' },
      { ru: 'полиме́рная цепь', zh: '聚合物链', en: 'polymer chain' },
      { ru: 'звено́', zh: '链节（重复单元）', en: 'repeat unit' },
      { ru: 'кристалли́чность', zh: '结晶度', en: 'crystallinity' },
      { ru: 'амо́рфный', zh: '无定形的', en: 'amorphous' },
      { ru: 'температу́ра стеклова́ния', zh: '玻璃化温度', en: 'glass-transition temperature' },
      { ru: 'температу́ра плавле́ния', zh: '熔融温度（熔点）', en: 'melting point' },
    ],
  },
  {
    id: 'mat',
    items: [
      { ru: 'полиэтиле́н', zh: '聚乙烯', en: 'polyethylene' },
      { ru: 'полипропиле́н', zh: '聚丙烯', en: 'polypropylene' },
      { ru: 'полистиро́л', zh: '聚苯乙烯', en: 'polystyrene' },
      { ru: 'поливинилхлори́д', zh: '聚氯乙烯', en: 'polyvinyl chloride' },
      { ru: 'фторопла́ст', zh: '氟塑料（聚四氟乙烯）', en: 'fluoropolymer (PTFE)' },
      { ru: 'полиами́д', zh: '聚酰胺（尼龙）', en: 'polyamide (nylon)' },
      { ru: 'полиэфи́р', zh: '聚酯', en: 'polyester' },
      { ru: 'поликарбона́т', zh: '聚碳酸酯', en: 'polycarbonate' },
      { ru: 'полиурета́н', zh: '聚氨酯', en: 'polyurethane' },
      { ru: 'полиметилметакрила́т', zh: '聚甲基丙烯酸甲酯（有机玻璃）', en: 'polymethyl methacrylate' },
      { ru: 'каучу́к', zh: '生胶（天然橡胶）', en: 'caoutchouc (raw rubber)' },
      { ru: 'рези́на', zh: '橡胶（硫化胶）', en: 'vulcanised rubber' },
      { ru: 'эластоме́р', zh: '弹性体', en: 'elastomer' },
      { ru: 'термопла́ст', zh: '热塑性塑料', en: 'thermoplastic' },
      { ru: 'реактопла́ст', zh: '热固性塑料', en: 'thermoset' },
      { ru: 'компози́т', zh: '复合材料', en: 'composite' },
      { ru: 'синтети́ческое волокно́', zh: '合成纤维', en: 'synthetic fibre' },
    ],
  },
  {
    id: 'proc',
    items: [
      { ru: 'экстру́зия', zh: '挤出', en: 'extrusion' },
      { ru: 'литьё под давле́нием', zh: '注塑成型', en: 'injection moulding' },
      { ru: 'вы́дувное формова́ние', zh: '吹塑成型', en: 'blow moulding' },
      { ru: 'ва́куумное формова́ние', zh: '真空成型', en: 'vacuum forming' },
      { ru: 'календри́рование', zh: '压延', en: 'calendering' },
      { ru: 'прессова́ние', zh: '压制成型', en: 'compression moulding' },
      { ru: 'формова́ние', zh: '成型', en: 'moulding / forming' },
      { ru: 'вулканиза́ция', zh: '硫化', en: 'vulcanization' },
      { ru: 'гранули́рование', zh: '造粒', en: 'granulation' },
      { ru: 'распла́в', zh: '熔体', en: 'melt' },
      { ru: 'червя́к', zh: '（挤出机）螺杆', en: 'extruder screw' },
      { ru: 'форму́ющая голо́вка', zh: '（挤出）机头', en: 'extrusion die' },
    ],
  },
  {
    id: 'add',
    items: [
      { ru: 'смола́', zh: '树脂', en: 'resin' },
      { ru: 'пластифика́тор', zh: '增塑剂', en: 'plasticizer' },
      { ru: 'стабилиза́тор', zh: '稳定剂', en: 'stabilizer' },
      { ru: 'наполни́тель', zh: '填料', en: 'filler' },
      { ru: 'антиоксида́нт', zh: '抗氧剂', en: 'antioxidant' },
      { ru: 'пигме́нт', zh: '颜料 / 着色剂', en: 'pigment' },
      { ru: 'отвержде́ние', zh: '固化', en: 'curing' },
      { ru: 'вя́зкость', zh: '黏度', en: 'viscosity' },
      { ru: 'про́чность', zh: '强度', en: 'strength' },
      { ru: 'твёрдость', zh: '硬度', en: 'hardness' },
      { ru: 'износосто́йкость', zh: '耐磨性', en: 'wear resistance' },
      { ru: 'теплосто́йкость', zh: '耐热性', en: 'heat resistance' },
    ],
  },
]

function PolymerTab() {
  const t = useT()
  const lang = useLang()
  const [catId, setCatId] = React.useState<PolymerCatId>('base')
  const [noVoice, setNoVoice] = React.useState(false)
  const activeCat = POLYMER_CATS.find((c) => c.id === catId) ?? POLYMER_CATS[0]
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>
        <Boxes size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
        {t('ru.tab.polymer')}
      </h2>
      <p style={{ margin: '0 0 10px', color: 'var(--muted)', fontSize: 13 }}>
        {noVoice ? t('ru.ab.nosound') : t('ru.pl.hint')}
      </p>
      <div className="ru-tabs" style={{ margin: '0 0 12px' }} role="tablist">
        {POLYMER_CATS.map((c) => (
          <button
            type="button"
            key={c.id}
            role="tab"
            aria-selected={c.id === catId}
            className={`ru-tab${c.id === catId ? ' active' : ''}`}
            onClick={() => setCatId(c.id)}
          >
            {t(`ru.pl.cat.${c.id}`)}
          </button>
        ))}
      </div>
      <div className="ru-term-grid">
        {activeCat.items.map((x) => (
          <button type="button" className="ru-term" key={x.ru} onClick={() => { void playRu(x.ru).then((ok) => { if (!ok) setNoVoice(true) }) }}>
            <span className="ru">{stressNodes(x.ru)}</span>
            {lang !== 'ru' && <span className="tr">{lang === 'zh' ? x.zh : x.en}</span>}
          </button>
        ))}
      </div>
    </section>
  )
}

// ═══════════════ 词汇点读（前缀 / 后缀 / 词根 / 主题 / 功能词）═══════════════
function LexiconTab() {
  const t = useT()
  const lang = useLang()
  const [secId, setSecId] = React.useState<LexSectionId>('prefix')
  const [activeGroup, setActiveGroup] = React.useState<string>('')
  const [noVoice, setNoVoice] = React.useState(false)
  const [tocOpen, setTocOpen] = React.useState(false)
  const groupRefs = React.useRef<Record<string, HTMLElement | null>>({})
  const section = LEX_SECTIONS.find((s) => s.id === secId)!

  React.useEffect(() => {
    if (section.groups.length) setActiveGroup(section.groups[0].id)
  }, [secId, section])

  // 滚动时跟踪当前可见分组，高亮左侧目录
  React.useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const id = (e.target as HTMLElement).dataset.groupId
          if (id) setActiveGroup(id)
        }
      }
    }, { rootMargin: '-12px 0px -70% 0px', threshold: 0 })
    for (const g of section.groups) {
      const el = groupRefs.current[g.id]
      if (el) obs.observe(el)
    }
    return () => obs.disconnect()
  }, [secId, section])

  const tr = (e: { zh: string; en: string; ru: string }) => (lang === 'ru' ? e.ru : lang === 'zh' ? e.zh : e.en)

  const handlePlay = (text: string) => {
    void playRu(text, 0.85).then((ok) => { if (!ok) setNoVoice(true) })
  }

  const jumpTo = (id: string) => {
    const el = groupRefs.current[id]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveGroup(id)
    setTocOpen(false)
  }

  // 目录折叠按钮的标题：activeGroup 可能短暂指向上一章节的分组（切换瞬态），
  // 必须容错回退到首分组，否则 find 为 undefined 时取 title 会抛错导致页面 500
  const activeGroupObj = section.groups.find((g) => g.id === activeGroup) ?? section.groups[0]

  return (
    <section>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>{t('ru.lex.title')}</h2>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 4px' }}>{t('ru.lex.sub')}</p>

      <div className="ru-lex-tabs" role="tablist">
        {LEX_SECTIONS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={s.id === secId}
            className={`ru-lex-tab${s.id === secId ? ' active' : ''}`}
            onClick={() => { stopRu(); setSecId(s.id); setActiveGroup(''); setTocOpen(false) }}>
            {tr(s.title)}
          </button>
        ))}
      </div>

      {noVoice && <div className="ru-lex-novoice">{t('ru.lex.novoice')}</div>}

      <button type="button" className="ru-lex-toc-toggle"
        onClick={() => setTocOpen((v) => !v)}>
        {t('ru.lex.toc')}: {activeGroupObj ? tr(activeGroupObj.title) : ''}
      </button>

      <div className="ru-lex-layout">
        <nav className={`ru-lex-toc${tocOpen ? ' open' : ''}`} aria-label={t('ru.lex.toc')}>
          <h4>{t('ru.lex.toc')}</h4>
          <ul>
            {section.groups.map((g) => (
              <li key={g.id}>
                <a href={`#lex-${secId}-${g.id}`} className={g.id === activeGroup ? 'active' : ''}
                  onClick={(e) => { e.preventDefault(); jumpTo(g.id) }}>
                  {tr(g.title)} <span className="count">({g.items.length})</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ru-lex-section">
          {section.groups.map((g) => (
            <div key={g.id} className="ru-lex-group" id={`lex-${secId}-${g.id}`}
              data-group-id={g.id}
              ref={(el) => { groupRefs.current[g.id] = el }}>
              <h3>{tr(g.title)} <span className="sub">{lang === 'ru' ? g.title.en : g.title.ru}</span></h3>
              <div className="ru-lex-grid">
                {g.items.map((it) => (
                  <button type="button" key={it.ru} className="ru-lex-card" onClick={() => handlePlay(it.ru)}>
                    <span className="ru">{stressNodes(it.ru)}</span>
                    {lang !== 'ru' && <span className="tr">{lang === 'zh' ? it.zh : it.en}</span>}
                    {it.examples && it.examples.length > 0 && (
                      <div className="ex">
                        <span className="ex-label">{t('ru.lex.examples')}</span>
                        {it.examples.map((ex, i) => (
                          <div className="ex-row" key={i}>
                            <span className="ex-ru" style={{ cursor: 'pointer' }}
                              onClick={(e) => { e.stopPropagation(); handlePlay(ex.ru) }}>
                              {stressNodes(ex.ru)}
                            </span>
                            <span className="ex-tr">{lang === 'zh' ? ex.zh : lang === 'en' ? ex.en : ex.ru}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {it.note && (
                      <div className="note">
                        <span className="note-label">{t('ru.lex.note')}</span>
                        {it.note}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}


// ═══════════════ 页面入口 ═══════════════
export function RussianToolkit() {
  const t = useT()
  // 默认落在最高频的变格速查（学习刚需），输入器/字母表等工具类靠后
  const [tab, setTab] = React.useState<ToolkitTab>('nouns')

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div>
          <h1><BookA size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />{t('ru.page.title')}</h1>
          <p>{t('ru.page.sub')}</p>
        </div>
      </div>

      <React.Suspense fallback={<section className="panel" style={{ marginTop: 14, minHeight: 96 }} aria-hidden="true" />}>
        <DailyPhrase />
      </React.Suspense>

          <div className="ru-tabs" role="tablist">
            {(
              [
                ['nouns', t('ru.tab.nouns')],
                ['verbs', t('ru.tab.verbs')],
                ['materials', t('ru.tab.materials')],
                ['lexicon', t('ru.tab.lexicon')],
                ['translit', t('ru.tab.translit')],
                ['alphabet', t('ru.tab.alphabet')],
                ['polymer', t('ru.tab.polymer')],
              ] as Array<[ToolkitTab, string]>
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={`ru-tab${tab === id ? ' active' : ''}`}
                onClick={() => { stopRu(); setTab(id) }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'translit' && <TranslitTool />}
          {tab === 'alphabet' && <AlphabetTab />}
          {tab === 'nouns' && <NounsTab />}
          {tab === 'verbs' && <VerbsTab />}
          {tab === 'polymer' && <PolymerTab />}
          {tab === 'lexicon' && <LexiconTab />}
          {tab === 'materials' && (
            <React.Suspense
              fallback={
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--muted)' }}>
                  <span style={{ display: 'inline-block', animation: 'spin 0.9s linear infinite' }}>⟳</span>
                </div>
              }
            >
              <MaterialsTab />
            </React.Suspense>
          )}
    </div>
  )
}

export default RussianToolkit
