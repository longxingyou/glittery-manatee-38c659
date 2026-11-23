/**
 * 元素名称发音层。
 *
 * 音频由 scripts/fetch-element-audio.mjs 从 Wiktionary / Wikimedia Commons 抓取并自托管在
 * public/audio/elements/，清单为 element-audio.json（含署名与许可）。
 * 访客不需要任何特殊网络环境，直接同源请求静态文件。
 *
 * 播放优先级：当前元素语言的真人录音 → 浏览器语音合成（俄语走 playRu，手机端可用网关神经 TTS）。
 */
import audioData from './element-audio.json' with { type: 'json' }
import { playRu, speak, stopRu } from '../components/russian-voice'
import type { Lang } from './i18n'

export interface ElementAudioEntry {
  /** 站内路径，如 /audio/elements/80-ru.mp3 */
  src: string
  /** 原始文件名，用于辨认录音来源 */
  file: string
  /** 录音者 / 上传者署名 */
  credit: string
  license: string
  licenseUrl: string
  /** Commons 文件页 */
  sourceUrl: string
}

type AudioMap = Record<string, Partial<Record<Lang, ElementAudioEntry>>>

const AUDIO = audioData as unknown as AudioMap

/** 取某元素在指定语言下的真人录音；没有则返回 null */
export function getElementAudio(z: number, lang: Lang): ElementAudioEntry | null {
  return AUDIO[String(z)]?.[lang] ?? null
}

// ── 音频元素池：预取与播放共用同一个 <audio>，避免点击时重复请求 ──
// 悬停预取已经拉过的文件，点击时直接复用缓存，播放零等待。
const POOL_CAP = 90
const pool = new Map<string, HTMLAudioElement>()
let current: HTMLAudioElement | null = null

function audioFor(src: string): HTMLAudioElement {
  const hit = pool.get(src)
  if (hit) return hit
  const a = new Audio()
  a.preload = 'auto'
  a.src = src
  pool.set(src, a)
  if (pool.size > POOL_CAP) {
    // 淘汰最早创建的元素（长时间浏览后控制内存）
    const [oldSrc, old] = pool.entries().next().value as [string, HTMLAudioElement]
    try {
      old.pause()
      old.removeAttribute('src')
      old.load()
    } catch { /* ignore */ }
    pool.delete(oldSrc)
  }
  return a
}

/**
 * 朗读元素名称。返回 false 表示既无真人录音、语音合成也不可用。
 */
export async function playElementName(z: number, name: string, lang: Lang): Promise<boolean> {
  // 先中断上一次语音（录音与合成都要停），避免两种声音叠在一起
  if (current) {
    try {
      current.pause()
      current.currentTime = 0
    } catch { /* ignore */ }
  }
  stopRu()

  const rec = getElementAudio(z, lang)
  if (rec) {
    try {
      const a = audioFor(rec.src)
      current = a
      await a.play()
      return true
    } catch {
      // 录音失败时继续走语音合成兜底
    }
  }
  if (lang === 'ru') return playRu(name)
  return speak(name, 0.85, lang)
}

// ── 桌面端悬停预取：只取当前元素语言，池容量上限避免一次悬停扫全表 ──
export function prefetchElementAudio(z: number, lang: Lang) {
  if (typeof window === 'undefined') return
  // 触屏设备没有 hover，跳过以免浪费流量
  if (window.matchMedia?.('(hover: hover)').matches === false) return
  const rec = getElementAudio(z, lang)
  if (!rec) return
  audioFor(rec.src)
}
