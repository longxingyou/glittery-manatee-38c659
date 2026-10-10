import * as React from 'react'
import { Atom, BookA, BookOpen, Boxes, Check, ChevronDown, ChevronUp, Copy, Delete, Eye, EyeOff, Keyboard, Repeat, Share2, Sparkles, Turtle, Type, Volume2, X } from 'lucide-react'

import { useLang, useT } from '@/lib/i18n'
import { PHRASE_CATS, type Phrase, type PhraseCatId } from '@/lib/russian-phrases'
import { LEX_SECTIONS, type LexSectionId } from '@/lib/russian-lexicon'
// 西里尔文本专用字体：Inter Variable 自带 cyrillic 子集（@font-face 按 unicode-range
// 声明，浏览器只在出现西里尔字符时下载对应分片），不受站点主题字体影响
import '@fontsource-variable/inter'

// =================================================================
// 俄语工具箱（/admin/russian，纯前端离线，无 server fn、无数据库）
// ① 音译输入器：拉丁 ↔ 西里尔双向转换 + ЙЦУКЕН 虚拟键盘（光标处插入）
// ② 字母表：33 字母卡片，点击用浏览器语音合成听发音（不可用静默降级）
// ③ 数字速查：基数词 / 序数词 + 用法备注
// ④ 变格速查：名词（阳/阴中/复数）、形容词、人称代词
// ⑤ 动词变位：第一/第二变位法、过去时、将来时、命令式
// =================================================================

type ToolkitTab = 'translit' | 'alphabet' | 'nouns' | 'verbs' | 'elements' | 'polymer' | 'lexicon'

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

function speak(text: string, rate = 0.8): boolean {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
    // 数据里的重音符号（组合锐音符 U+0301，如 полиме́р）供学习者 sight-reading，
    // TTS 朗读前剥离，否则部分语音引擎会把重音符号读错或读成杂音
    const clean = text.normalize('NFD').replace(/\u0301/g, '')
    const synth = window.speechSynthesis
    const u = new SpeechSynthesisUtterance(clean)
    u.lang = 'ru-RU'
    u.rate = rate
    const voice = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('ru'))
    if (voice) u.voice = voice
    synth.cancel()
    synth.speak(u)
    return true
  } catch {
    return false
  }
}

// TTS 友好化：把语音引擎常读错的单位/符号/缩写展开成完整俄语单词。
// 仅作兜底——数据中含大量数字/单位的条目应在 say 字段提供完整朗读文本（更准）。
// 注意：JS \b 词边界不支持西里尔字母（西里尔字符非 \w），须用显式西里尔范围做边界。
const CYR = 'А-Яа-яЁё'
function ttsNormalize(s: string): string {
  const word = (abbr: string, full: string) =>
    (t: string) =>
      t.replace(new RegExp(`(^|[^${CYR}])${abbr}([^${CYR}]|$)`, 'g'), `$1${full}$2`)
  let out = s
    // 复合单位优先于单单位替换
    .replace(/см⁻¹/g, 'обратных сантиметрах')
    .replace(/г\/моль/g, 'грамм на моль')
    .replace(/г\/см³/g, 'грамм на кубический сантиметр')
    .replace(/кг\/м³/g, 'килограмм на кубический метр')
    .replace(/км\/ч/g, 'километров в час')
    .replace(/°C|°С/g, ' градусов Цельсия')
    .replace(/(\d)\s*°/g, '$1 градуса')
    .replace(/(\d)\s*%/g, '$1 процентов')
  for (const [abbr, full] of [
    ['МПа', 'мегапаскалей'],
    ['кПа', 'килопаскалей'],
    ['ИК', 'инфракрасной'],
    ['ЯМР', 'ядерного магнитного резонанса'],
    ['ДСК', 'дифференциальной сканирующей калориметрии'],
    ['ТГА', 'термогравиметрического анализа'],
    ['ПЭТФ?', 'полиэтилентерефталата'],
    ['ПВХ', 'поливинилхлорида'],
    ['мм', 'миллиметров'],
    ['см', 'сантиметров'],
    ['км', 'километров'],
    ['кг', 'килограммов'],
    ['ПЭ', 'полиэтилена'],
    ['ПП', 'полипропилена'],
    ['ПС', 'полистирола'],
    ['ПА', 'полиамида'],
    // ПК 有歧义（поликарбонат / персональный компьютер），交给数据里的 say 字段精确处理
    ['ПУ', 'полиуретана'],
  ] as Array<[string, string]>) {
    out = word(abbr, full)(out)
  }
  return out
}

// ─────────────── 统一俄语播放：本地合成 / 服务端神经语音 ───────────────
// 手机浏览器普遍没有 ru-RU 合成语音；自动检测并改用 gateway 的神经 TTS 音频
// （ru-RU-SvetlanaNeural，带自然句子语调），桌面默认保留本地合成语音，
// 用户可手动切换到「自然语音」获得不生硬、有合适声调的朗读。
// 神经语音走同源 /api/tts 反代（src/routes/api.tts.ts）：gw 网关域名在国内
// 被 DNS 污染 + 443 直连阻断，浏览器直连网关必然无声；同源请求由 Worker 回源拉取
const TTS_BASE = '/api/tts'

export type RuVoiceMode = 'auto' | 'natural' | 'local'
let voiceMode: RuVoiceMode = 'auto'
const modeListeners = new Set<(m: RuVoiceMode) => void>()
try {
  const saved = localStorage.getItem('sg-ru-voice-mode')
  if (saved === 'natural' || saved === 'local' || saved === 'auto') voiceMode = saved
} catch { /* ignore */ }

export function getRuVoiceMode(): RuVoiceMode { return voiceMode }
export function setRuVoiceMode(m: RuVoiceMode) {
  voiceMode = m
  try { localStorage.setItem('sg-ru-voice-mode', m) } catch { /* ignore */ }
  modeListeners.forEach((fn) => fn(m))
}
function useRuVoiceMode(): RuVoiceMode {
  return React.useSyncExternalStore(
    (cb) => { modeListeners.add(cb); return () => { modeListeners.delete(cb) } },
    () => voiceMode,
    () => voiceMode,
  )
}

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}
function hasLocalRuVoice(): boolean {
  try {
    return typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && window.speechSynthesis.getVoices().some((v) => v.lang?.toLowerCase().startsWith('ru'))
  } catch {
    return false
  }
}
// 是否走服务端神经语音：手动 natural/local 优先；auto 时手机或无俄语语音→服务端
function shouldUseServerVoice(): boolean {
  if (voiceMode === 'local') return false
  if (voiceMode === 'natural') return true
  return isMobileDevice() || !hasLocalRuVoice()
}

let ttsAudio: HTMLAudioElement | null = null

/**
 * 播放俄语文本（自动选择引擎）。rate 0.8 常速、0.5 慢速。
 * 返回 false 表示两种引擎都不可用（UI 据此提示）。
 */
async function playRu(text: string, rate = 0.8): Promise<boolean> {
  if (shouldUseServerVoice()) {
    try {
      const url = `${TTS_BASE}?text=${encodeURIComponent(text)}&rate=${rate}`
      if (!ttsAudio) ttsAudio = new Audio()
      // 语速在服务端合成时控制，避免手机端变速导致音调异常
      ttsAudio.pause()
      ttsAudio.src = url
      await ttsAudio.play()
      return true
    } catch {
      // 服务端失败时本地引擎兜底（桌面场景）
      if (!isMobileDevice() && hasLocalRuVoice()) return speak(text, rate)
      return false
    }
  }
  const ok = speak(text, rate)
  if (!ok) {
    // 本地声称不可用：尝试服务端兜底
    try {
      if (!ttsAudio) ttsAudio = new Audio()
      ttsAudio.src = `${TTS_BASE}?text=${encodeURIComponent(text)}&rate=${rate}`
      await ttsAudio.play()
      return true
    } catch {
      return false
    }
  }
  return ok
}

// 需要中断朗读时（切换面板等）
function stopRu() {
  try { window.speechSynthesis.cancel() } catch { /* ignore */ }
  if (ttsAudio) { ttsAudio.pause(); ttsAudio.removeAttribute('src'); ttsAudio.load() }
}

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

// ═══════════════ ⓪ 每日一句 ═══════════════
// 句库数据从 src/lib/russian-phrases.ts 导入（8 大分类，每类约 150 条三语句子）

// 当日序号：按本地日期年内天数取模，跨天自动轮换（纯前端，无网络请求）
function dayIndex(len: number): number {
  const now = new Date()
  const start = new Date(now.getFullYear(), 0, 0)
  const day = Math.floor((now.getTime() - start.getTime()) / 86400000)
  return day % len
}

function DailyPhrase() {
  const t = useT()
  const lang = useLang()
  const [catId, setCatId] = React.useState<PhraseCatId>('greet')
  // 挂载后才取日期序号：SSR（服务器时区）与客户端可能差一天，延迟计算避免水合不匹配
  const [base, setBase] = React.useState<number | null>(null)
  const [offset, setOffset] = React.useState(0)
  const [copied, setCopied] = React.useState(false)
  const [noVoice, setNoVoice] = React.useState(false)
  // 面板折叠 / 译文隐藏：持久化到 localStorage，避免每次进来重设
  const [collapsed, setCollapsed] = React.useState(false)
  const [hideTr, setHideTr] = React.useState(false)
  const voiceMode = useRuVoiceMode()
  React.useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('sg-ru-daily-fold') === '1')
      setHideTr(localStorage.getItem('sg-ru-daily-hidetr') === '1')
    } catch { /* ignore */ }
  }, [])
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try { localStorage.setItem('sg-ru-daily-fold', v ? '0' : '1') } catch { /* ignore */ }
      return !v
    })
  }
  const toggleHideTr = () => {
    setHideTr((v) => {
      try { localStorage.setItem('sg-ru-daily-hidetr', v ? '0' : '1') } catch { /* ignore */ }
      return !v
    })
  }
  const activeCat = PHRASE_CATS.find((c) => c.id === catId) ?? PHRASE_CATS[0]
  React.useEffect(() => {
    setBase(dayIndex(activeCat.items.length))
    setOffset(0)
  }, [activeCat])
  if (base === null) return null
  const phrase = activeCat.items[(base + offset) % activeCat.items.length]
  // 朗读文本：优先数据里的 say（含数字/单位/缩写时提供），否则对 ru 做单位规范化
  const ttsText = phrase.say ?? ttsNormalize(phrase.ru)

  const copyPhrase = async () => {
    try {
      await navigator.clipboard.writeText(phrase.ru)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = phrase.ru
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div
        className="ru-daily-head"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed() } }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>
          <Sparkles size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          {t('ru.dl.title')}
        </h2>
        <span className="ru-daily-fold">
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          {collapsed ? t('ru.dl.expand') : t('ru.dl.collapse')}
        </span>
      </div>
      {!collapsed && (
        <>
          <p style={{ margin: '0 0 10px', color: 'var(--muted)', fontSize: 13 }}>
            {noVoice ? t('ru.ab.nosound') : t('ru.dl.sub')}
          </p>
          <div className="ru-tabs" style={{ margin: '0 0 10px' }} role="tablist">
            {PHRASE_CATS.map((c) => (
              <button
                type="button"
                key={c.id}
                role="tab"
                aria-selected={c.id === catId}
                className={`ru-tab${c.id === catId ? ' active' : ''}`}
                onClick={() => setCatId(c.id)}
              >
                {t(`ru.dl.cat.${c.id}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="ru-daily-card"
            onClick={() => { void (async () => { if (!(await playRu(ttsText))) setNoVoice(true) })() }}
          >
            {phrase.ctx && <span className="ru-daily-ctx">▸ {phrase.ctx}</span>}
            <span className="ru-daily-ru">{phrase.ru}</span>
            {lang !== 'ru' && (
              <span className={`ru-daily-tr${hideTr ? ' hidden' : ''}`}>
                {lang === 'zh' ? phrase.zh : phrase.en}
              </span>
            )}
          </button>
          <div className="ru-actions" style={{ marginTop: 10 }}>
            <button
              type="button"
              className={`ghost-button${voiceMode === 'natural' ? ' active' : ''}`}
              title={t('ru.dl.naturalhint')}
              onClick={() => setRuVoiceMode(voiceMode === 'natural' ? 'auto' : 'natural')}
            >
              <Sparkles size={14} /> {t('ru.dl.natural')}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => { void (async () => { if (!(await playRu(ttsText, 0.5))) setNoVoice(true) })() }}
            >
              <Turtle size={14} /> {t('ru.dl.slow')}
            </button>
            {lang !== 'ru' && (
              <button type="button" className="ghost-button" onClick={toggleHideTr}>
                {hideTr ? <EyeOff size={14} /> : <Eye size={14} />}
                {hideTr ? t('ru.dl.showtr') : t('ru.dl.hidetr')}
              </button>
            )}
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                // 随机换一句：从当前分类中均匀抽取，且保证与当前句不同
                const len = activeCat.items.length
                if (len <= 1) return
                const cur = (base + offset) % len
                let r = Math.floor(Math.random() * (len - 1))
                if (r >= cur) r++
                setBase(r)
                setOffset(0)
              }}
            >
              <Repeat size={14} /> {t('ru.dl.next')}
            </button>
            <button type="button" className="ghost-button" onClick={() => void copyPhrase()}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t('ru.dl.copied') : t('ru.dl.copy')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

// ═══════════════ ⑤ 元素周期表（俄语点读，118 元素标准网格布局）═══════════════
type Element = { z: number; sym: string; ru: string; zh: string; en: string }

const ELEMENTS: Element[] = [
  { z: 1, sym: 'H', ru: 'Водород', zh: '氢', en: 'Hydrogen' },
  { z: 2, sym: 'He', ru: 'Гелий', zh: '氦', en: 'Helium' },
  { z: 3, sym: 'Li', ru: 'Литий', zh: '锂', en: 'Lithium' },
  { z: 4, sym: 'Be', ru: 'Бериллий', zh: '铍', en: 'Beryllium' },
  { z: 5, sym: 'B', ru: 'Бор', zh: '硼', en: 'Boron' },
  { z: 6, sym: 'C', ru: 'Углерод', zh: '碳', en: 'Carbon' },
  { z: 7, sym: 'N', ru: 'Азот', zh: '氮', en: 'Nitrogen' },
  { z: 8, sym: 'O', ru: 'Кислород', zh: '氧', en: 'Oxygen' },
  { z: 9, sym: 'F', ru: 'Фтор', zh: '氟', en: 'Fluorine' },
  { z: 10, sym: 'Ne', ru: 'Неон', zh: '氖', en: 'Neon' },
  { z: 11, sym: 'Na', ru: 'Натрий', zh: '钠', en: 'Sodium' },
  { z: 12, sym: 'Mg', ru: 'Магний', zh: '镁', en: 'Magnesium' },
  { z: 13, sym: 'Al', ru: 'Алюминий', zh: '铝', en: 'Aluminium' },
  { z: 14, sym: 'Si', ru: 'Кремний', zh: '硅', en: 'Silicon' },
  { z: 15, sym: 'P', ru: 'Фосфор', zh: '磷', en: 'Phosphorus' },
  { z: 16, sym: 'S', ru: 'Сера', zh: '硫', en: 'Sulfur' },
  { z: 17, sym: 'Cl', ru: 'Хлор', zh: '氯', en: 'Chlorine' },
  { z: 18, sym: 'Ar', ru: 'Аргон', zh: '氩', en: 'Argon' },
  { z: 19, sym: 'K', ru: 'Калий', zh: '钾', en: 'Potassium' },
  { z: 20, sym: 'Ca', ru: 'Кальций', zh: '钙', en: 'Calcium' },
  { z: 21, sym: 'Sc', ru: 'Скандий', zh: '钪', en: 'Scandium' },
  { z: 22, sym: 'Ti', ru: 'Титан', zh: '钛', en: 'Titanium' },
  { z: 23, sym: 'V', ru: 'Ванадий', zh: '钒', en: 'Vanadium' },
  { z: 24, sym: 'Cr', ru: 'Хром', zh: '铬', en: 'Chromium' },
  { z: 25, sym: 'Mn', ru: 'Марганец', zh: '锰', en: 'Manganese' },
  { z: 26, sym: 'Fe', ru: 'Железо', zh: '铁', en: 'Iron' },
  { z: 27, sym: 'Co', ru: 'Кобальт', zh: '钴', en: 'Cobalt' },
  { z: 28, sym: 'Ni', ru: 'Никель', zh: '镍', en: 'Nickel' },
  { z: 29, sym: 'Cu', ru: 'Медь', zh: '铜', en: 'Copper' },
  { z: 30, sym: 'Zn', ru: 'Цинк', zh: '锌', en: 'Zinc' },
  { z: 31, sym: 'Ga', ru: 'Галлий', zh: '镓', en: 'Gallium' },
  { z: 32, sym: 'Ge', ru: 'Германий', zh: '锗', en: 'Germanium' },
  { z: 33, sym: 'As', ru: 'Мышьяк', zh: '砷', en: 'Arsenic' },
  { z: 34, sym: 'Se', ru: 'Селен', zh: '硒', en: 'Selenium' },
  { z: 35, sym: 'Br', ru: 'Бром', zh: '溴', en: 'Bromine' },
  { z: 36, sym: 'Kr', ru: 'Криптон', zh: '氪', en: 'Krypton' },
  { z: 37, sym: 'Rb', ru: 'Рубидий', zh: '铷', en: 'Rubidium' },
  { z: 38, sym: 'Sr', ru: 'Стронций', zh: '锶', en: 'Strontium' },
  { z: 39, sym: 'Y', ru: 'Иттрий', zh: '钇', en: 'Yttrium' },
  { z: 40, sym: 'Zr', ru: 'Цирконий', zh: '锆', en: 'Zirconium' },
  { z: 41, sym: 'Nb', ru: 'Ниобий', zh: '铌', en: 'Niobium' },
  { z: 42, sym: 'Mo', ru: 'Молибден', zh: '钼', en: 'Molybdenum' },
  { z: 43, sym: 'Tc', ru: 'Технеций', zh: '锝', en: 'Technetium' },
  { z: 44, sym: 'Ru', ru: 'Рутений', zh: '钌', en: 'Ruthenium' },
  { z: 45, sym: 'Rh', ru: 'Родий', zh: '铑', en: 'Rhodium' },
  { z: 46, sym: 'Pd', ru: 'Палладий', zh: '钯', en: 'Palladium' },
  { z: 47, sym: 'Ag', ru: 'Серебро', zh: '银', en: 'Silver' },
  { z: 48, sym: 'Cd', ru: 'Кадмий', zh: '镉', en: 'Cadmium' },
  { z: 49, sym: 'In', ru: 'Индий', zh: '铟', en: 'Indium' },
  { z: 50, sym: 'Sn', ru: 'Олово', zh: '锡', en: 'Tin' },
  { z: 51, sym: 'Sb', ru: 'Сурьма', zh: '锑', en: 'Antimony' },
  { z: 52, sym: 'Te', ru: 'Теллур', zh: '碲', en: 'Tellurium' },
  { z: 53, sym: 'I', ru: 'Иод', zh: '碘', en: 'Iodine' },
  { z: 54, sym: 'Xe', ru: 'Ксенон', zh: '氙', en: 'Xenon' },
  { z: 55, sym: 'Cs', ru: 'Цезий', zh: '铯', en: 'Caesium' },
  { z: 56, sym: 'Ba', ru: 'Барий', zh: '钡', en: 'Barium' },
  { z: 57, sym: 'La', ru: 'Лантан', zh: '镧', en: 'Lanthanum' },
  { z: 58, sym: 'Ce', ru: 'Церий', zh: '铈', en: 'Cerium' },
  { z: 59, sym: 'Pr', ru: 'Празеодим', zh: '镨', en: 'Praseodymium' },
  { z: 60, sym: 'Nd', ru: 'Неодим', zh: '钕', en: 'Neodymium' },
  { z: 61, sym: 'Pm', ru: 'Прометий', zh: '钷', en: 'Promethium' },
  { z: 62, sym: 'Sm', ru: 'Самарий', zh: '钐', en: 'Samarium' },
  { z: 63, sym: 'Eu', ru: 'Европий', zh: '铕', en: 'Europium' },
  { z: 64, sym: 'Gd', ru: 'Гадолиний', zh: '钆', en: 'Gadolinium' },
  { z: 65, sym: 'Tb', ru: 'Тербий', zh: '铽', en: 'Terbium' },
  { z: 66, sym: 'Dy', ru: 'Диспрозий', zh: '镝', en: 'Dysprosium' },
  { z: 67, sym: 'Ho', ru: 'Гольмий', zh: '钬', en: 'Holmium' },
  { z: 68, sym: 'Er', ru: 'Эрбий', zh: '铒', en: 'Erbium' },
  { z: 69, sym: 'Tm', ru: 'Тулий', zh: '铥', en: 'Thulium' },
  { z: 70, sym: 'Yb', ru: 'Иттербий', zh: '镱', en: 'Ytterbium' },
  { z: 71, sym: 'Lu', ru: 'Лютеций', zh: '镥', en: 'Lutetium' },
  { z: 72, sym: 'Hf', ru: 'Гафний', zh: '铪', en: 'Hafnium' },
  { z: 73, sym: 'Ta', ru: 'Тантал', zh: '钽', en: 'Tantalum' },
  { z: 74, sym: 'W', ru: 'Вольфрам', zh: '钨', en: 'Tungsten' },
  { z: 75, sym: 'Re', ru: 'Рений', zh: '铼', en: 'Rhenium' },
  { z: 76, sym: 'Os', ru: 'Осмий', zh: '锇', en: 'Osmium' },
  { z: 77, sym: 'Ir', ru: 'Иридий', zh: '铱', en: 'Iridium' },
  { z: 78, sym: 'Pt', ru: 'Платина', zh: '铂', en: 'Platinum' },
  { z: 79, sym: 'Au', ru: 'Золото', zh: '金', en: 'Gold' },
  { z: 80, sym: 'Hg', ru: 'Ртуть', zh: '汞', en: 'Mercury' },
  { z: 81, sym: 'Tl', ru: 'Таллий', zh: '铊', en: 'Thallium' },
  { z: 82, sym: 'Pb', ru: 'Свинец', zh: '铅', en: 'Lead' },
  { z: 83, sym: 'Bi', ru: 'Висмут', zh: '铋', en: 'Bismuth' },
  { z: 84, sym: 'Po', ru: 'Полоний', zh: '钋', en: 'Polonium' },
  { z: 85, sym: 'At', ru: 'Астат', zh: '砹', en: 'Astatine' },
  { z: 86, sym: 'Rn', ru: 'Радон', zh: '氡', en: 'Radon' },
  { z: 87, sym: 'Fr', ru: 'Франций', zh: '钫', en: 'Francium' },
  { z: 88, sym: 'Ra', ru: 'Радий', zh: '镭', en: 'Radium' },
  { z: 89, sym: 'Ac', ru: 'Актиний', zh: '锕', en: 'Actinium' },
  { z: 90, sym: 'Th', ru: 'Торий', zh: '钍', en: 'Thorium' },
  { z: 91, sym: 'Pa', ru: 'Протактиний', zh: '镤', en: 'Protactinium' },
  { z: 92, sym: 'U', ru: 'Уран', zh: '铀', en: 'Uranium' },
  { z: 93, sym: 'Np', ru: 'Нептуний', zh: '镎', en: 'Neptunium' },
  { z: 94, sym: 'Pu', ru: 'Плутоний', zh: '钚', en: 'Plutonium' },
  { z: 95, sym: 'Am', ru: 'Америций', zh: '镅', en: 'Americium' },
  { z: 96, sym: 'Cm', ru: 'Кюрий', zh: '锔', en: 'Curium' },
  { z: 97, sym: 'Bk', ru: 'Берклий', zh: '锫', en: 'Berkelium' },
  { z: 98, sym: 'Cf', ru: 'Калифорний', zh: '锎', en: 'Californium' },
  { z: 99, sym: 'Es', ru: 'Эйнштейний', zh: '锿', en: 'Einsteinium' },
  { z: 100, sym: 'Fm', ru: 'Фермий', zh: '镄', en: 'Fermium' },
  { z: 101, sym: 'Md', ru: 'Менделевий', zh: '钔', en: 'Mendelevium' },
  { z: 102, sym: 'No', ru: 'Нобелий', zh: '锘', en: 'Nobelium' },
  { z: 103, sym: 'Lr', ru: 'Лоуренсий', zh: '铹', en: 'Lawrencium' },
  { z: 104, sym: 'Rf', ru: 'Резерфордий', zh: '𬬻', en: 'Rutherfordium' },
  { z: 105, sym: 'Db', ru: 'Дубний', zh: '𬭊', en: 'Dubnium' },
  { z: 106, sym: 'Sg', ru: 'Сиборгий', zh: '𬭳', en: 'Seaborgium' },
  { z: 107, sym: 'Bh', ru: 'Борий', zh: '𬭛', en: 'Bohrium' },
  { z: 108, sym: 'Hs', ru: 'Хассий', zh: '𬭶', en: 'Hassium' },
  { z: 109, sym: 'Mt', ru: 'Мейтнерий', zh: '鿏', en: 'Meitnerium' },
  { z: 110, sym: 'Ds', ru: 'Дармштадтий', zh: '𫟷', en: 'Darmstadtium' },
  { z: 111, sym: 'Rg', ru: 'Рентгений', zh: '𫟔', en: 'Roentgenium' },
  { z: 112, sym: 'Cn', ru: 'Коперниций', zh: '鎶', en: 'Copernicium' },
  { z: 113, sym: 'Nh', ru: 'Нихоний', zh: '鉨', en: 'Nihonium' },
  { z: 114, sym: 'Fl', ru: 'Флеровий', zh: '𫓧', en: 'Flerovium' },
  { z: 115, sym: 'Mc', ru: 'Московий', zh: '镆', en: 'Moscovium' },
  { z: 116, sym: 'Lv', ru: 'Ливерморий', zh: '鉝', en: 'Livermorium' },
  { z: 117, sym: 'Ts', ru: 'Теннессин', zh: '鿬', en: 'Tennessine' },
  { z: 118, sym: 'Og', ru: 'Оганесон', zh: '鿫', en: 'Oganesson' },
]

// 标准周期表网格坐标（18 列；9/10 行为镧系/锕系）
// 返回 [逻辑周期行 1-7, 逻辑族列 1-18]；镧系/锕系单独第 9/10 行
function elGridPos(z: number): [number, number] {
  if (z === 1) return [1, 1]
  if (z === 2) return [1, 18]
  if (z <= 4) return [2, z - 2]
  if (z <= 10) return [2, z + 8]
  if (z <= 12) return [3, z - 10]
  if (z <= 18) return [3, z]
  if (z <= 36) return [4, z - 18]
  if (z <= 54) return [5, z - 36]
  // 镧系/锕系独立行：必须先于第 6/7 周期主体元素判断
  if (z >= 58 && z <= 71) return [9, z - 54]
  if (z >= 90 && z <= 103) return [10, z - 86]
  // 第 6 周期：Cs(55) Ba(56) La(57) 占 1-3 列，Hf(72)→4 … Rn(86)→18
  if (z <= 57) return [6, z - 54]
  if (z <= 86) return [6, z - 68]
  // 第 7 周期：Fr Ra Ac 占 1-3 列，Rf(104)→4 … Og(118)→18
  if (z <= 89) return [7, z - 86]
  return [7, z - 100]
}

// 元素类别（周期表配色 + 图例）：特殊族用集合列举，其余默认过渡金属
const EL_CAT_SETS: Array<[string, number[]]> = [
  ['noble', [2, 10, 18, 36, 54, 86, 118]],
  ['alkali', [3, 11, 19, 37, 55, 87]],
  ['alkaline', [4, 12, 20, 38, 56, 88]],
  ['halogen', [9, 17, 35, 53, 85, 117]],
  ['metalloid', [5, 14, 32, 33, 51, 52]],
  ['nonmetal', [1, 6, 7, 8, 15, 16, 34]],
  ['post', [13, 31, 49, 50, 81, 82, 83, 84, 113, 114, 115, 116]],
]
function elCat(z: number): string {
  if (z >= 57 && z <= 71) return 'lanth'
  if (z >= 89 && z <= 103) return 'act'
  for (const [c, zs] of EL_CAT_SETS) if (zs.includes(z)) return c
  return 'transition'
}

// 族号表头：中国/国际通用 IUPAC 1–18；俄国教材传统 I–VIII 族 + A（主族）/ B（副族）
const GROUP_LABELS_CN = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18']
const GROUP_LABELS_RU = ['IA', 'IIA', 'IIIB', 'IVB', 'VB', 'VIB', 'VIIB', 'VIIIB', 'VIIIB', 'VIIIB', 'IB', 'IIB', 'IIIA', 'IVA', 'VA', 'VIA', 'VIIA', 'VIIIA']

function ElementsTab() {
  const t = useT()
  const [sel, setSel] = React.useState<Element | null>(null)
  const [noVoice, setNoVoice] = React.useState(false)
  // 表格版本：ru 俄国常用版（俄语名 + I–VIII A/B 族标注）/ cn 中国常用版（中文名 + 1–18 IUPAC）
  const [ver, setVer] = React.useState<'cn' | 'ru'>('ru')
  React.useEffect(() => {
    try {
      const v = localStorage.getItem('sg-ru-pt-ver')
      if (v === 'cn' || v === 'ru') setVer(v)
    } catch { /* ignore */ }
  }, [])
  const changeVer = (v: 'cn' | 'ru') => {
    setVer(v)
    try { localStorage.setItem('sg-ru-pt-ver', v) } catch { /* ignore */ }
  }
  const say = async (e: Element) => {
    setSel(e)
    if (!(await playRu(e.ru))) setNoVoice(true)
  }
  const groups = ver === 'cn' ? GROUP_LABELS_CN : GROUP_LABELS_RU
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="ru-el-head">
        <h2 style={{ margin: 0, fontSize: 16 }}>
          <Atom size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          {t('ru.tab.elements')}
        </h2>
        <div className="ru-el-ver" role="group" aria-label={t('ru.el.ver')}>
          <button type="button" className={ver === 'ru' ? 'active' : ''} onClick={() => changeVer('ru')}>
            {t('ru.el.verru')}
          </button>
          <button type="button" className={ver === 'cn' ? 'active' : ''} onClick={() => changeVer('cn')}>
            {t('ru.el.vercn')}
          </button>
        </div>
      </div>
      <p style={{ margin: '8px 0 10px', color: 'var(--muted)', fontSize: 13 }}>
        {noVoice ? t('ru.ab.nosound') : t('ru.el.hint')}
      </p>
      <div className="ru-el-legend">
        {(['alkali', 'alkaline', 'transition', 'post', 'metalloid', 'nonmetal', 'halogen', 'noble', 'lanth', 'act'] as const).map((c) => (
          <span key={c} className="ru-el-legend-item">
            <i data-c={c} />
            {/* lanth/act 复用表格占位框的既有 key，避免词典重复 */}
            {t(c === 'lanth' ? 'ru.el.lan' : c === 'act' ? 'ru.el.act' : `ru.el.cat.${c}`)}
          </span>
        ))}
      </div>
      <div className="ru-pt-wrap">
        <div className="ru-pt ru-pt-19">
          {/* 第 1 行：族号表头（第 1 列留空放周期号） */}
          {groups.map((g, i) => (
            <span key={g + i} className="ru-pt-colhead" style={{ gridRow: 1, gridColumn: i + 2 }}>{g}</span>
          ))}
          {/* 第 1 列：周期号 */}
          {[1, 2, 3, 4, 5, 6, 7].map((p) => (
            <span key={p} className="ru-pt-rowhead" style={{ gridRow: p + 1, gridColumn: 1 }}>{p}</span>
          ))}
          {/* 镧系/锕系占位标签：逻辑 9/10 行 → 表格 10/11 行，列右移 1 */}
          <span className="ru-el-series" data-c="lanth" style={{ gridRow: 10, gridColumn: '2 / span 3' }}>{t('ru.el.lan')}</span>
          <span className="ru-el-series" data-c="act" style={{ gridRow: 11, gridColumn: '2 / span 3' }}>{t('ru.el.act')}</span>
          {ELEMENTS.map((e) => {
            const [row, col] = elGridPos(e.z)
            return (
              <button
                type="button"
                key={e.z}
                className={`ru-el${sel?.z === e.z ? ' sel' : ''}`}
                data-c={elCat(e.z)}
                style={{ gridRow: row + 1, gridColumn: col + 1 }}
                onClick={() => void say(e)}
              >
                <span className="n">{e.z}</span>
                <span className="s">{e.sym}</span>
                <span className="nm">{ver === 'cn' ? e.zh : e.ru}</span>
              </button>
            )
          })}
        </div>
      </div>
      {sel && (
        <div className="ru-el-detail">
          <button
            type="button"
            className="ru-el-say"
            onClick={async () => { if (!(await playRu(sel.ru))) setNoVoice(true) }}
          >
            <b>{sel.z} · {sel.sym}</b> {ver === 'cn' ? sel.zh : sel.ru} <Volume2 size={14} />
          </button>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>
            {ver === 'cn' ? `${sel.ru} · ${sel.en}` : `${sel.zh} · ${sel.en}`}
          </span>
        </div>
      )}
    </section>
  )
}

// ═══════════════ ⑥ 高分子术语点读（聚合物加工工艺方向）═══════════════
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
      { ru: 'наполи́тель', zh: '填料', en: 'filler' },
      { ru: 'антиоксида́нт', zh: '抗氧剂', en: 'antioxidant' },
      { ru: 'пигме́нт', zh: '颜料 / 着色剂', en: 'pigment' },
      { ru: 'отвержде́ние', zh: '固化', en: 'curing' },
      { ru: 'вя́зкость', zh: '黏度', en: 'viscosity' },
      { ru: 'про́чность', zh: '强度', en: 'strength' },
      { ru: 'твёрдость', zh: '硬度', en: 'hardness' },
      { ru: 'износосто́йкость', zh: '耐磨性', en: 'wear resistance' },
      { ru: 'теплесто́йкость', zh: '耐热性', en: 'heat resistance' },
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

// ═══════════════ 分享管理：小图标按钮 + 折叠浮层（默认收起，不遮挡工具箱）═══════════════
const RU_SHARE_API = '/api/ru-share'

type RuShareLinkInfo = {
  id: string
  createdAt: string
  lastUsedAt: string | null
  maxIps: number
  ipCount: number
}

async function postRuShare(action: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(RU_SHARE_API, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  })
  let data: Record<string, unknown> = {}
  try { data = (await res.json()) as Record<string, unknown> } catch { /* 非 JSON */ }
  if (!res.ok || data.ok === false) throw new Error((data.error as string) || `HTTP ${res.status}`)
  return data
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      return true
    } catch {
      return false
    }
  }
}

// ── 轻量 toast：非阻塞反馈，替代手机端 alert ──
const RU_TOAST_ROOT_ID = 'sg-ru-toast-root'
function showRuToast(message: string): void {
  if (typeof document === 'undefined') return
  let root = document.getElementById(RU_TOAST_ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = RU_TOAST_ROOT_ID
    root.className = 'ru-toast-root'
    document.body.appendChild(root)
  }
  const item = document.createElement('div')
  item.className = 'ru-toast'
  item.textContent = message
  root.appendChild(item)
  requestAnimationFrame(() => item.classList.add('show'))
  window.setTimeout(() => {
    item.classList.remove('show')
    window.setTimeout(() => item.remove(), 250)
  }, 2000)
}

type ShareOutcome = 'shared' | 'copied' | 'failed'
/** 优先调系统分享面板（手机微信/短信/AirDrop 等），不支持或失败则降级复制链接 */
async function shareOrCopy(url: string): Promise<ShareOutcome> {
  const nav = navigator as Navigator & { share?: (data: { url: string }) => Promise<void> }
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ url })
      return 'shared'
    } catch (e) {
      // 用户取消系统分享面板：静默处理
      if (e instanceof DOMException && e.name === 'AbortError') return 'shared'
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed'
}

export function RuShareButton() {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const [enabled, setEnabled] = React.useState(false)
  const [links, setLinks] = React.useState<RuShareLinkInfo[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [newMax, setNewMax] = React.useState(10)
  // 明文链接仅在创建时出现一次（DB 只存 token 哈希）
  const [freshUrls, setFreshUrls] = React.useState<Record<string, string>>({})
  // 关闭分享：二次点击内联确认，不用阻塞式 confirm
  const [confirmOff, setConfirmOff] = React.useState(false)
  const [canNativeShare, setCanNativeShare] = React.useState(false)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const confirmTimer = React.useRef<number | null>(null)

  const claimUrl = React.useCallback(
    (token: string) => `${window.location.origin}/api/ru-share?action=claim&t=${token}`,
    [],
  )

  const rememberFresh = (data: Record<string, unknown>) => {
    if (data.token && data.id) {
      setFreshUrls((m) => ({ ...m, [String(data.id)]: claimUrl(String(data.token)) }))
    }
  }

  const refresh = React.useCallback(async () => {
    const data = await postRuShare('ru_share_list')
    setEnabled(data.enabled === true)
    setLinks((data.links as RuShareLinkInfo[]) ?? [])
    setLoaded(true)
  }, [])

  // 首次展开才加载（收起时零请求）
  React.useEffect(() => {
    if (!open || loaded) return
    refresh().catch((e) => { setError(e instanceof Error ? e.message : t('admin.ru.share.failed')); setLoaded(true) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 检测系统分享能力（手机端显示"系统分享"）
  React.useEffect(() => {
    setCanNativeShare(typeof (navigator as Navigator & { share?: unknown }).share === 'function')
  }, [])

  // 点击浮层/抽屉外部自动收起
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  // 抽屉打开时锁定背景滚动（手机）
  React.useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  React.useEffect(() => () => { if (confirmTimer.current) window.clearTimeout(confirmTimer.current) }, [])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : t('admin.ru.share.failed')) } finally { setBusy('') }
  }

  const enableShare = () => run('toggle', async () => {
    const data = await postRuShare('ru_share_toggle', { enabled: true })
    setEnabled(true)
    rememberFresh(data)
    await refresh()
  })

  const disableShare = () => run('toggle', async () => {
    await postRuShare('ru_share_toggle', { enabled: false })
    setEnabled(false)
    setLinks([])
    setFreshUrls({})
    setConfirmOff(false)
  })

  const onMainToggle = () => {
    if (!enabled) { void enableShare(); return }
    if (!confirmOff) {
      setConfirmOff(true)
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(() => setConfirmOff(false), 3000)
      return
    }
    void disableShare()
  }

  const create = () => run('create', async () => {
    const data = await postRuShare('ru_share_create', { maxIps: newMax })
    rememberFresh(data)
    await refresh()
  })

  // IP 上限：失焦才提交，避免每次击键打 API
  const commitIps = (l: RuShareLinkInfo, raw: string) => {
    const n = Math.min(100, Math.max(1, Number(raw) || l.maxIps))
    if (n === l.maxIps) return
    void run(`ips-${l.id}`, async () => {
      await postRuShare('ru_share_set_ips', { id: l.id, maxIps: n })
      await refresh()
    })
  }

  const sendOut = async (url: string) => {
    const r = await shareOrCopy(url)
    if (r === 'copied') showRuToast(t('admin.ru.share.copied'))
    else if (r === 'failed') setError(t('admin.ru.share.failed'))
  }

  return (
    <div className="ru-share-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ru-share-trigger${enabled ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={t('admin.ru.share.title')}
        aria-expanded={open}
      >
        <Share2 size={15} />
        <span>{t('admin.ru.share.trigger')}</span>
      </button>

      {open && (
        <>
          <div className="ru-share-scrim" onClick={() => setOpen(false)} />
          <div className="ru-share-pop" role="dialog" aria-modal="true" aria-label={t('admin.ru.share.title')}>
            <div className="ru-share-grip" />
            <div className="ru-share-pop-head">
              <strong>{t('admin.ru.share.title')}</strong>
              <span className={enabled ? 'st-on' : 'st-off'}>
                {loaded ? (enabled ? t('admin.ru.share.on') : t('admin.ru.share.off')) : '…'}
              </span>
              <button type="button" className="ru-share-x" onClick={() => setOpen(false)} aria-label="close">
                <X size={16} />
              </button>
            </div>
            <p className="ru-share-desc">{t('admin.ru.share.desc')}</p>

            <div className="ru-share-actions">
              <button
                type="button"
                className={confirmOff ? 'ru-share-confirming' : enabled ? 'ghost-button' : 'primary-button'}
                disabled={busy === 'toggle' || !loaded}
                onClick={onMainToggle}
              >
                {!enabled ? t('admin.ru.share.turnon')
                  : confirmOff ? t('admin.ru.share.confirmoff-btn')
                  : t('admin.ru.share.turnoff')}
              </button>
              <label className="ru-share-maxlabel">
                {t('admin.ru.share.maxips')}
                <input
                  type="number" inputMode="numeric" min={1} max={100} value={newMax}
                  onChange={(e) => setNewMax(Math.min(100, Math.max(1, Number(e.target.value) || 10)))}
                />
              </label>
              <button type="button" className="ghost-button" disabled={busy === 'create' || !loaded}
                onClick={() => void create()}>
                {t('admin.ru.share.add')}
              </button>
            </div>

            {error && <div className="banner error" style={{ marginTop: 10 }}>{error}</div>}

            {links.length === 0 && loaded && (
              <p className="ru-share-empty">{t('admin.ru.share.empty')}</p>
            )}

            <ul className="ru-share-list">
              {links.map((l) => {
                const full = l.ipCount >= l.maxIps
                return (
                  <li key={l.id}>
                    <div className="ru-share-row ru-share-meta">
                      <code>#{l.id}</code>
                      <span className={`ru-share-ips${full ? ' full' : ''}`}>
                        {t('admin.ru.share.usage')}: {l.ipCount}/{l.maxIps}
                      </span>
                      <span className="ru-share-last">
                        {l.lastUsedAt ? new Date(l.lastUsedAt).toLocaleString() : t('admin.ru.share.never')}
                      </span>
                    </div>
                    <div className="ru-share-row ru-share-controls">
                      <label className="ru-share-inline">
                        {t('admin.ru.share.maxips')}
                        <input
                          type="number" inputMode="numeric" min={1} max={100} defaultValue={l.maxIps}
                          disabled={busy === `ips-${l.id}`}
                          onBlur={(e) => commitIps(l, e.target.value)}
                        />
                      </label>
                      {l.ipCount > 0 && (
                        <button type="button" className="ghost-button" disabled={busy === `reset-${l.id}`}
                          onClick={() => void run(`reset-${l.id}`, async () => {
                            await postRuShare('ru_share_reset', { id: l.id })
                            await refresh()
                          })}>
                          {t('admin.ru.share.reset')}
                        </button>
                      )}
                      <button type="button" className="ghost-button" disabled={busy === `del-${l.id}`}
                        onClick={() => void run(`del-${l.id}`, async () => {
                          await postRuShare('ru_share_delete', { id: l.id })
                          await refresh()
                        })}>
                        {t('admin.ru.share.delete')}
                      </button>
                    </div>
                    {freshUrls[l.id] && (
                      <div className="ru-share-fresh">
                        <span>{t('admin.ru.share.newurl')}</span>
                        <code>{freshUrls[l.id]}</code>
                        <div className="ru-share-fresh-actions">
                          {canNativeShare && (
                            <button type="button" className="primary-button small"
                              onClick={() => void sendOut(freshUrls[l.id]!)}>
                              <Share2 size={13} />
                              {t('admin.ru.share.native')}
                            </button>
                          )}
                          <button type="button" className="ghost-button"
                            onClick={() => void sendOut(freshUrls[l.id]!)}>
                            <Copy size={13} />
                            {t('admin.ru.share.copy')}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

// ═══════════════ 页面入口 ═══════════════
export function RussianToolkit({ shared = false }: { shared?: boolean } = {}) {
  const t = useT()
  const [tab, setTab] = React.useState<ToolkitTab>('translit')
  // 分享模式：挂载时自检 /api/ru-share?action=info（cookie + IP 绑定）
  const [denied, setDenied] = React.useState('')
  const [checking, setChecking] = React.useState(shared)

  React.useEffect(() => {
    if (!shared) return
    fetch(`${RU_SHARE_API}?action=info`, { credentials: 'same-origin' })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean }
        if (res.status === 403 || data.ok !== true) setDenied(t('admin.ru.share.denied'))
      })
      .catch(() => setDenied(t('admin.ru.share.denied')))
      .finally(() => setChecking(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared])

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div>
          <h1><BookA size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />{t('ru.page.title')}</h1>
          <p>{t(shared ? 'admin.ru.share.page-sub' : 'ru.page.sub')}</p>
        </div>
        {!shared && <div className="header-actions"><RuShareButton /></div>}
      </div>

      {checking && (
        <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--muted)' }}>
          <span style={{ display: 'inline-block', animation: 'spin 0.9s linear infinite' }}>⟳</span>
        </div>
      )}
      {denied && (
        <div className="ru-share-denied">
          <h2>{t('admin.ru.share.denied-title')}</h2>
          <p>{denied}</p>
        </div>
      )}

      {!checking && !denied && (
        <>
          <DailyPhrase />

          <div className="ru-tabs" role="tablist">
            {(
              [
                ['translit', t('ru.tab.translit')],
                ['alphabet', t('ru.tab.alphabet')],
                ['nouns', t('ru.tab.nouns')],
                ['verbs', t('ru.tab.verbs')],
                ['elements', t('ru.tab.elements')],
                ['polymer', t('ru.tab.polymer')],
                ['lexicon', t('ru.tab.lexicon')],
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
          {tab === 'elements' && <ElementsTab />}
          {tab === 'polymer' && <PolymerTab />}
          {tab === 'lexicon' && <LexiconTab />}
        </>
      )}
    </div>
  )
}

export default RussianToolkit
