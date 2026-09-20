import React from 'react'
import { createPortal } from 'react-dom'
import { STICKER_SETS, getFrequentStickers, recordStickerUse, type StickerSet } from '@/lib/stickers'
import { useT } from '@/lib/i18n'

/** 「常用」标签页标识 */
const FREQ_TAB = 'freq'
type PickerTab = StickerSet | typeof FREQ_TAB

interface StickerPickerProps {
  /** 选中表情后回调，传入 shortcode 如 `:qingbao-01:` */
  onSelect: (shortcode: string) => void
  /** 关闭面板 */
  onClose: () => void
  /** 锚点元素（触发按钮），用于计算弹出位置 */
  anchor: HTMLElement | null
}

/** 面板目标尺寸（与 CSS 保持一致） */
const PANEL_W = 340
const PANEL_MAX_H = 380
const GAP = 6
const EDGE = 8
/** 手机端长按触发预览的时长（ms） */
const LONG_PRESS_MS = 420

/** 预览锚点：触发元素 + 表情展示数据 */
type PreviewTarget = { el: HTMLElement; url: string; desc: string }

type Pos = { mobile: true; bottom: number; maxH: number } | { mobile: false; left: number; top: number; maxH: number; above: boolean }

/** 当前被软键盘遮挡的高度（visualViewport 相对布局视口） */
function keyboardInset(): number {
  const vv = window.visualViewport
  if (!vv) return 0
  return Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
}

/** 计算面板 fixed 定位：优先贴锚点，空间不足则翻转，最终钳制在视口内 */
function computePosition(anchor: HTMLElement): Pos {
  const rect = anchor.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  // 移动端：底部弹层；bottom 抬升到软键盘之上，maxHeight 适配可视视口
  if (vw <= 640) {
    const vv = window.visualViewport
    const vvH = vv ? vv.height : vh
    return {
      mobile: true,
      bottom: keyboardInset(),
      maxH: Math.max(200, Math.min(440, vvH - EDGE * 2)),
    }
  }

  const width = Math.min(PANEL_W, vw - EDGE * 2)
  // 水平：对齐锚点右缘，再钳制进视口
  const left = Math.max(EDGE, Math.min(rect.right - width, vw - width - EDGE))

  const spaceAbove = rect.top - GAP - EDGE
  const spaceBelow = vh - rect.bottom - GAP - EDGE
  // 上下空间足够时优先向上（触发按钮多在编辑器底部）；否则选空间更大的一侧
  const above = spaceAbove >= PANEL_MAX_H
    ? true
    : spaceBelow >= PANEL_MAX_H
      ? false
      : spaceAbove >= spaceBelow

  const maxH = Math.max(160, Math.min(PANEL_MAX_H, above ? spaceAbove : spaceBelow))
  const rawTop = above ? rect.top - GAP : rect.bottom + GAP
  const top = Math.max(EDGE, Math.min(rawTop, vh - EDGE))

  return { mobile: false, left, top, maxH, above }
}

/** 浮动表情包选择面板：常用 + 两套切换 + 网格 + 描述；Portal 渲染避免被祖先裁剪 */
export function StickerPicker({ onSelect, onClose, anchor }: StickerPickerProps) {
  const t = useT()
  // 有本地常用记录时默认落在「常用」页，否则默认第一套表情；面板每次打开都重新挂载
  const [activeTab, setActiveTab] = React.useState<PickerTab>(() =>
    getFrequentStickers(1).length > 0 ? FREQ_TAB : STICKER_SETS[0].key,
  )
  // 悬停（桌面）/ 长按（手机）触发的大图预览；null 表示不展示
  const [preview, setPreview] = React.useState<PreviewTarget | null>(null)
  // 初始即同步计算，避免首帧闪烁；滚动/缩放时跟随重算
  const [pos, setPos] = React.useState<Pos | null>(() => (anchor ? computePosition(anchor) : null))
  const set = activeTab !== FREQ_TAB ? STICKER_SETS.find((s) => s.key === activeTab) : undefined
  const frequent = activeTab === FREQ_TAB ? getFrequentStickers() : []

  React.useEffect(() => {
    if (!anchor) return
    const reposition = () => setPos(computePosition(anchor))
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('resize', reposition)
    }
  }, [anchor])

  // 选中即记录到本地常用缓存（隐私模式/存储失败时静默降级），再交由外部插入
  const handleSelect = (shortcode: string) => {
    recordStickerUse(shortcode)
    onSelect(shortcode)
  }

  // 切换分类时关闭预览，避免预览残留在已卸载的元素上
  const switchTab = (tab: PickerTab) => { setPreview(null); setActiveTab(tab) }

  const style = pos
    ? pos.mobile
      ? { bottom: pos.bottom, maxHeight: pos.maxH }
      : {
          left: pos.left,
          top: pos.top,
          maxHeight: pos.maxH,
          transform: pos.above ? 'translateY(-100%)' : undefined,
        }
    : undefined

  return createPortal(
    <div
      className={`sticker-picker${pos && !pos.mobile ? ' positioned' : ''}`}
      style={style}
      role="dialog"
      aria-label={t('sticker.aria')}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="sticker-picker-tabs">
        <button
          type="button"
          className={`sticker-tab ${activeTab === FREQ_TAB ? 'on' : ''}`}
          onClick={() => switchTab(FREQ_TAB)}
          title={t('sticker.recent.title')}
        >
          <StarIcon />
          {t('sticker.recent')}
        </button>
        {STICKER_SETS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`sticker-tab ${s.key === activeTab ? 'on' : ''}`}
            onClick={() => switchTab(s.key)}
          >
            {s.label}
          </button>
        ))}
        <button type="button" className="sticker-close" onClick={onClose} aria-label={t('sticker.close.aria')} title={t('common.close')}>✕</button>
      </div>
      {activeTab === FREQ_TAB ? (
        frequent.length > 0 ? (
          <div className="sticker-grid">
            {frequent.map((f) => (
              <StickerItem
                key={f.shortcode}
                url={f.def.url}
                desc={f.def.desc}
                shortcode={`:${f.shortcode}:`}
                onPick={handleSelect}
                onPreview={setPreview}
                onPreviewEnd={() => setPreview(null)}
              />
            ))}
          </div>
        ) : (
          <div className="sticker-empty">
            <p>{t('sticker.empty')}</p>
            <p>{t('sticker.empty.hint')}</p>
          </div>
        )
      ) : (
        <div className="sticker-grid">
          {set!.stickers.map((s) => (
            <StickerItem
              key={s.id}
              url={s.url}
              desc={s.desc}
              shortcode={`:${set!.key}-${s.id}:`}
              onPick={handleSelect}
              onPreview={setPreview}
              onPreviewEnd={() => setPreview(null)}
            />
          ))}
        </div>
      )}
      {preview && <StickerPreview target={preview} />}
    </div>,
    document.body,
  )
}

/**
 * 单个表情按钮：
 * - 桌面：mouseenter / 键盘 focus 显示大图预览，离开即消失
 * - 手机：长按（LONG_PRESS_MS）显示预览；移动手指、松手即消失；
 *   长按预览后松开不会误触发表情插入（短按 tap 才插入）
 */
function StickerItem({ url, desc, shortcode, onPick, onPreview, onPreviewEnd }: {
  url: string
  desc: string
  shortcode: string
  onPick: (code: string) => void
  onPreview: (target: PreviewTarget) => void
  onPreviewEnd: () => void
}) {
  const pressTimer = React.useRef<number | null>(null)
  const longPressed = React.useRef(false)
  // 触摸会话期间抑制合成 mouseenter（触屏设备在 touchend 后会补发 hover 事件）
  const touchSession = React.useRef(false)

  const clearTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  const show = (el: HTMLElement) => onPreview({ el, url, desc })
  const endTouchSession = () => {
    window.setTimeout(() => { touchSession.current = false }, 600)
  }

  return (
    <button
      type="button"
      className="sticker-item"
      draggable={false}
      onMouseEnter={(e) => { if (!touchSession.current) show(e.currentTarget) }}
      onMouseLeave={onPreviewEnd}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={onPreviewEnd}
      onTouchStart={(e) => {
        touchSession.current = true
        longPressed.current = false
        clearTimer()
        const el = e.currentTarget
        pressTimer.current = window.setTimeout(() => {
          longPressed.current = true
          try { navigator.vibrate?.(15) } catch { /* 不支持振动时忽略 */ }
          show(el)
        }, LONG_PRESS_MS)
      }}
      onTouchMove={() => { clearTimer(); onPreviewEnd() }}
      onTouchEnd={() => { clearTimer(); onPreviewEnd(); endTouchSession() }}
      onTouchCancel={() => { clearTimer(); onPreviewEnd(); endTouchSession() }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        // 长按预览后的松手 click 不算插入
        if (longPressed.current) {
          longPressed.current = false
          e.preventDefault()
          return
        }
        onPick(shortcode)
      }}
    >
      <img src={url} alt={desc} loading="lazy" draggable={false} />
      <span className="sticker-desc">{desc}</span>
    </button>
  )
}

/**
 * 大图预览浮层：Portal 到 body，fixed 定位在表情项上方（空间不足翻到下方），
 * 水平对齐表情项中心并钳制在视口内；pointer-events:none 保证不遮挡鼠标/手指，
 * 且不会干扰元素自身的 mouseenter/mouseleave。
 */
function StickerPreview({ target }: { target: PreviewTarget }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const anchor = target.el
      if (!anchor.isConnected) return
      const r = anchor.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const gap = 10
      const edge = 8
      // 锚点已完全滚出视口时不展示
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return
      const h = el.offsetHeight
      const w = el.offsetWidth
      const spaceAbove = r.top - gap
      const spaceBelow = vh - r.bottom - gap
      // 优先上方（不遮挡鼠标/手指）；上方放不下时选空间更大的一侧
      const above = spaceAbove >= h || spaceAbove >= spaceBelow
      let left = r.left + r.width / 2 - w / 2
      left = Math.max(edge, Math.min(left, vw - w - edge))
      const top = above
        ? Math.max(edge, r.top - gap - h)
        : Math.min(vh - h - edge, r.bottom + gap)
      setPos({ left, top })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [target])

  return createPortal(
    <div
      ref={ref}
      className="sticker-preview"
      role="tooltip"
      aria-hidden="true"
      style={pos
        ? { left: pos.left, top: pos.top }
        : { left: -9999, top: -9999, visibility: 'hidden' as const }}
    >
      <img src={target.url} alt="" draggable={false} />
      <span>{target.desc}</span>
    </div>,
    document.body,
  )
}

/** 触发按钮 + 弹出面板的 wrapper，共享逻辑 */
export function StickerTrigger({ onInsert }: { onInsert: (shortcode: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const wrapRef = React.useRef<HTMLDivElement>(null)

  // 外点关闭（pointerdown 同时覆盖鼠标与触屏）；Escape 关闭
  React.useEffect(() => {
    if (!open) return
    const pointer = (e: PointerEvent) => {
      const target = e.target as Element
      if (wrapRef.current?.contains(target)) return
      if (target.closest?.('.sticker-picker')) return
      setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', pointer)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div className="sticker-trigger-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className={`sticker-trigger-btn${open ? ' active' : ''}`}
        title="插入表情包"
        onClick={() => setOpen((v) => !v)}
        aria-label="插入表情包"
        aria-expanded={open}
      >
        <SmileyIcon />
      </button>
      {open && (
        <StickerPicker
          anchor={btnRef.current}
          onSelect={(code) => { onInsert(code); setOpen(false) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function SmileyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  )
}

function StarIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z" />
    </svg>
  )
}
