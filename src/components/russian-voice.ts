/**
 * 俄语语音基础设施（从 russian-toolkit.tsx 抽出为共享模块）：
 * 词汇点读、每日一句、元素周期表等多处共用。
 * 拆出的目的：每日一句面板（含 878KB 短语库）拆为 React.lazy 独立 chunk，
 * 语音能力必须放在两边都能 import 的中性模块里，避免 lazy chunk → 主组件的循环依赖。
 */
import * as React from 'react'

// ── 本地语音合成 ──
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

// ── TTS 友好化：把语音引擎常读错的单位/符号/缩写展开成完整俄语单词。
// 仅作兜底——数据中含大量数字/单位的条目应在 say 字段提供完整朗读文本（更准）。
// 注意：JS \b 词边界不支持西里尔字母（西里尔字符非 \w），须用显式西里尔范围做边界。
const CYR = 'А-Яа-яЁё'
export function ttsNormalize(s: string): string {
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
export function useRuVoiceMode(): RuVoiceMode {
  return React.useSyncExternalStore(
    (cb) => { modeListeners.add(cb); return () => { modeListeners.delete(cb) } },
    () => voiceMode,
    () => voiceMode,
  )
}

export function isMobileDevice(): boolean {
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
export function shouldUseServerVoice(): boolean {
  if (voiceMode === 'local') return false
  if (voiceMode === 'natural') return true
  return isMobileDevice() || !hasLocalRuVoice()
}

let ttsAudio: HTMLAudioElement | null = null

/**
 * 播放俄语文本（自动选择引擎）。rate 0.8 常速、0.5 慢速。
 * 返回 false 表示两种引擎都不可用（UI 据此提示）。
 */
export async function playRu(text: string, rate = 0.8): Promise<boolean> {
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
export function stopRu() {
  try { window.speechSynthesis.cancel() } catch { /* ignore */ }
  if (ttsAudio) { ttsAudio.pause(); ttsAudio.removeAttribute('src'); ttsAudio.load() }
}

export { speak }
