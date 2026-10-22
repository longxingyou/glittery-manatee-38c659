import { ListTree, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useT } from '@/lib/i18n'

export interface OutlineHeading {
  id: string
  text: string
  level: number
}

/** ≥1410px 时大纲停靠为右侧粘性侧栏（占布局空间）；否则为底部玻璃抽屉 */
const DOCK_QUERY = '(min-width: 1410px)'

/** 提取标题纯文本（剔除 renderMarkdown 追加的尾部 # 锚点图标） */
function headingText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelector('.anchor')?.remove()
  return (clone.textContent || '').trim()
}

/**
 * Obsidian 风格文档大纲索引（文章页与课程精讲共用同一套实现）：
 * 右下角浮动按钮 → ≥1410px 停靠为右侧粘性侧栏（阅读时常驻、scroll-spy 高亮、
 * 平滑跳转），窄屏为底部玻璃抽屉（选中后自动收起）。
 * 收起：Esc / 点击抽屉外 / 再点按钮。仅在 ≥2 个标题时渲染。
 * 实际滚动容器可能是 window 或某个内层容器（每次计算时向上探测），二者通吃。
 *
 * 标题层级由 minLevel/maxLevel 参数化：文章页正文标题是 h2–h4；课程精讲的
 * 内容是 renderMarkdown(src, 1) 渲染的（整体下移一级，实际落在 h3–h5）。
 * 两处 DOM 结构与滚动逻辑完全一致，因此共用一个组件而非各写一份。
 * 渲染用的 CSS 层级恒按「本文件中最浅出现的标题 = lv2」归一化后再取
 * .outline-item.lv2/3/4，所以层级基准不同也不会串味。
 * 文案 key 同样可注入，让同一组件在文章页显示「大纲」、在课程精讲显示「本课小节」。
 *
 * SSR 直出：initialHeadings 由服务端从 markdown 产物提取时，按钮进入首屏 HTML，
 * 弱网下水合延迟/失败时按钮依然可见；水合后以 DOM 提取结果为准。
 */
export function ArticleOutline({
  containerRef,
  docId,
  initialHeadings,
  minLevel = 2,
  maxLevel = 4,
  titleKey = 'article.outline',
  openKey = 'article.outline.open',
  closeKey = 'article.outline.close',
}: {
  containerRef: RefObject<HTMLDivElement | null>
  /** 文档标识：变化时重新提取标题（文章传 slug，课程精讲传课程 id） */
  docId: string
  initialHeadings?: OutlineHeading[]
  /** 纳入大纲的最浅标题层级（渲染后的 h 编号，含端点） */
  minLevel?: number
  /** 纳入大纲的最深标题层级（渲染后的 h 编号，含端点） */
  maxLevel?: number
  /** 标题 / 打开 / 收起 三个文案 key */
  titleKey?: string
  openKey?: string
  closeKey?: string
}) {
  const t = useT()
  const [headings, setHeadings] = useState<OutlineHeading[]>(initialHeadings ?? [])
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState('')
  const [docked, setDocked] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 提取标题的 CSS 选择器（只认带 id 的，renderMarkdown 会为每个标题都生成 id）
  const selector = useMemo(() => {
    const lo = Math.min(minLevel, maxLevel)
    const hi = Math.max(minLevel, maxLevel)
    return Array.from({ length: hi - lo + 1 }, (_unused, i) => `h${lo + i}[id]`).join(', ')
  }, [minLevel, maxLevel])

  // 提取标题（renderMarkdown 同步注入，mount 后 DOM 已就绪；docId 变化时重提取）。
  // 自愈：首次提取不足 2 个标题时监听 DOM 变化补提取（内容偶发延迟挂载），
  // 凑齐 ≥2 个后停止观察；本身标题就少的文档随组件卸载一并清理。
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const extract = (): OutlineHeading[] =>
      Array.from(root.querySelectorAll<HTMLElement>(selector))
        .map((el) => ({ id: el.id, text: headingText(el), level: Number(el.tagName[1]) }))
    const same = (a: OutlineHeading[], b: OutlineHeading[]) =>
      a.length === b.length && a.every((h, i) => h.id === b[i].id && h.text === b[i].text && h.level === b[i].level)

    const first = extract()
    setHeadings((prev) => (same(prev, first) ? prev : first))
    setActiveId('')
    if (first.length >= 2) return

    let raf = 0
    const mo = new MutationObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const next = extract()
        setHeadings((prev) => (same(prev, next) ? prev : next))
        if (next.length >= 2) mo.disconnect()
      })
    })
    mo.observe(root, { childList: true, subtree: true })
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf) }
  }, [containerRef, docId, selector])

  // 停靠模式跟随视口（与 CSS 断点保持一致）
  useEffect(() => {
    const mq = window.matchMedia(DOCK_QUERY)
    const onChange = () => setDocked(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // scroll-spy（rAF 节流）：document 捕获监听全部滚动（window 与内层容器通吃），
  // 打开面板时顺带对齐一次。高亮基准线取滚动容器顶部 +88px。
  useEffect(() => {
    let raf = 0
    const compute = () => {
      raf = 0
      const root = containerRef.current
      if (!root) return
      const els = Array.from(root.querySelectorAll<HTMLElement>(selector))
      if (!els.length) { setActiveId(''); return }
      // 探测真实滚动容器：文章页布局下 .article-scroll 有 overflow:auto 却从不滚动，
      // 实际滚动发生在 window；课程精讲的 .ru-les-body 在宽屏下确实内部滚动。
      // 从内容根节点向上找第一个「真的有溢出」的祖先即可两种情形通吃。
      let scroller: HTMLElement | null = null
      let node: HTMLElement | null = root
      while (node && node !== document.body) {
        const oy = getComputedStyle(node).overflowY
        if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 4) { scroller = node; break }
        node = node.parentElement
      }
      const line = (scroller ? scroller.getBoundingClientRect().top : 0) + 88
      // 阅读位置在首个标题之上时高亮第一个标题（刚进入正文不高亮后面的标题）
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
  }, [containerRef, docId, open, selector])

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

  // 层级归一化：本文件里最浅出现的标题渲染为 lv2（.outline-item.lv2/3/4 三级阶梯），
  // 更深的两级依次为 lv3 / lv4，更深的再截断到 lv4，避免出现没有样式的 lv5。
  const baseLevel = headings.reduce((m, h) => Math.min(m, h.level), headings[0].level)
  const lvOf = (level: number) => Math.min(4, Math.max(2, 2 + (level - baseLevel)))

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
        className="outline-fab no-print"
        title={t(openKey)}
        aria-label={t(openKey)}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ListTree size={17} />
      </button>
      {open && (
        <aside ref={panelRef} className="outline-panel no-print" aria-label={t(titleKey)}>
          <div className="outline-head">
            <span className="outline-title">{t(titleKey)}</span>
            <button
              type="button"
              className="outline-close"
              title={t(closeKey)}
              aria-label={t(closeKey)}
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
                className={`outline-item lv${lvOf(h.level)}${h.id === activeId ? ' active' : ''}`}
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