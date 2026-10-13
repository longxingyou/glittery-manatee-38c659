/**
 * 每日一句 / 短语轮换面板（从 russian-toolkit.tsx 拆出，React.lazy 按需加载）。
 * src/lib/russian-phrases.ts（8 大分类 × ~150 条三语句，878KB 源码）只被本组件
 * 消费——拆分后短语库不再进入俄语工具箱主 chunk，首次打开工具箱不再多拉 ~800KB，
 * 仅在组件实际挂载时加载本 chunk。
 */
import * as React from 'react'
import { Check, ChevronDown, ChevronUp, Copy, Eye, EyeOff, Repeat, Sparkles, Turtle } from 'lucide-react'

import { useLang, useT } from '@/lib/i18n'
import { PHRASE_CATS, type PhraseCatId } from '@/lib/russian-phrases'
import { playRu, setRuVoiceMode, ttsNormalize, useRuVoiceMode } from './russian-voice'

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

export default DailyPhrase
