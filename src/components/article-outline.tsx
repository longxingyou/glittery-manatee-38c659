import { ListTree, X } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useT } from '@/lib/i18n'

export interface OutlineHeading {
  id: string
  text: string
  level: number
}

/** ≥1410px 时大纲停靠为文章右侧粘性侧栏（占布局空间）；否则为底部抽屉 */
const DOCK_QUERY = '(min-width: 1410px)'

/** 提取标题纯文本（剔除尾部 # 锚点图标） */
function headingText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelector('.anchor')?.remove()
  return (clone.textContent || '').trim()
}

/**
 * Obsidian 风格文章大纲索引：
 * 右下角浮动按钮 → 宽屏停靠右侧粘性侧栏（阅读时常驻、scroll-spy 高亮、
 * 平滑跳转），窄屏为底部玻璃抽屉（选中后自动收起）。
 * 收起：Esc / 点击抽屉外 / 再点按钮。仅在文章 ≥2 个标题时渲染。
 * 实际滚动容器可能是 window 或某个内层容器（每次计算时探测），二者通吃。
 */
export function ArticleOutline({ containerRef, slug }: {
  containerRef: RefObject<HTMLDivElement | null>
  slug: string
}) {
  const t = useT()
  const [headings, setHeadings] = useState<OutlineHeading[]>([])
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState('')
  const [docked, setDocked] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 提取 h2-h4（renderMarkdown 同步注入，mount 后 DOM 已就绪；slug 变化时重提取）
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const els = Array.from(root.querySelectorAll<HTMLElement>('h2[id], h3[id], h4[id]'))
    setHeadings(els.map((el) => ({ id: el.id, text: headingText(el), level: Number(el.tagName[1]) })))
    setActiveId('')
  }, [containerRef, slug])

  // 停靠模式跟随视口（CSS 断点一致）
  useEffect(() => {
    const mq = window.matchMedia(DOCK_QUERY)
    const onChange = () => setDocked(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // scroll-spy（rAF 节流）：document 捕获监听全部滚动（window 与内层容器通吃），
  // 打开面板时顺带对齐一次。高亮基准线取视口顶部 +88px。
  useEffect(() => {
    let raf = 0
    const compute = () => {
      raf = 0
      const root = containerRef.current
      if (!root) return
      const els = Array.from(root.querySelectorAll<HTMLElement>('h2[id], h3[id], h4[id]'))
      if (!els.length) { setActiveId(''); return }
      // 探测真实滚动容器：文章页布局下 .article-scroll 有 overflow:auto 却从不滚动，
      // 实际滚动发生在 window；若某祖先容器确有溢出则优先采用
      let scroller: HTMLElement | null = null
      let node: HTMLElement | null = root
      while (node && node !== document.body) {
        const oy = getComputedStyle(node).overflowY
        if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 4) { scroller = node; break }
        node = node.parentElement
      }
      const line = (scroller ? scroller.getBoundingClientRect().top : 0) + 88
      // 阅读位置在首个标题之上时高亮第一个标题（刚进入文章不高亮后面的标题）
      let current = els[0].id
      for (const el of els) {
        if (el.getBoundingClientRect().top <= line) current = el.id
      }
      const doc = document.documentElement
      const atBottom = scroller
        ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
        : doc.scrollHeight > window.innerHeight + 4 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2
      if (atBottom) current = els[els.length - 1].id
      setActiveId(current)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(compute) }
    compute()
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      if (raf) cancelAnimationFrame(raf)
    }
  }, [containerRef, slug, open])

  // 面板内把当前高亮项滚到可见（手动 scrollTop，避免 scrollIntoView 波及外层）
  useEffect(() => {
    if (!open || !activeId) return
    const list = listRef.current
    const btn = list?.querySelector<HTMLButtonElement>(`button[data-id="${CSS.escape(activeId)}"]`)
    if (!list || !btn) return
    const top = btn.offsetTop
    if (top < list.scrollTop + 8) list.scrollTop = top - 8
    else if (top + btn.offsetHeight > list.scrollTop + list.clientHeight - 8) {
      list.scrollTop = top + btn.offsetHeight - list.clientHeight + 8
    }
  }, [activeId, open])

  // 快速收起：Esc 通用；点击外部仅对浮层抽屉生效（停靠侧栏阅读时保持常驻）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: PointerEvent) => {
      if (docked) return
      const target = e.target as Node
      if (!panelRef.current?.contains(target) && !btnRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, docked])

  if (headings.length < 2) return null

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // 抽屉模式选中即收起；停靠侧栏保持常驻以继续跟踪阅读位置
    if (!docked) setOpen(false)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="outline-fab"
        title={t('article.outline.open')}
        aria-label={t('article.outline.open')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ListTree size={17} />
      </button>
      {open && (
        <aside ref={panelRef} className="outline-panel" aria-label={t('article.outline.open')}>
          <div className="outline-head">
            <span className="outline-title">{t('article.outline')}</span>
            <button
              type="button"
              className="outline-close"
              title={t('article.outline.close')}
              aria-label={t('article.outline.close')}
              onClick={() => setOpen(false)}
            >
              <X size={13} />
            </button>
          </div>
          <div className="outline-list" ref={listRef}>
            {headings.map((h) => (
              <button
                key={h.id}
                type="button"
                data-id={h.id}
                className={`outline-item lv${h.level}${h.id === activeId ? ' active' : ''}`}
                onClick={() => jump(h.id)}
              >
                {h.text || '…'}
              </button>
            ))}
          </div>
        </aside>
      )}
    </>
  )
}
