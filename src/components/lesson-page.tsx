import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, ChevronLeft, ListTree, Printer, RefreshCw, X } from 'lucide-react'
import { useT } from '../lib/i18n'
import { extractHeadingsFromHtml, renderMarkdown } from '../lib/markdown'
import type { OutlineHeading } from './article-outline'
import {
  GROUPS,
  LESSONS,
  LESSON_LAST_KEY,
  bookOfLesson,
  lessonNeighbors,
  type BookMeta,
  type LessonMeta,
} from '../lib/lessons'

// ──────────────────────────────────────────────
// 单课阅读页（/lessons/$lessonId）。
//
// 导航只留两条，避免「三个目录」：
// ① 顶部工具条：返回课程中心 + 书名；右侧固定放「课程与小节」（窄屏）与「打印」——
//    所有课都在同一位置，不再有右下角浮动大纲钮；
// ② 左侧栏（≥1000px 常驻）：上半「本册课程」，下半「本课小节」（滚动联动高亮）。
//    窄屏时整条左栏收进一个抽屉，一个按钮同时管选课与找小节。
//
// 重音渲染：U+0301 → <span class="stressed">（交给 CSS 绘制，理由同 stressNodes）。
// 只匹配「西里尔元音 + 组合锐音符」这一对，替换出的 $1 是元音本身，
// 因此不会误伤标签名/属性值，也无法注入任意 HTML。仅 russian 学科套用。
// ──────────────────────────────────────────────
const RU_STRESS_RE = /([АЕИОУЫЭЮЯаеиоуыэюяЁё])\u0301/g

function stressHtml(html: string): string {
  return html.replace(RU_STRESS_RE, '<span class="stressed">$1</span>')
}

// ──────────────────────────────────────────────
// 折叠完全交给渲染器：源 .md 用 Obsidian 的折叠标记
//     > [!success]- 答案要点
// renderMarkdown 会输出原生 <details class="callout">，
// 浏览器自带展开/收起与无障碍语义，无需任何 DOM 操作。
//
// 只有「打印」需要干预：<details> 未展开时内容不会被印出，
// 因此打印前把所有 details 置为 open（打印后还原成用户原本的展开状态）。
// ──────────────────────────────────────────────
function setAllDetails(root: HTMLElement | null, open: boolean, restore?: boolean[]) {
  if (!root) return restore
  const list = [...root.querySelectorAll<HTMLDetailsElement>('details.callout')]
  if (restore) {
    list.forEach((el, i) => { el.open = restore[i] ?? el.open })
    return undefined
  }
  const prev = list.map((el) => el.open)
  list.forEach((el) => { el.open = open })
  return prev
}

/** 正文用 renderMarkdown(src, 1) 渲染：整体下移一级，标题实际落在 h3–h5 */
const BODY_MIN_LEVEL = 3
const BODY_MAX_LEVEL = 5

/** 当前阅读位置所在小节（节流 rAF，document 捕获监听兼容各种滚动容器） */
function useActiveSection(headings: OutlineHeading[], docId: string): string {
  const [activeId, setActiveId] = React.useState('')
  React.useEffect(() => {
    let raf = 0
    const compute = () => {
      raf = 0
      if (!headings.length) { setActiveId(''); return }
      const line = 96
      let current = headings[0].id
      for (const h of headings) {
        const el = document.getElementById(h.id)
        if (el && el.getBoundingClientRect().top <= line) current = h.id
      }
      const doc = document.documentElement
      if (doc.scrollHeight > window.innerHeight + 4 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
        current = headings[headings.length - 1].id
      }
      setActiveId(current)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(compute) }
    compute()
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      if (raf) cancelAnimationFrame(raf)
    }
  }, [headings, docId])
  return activeId
}

export function LessonPage({ les, source }: { les: LessonMeta; source?: string }) {
  const t = useT()
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const [navOpen, setNavOpen] = React.useState(false)
  const book = bookOfLesson(les)
  const neighbors = lessonNeighbors(les)

  // 记住上次阅读：课程中心的「继续阅读」读这个 key
  React.useEffect(() => {
    try { localStorage.setItem(LESSON_LAST_KEY, les.id) } catch { /* 隐私模式等，忽略 */ }
  }, [les.id])

  const html = React.useMemo(
    // headingShift=1：与「语法手册」一致，正文从 h2 起步，避免与页面 h1 冲突
    () => {
      if (!source) return ''
      const rendered = renderMarkdown(source, 1)
      return book?.subject === 'russian' ? stressHtml(rendered) : rendered
    },
    [source, book?.subject],
  )

  // 大纲直接从渲染产物提取：服务端即可得，弱网下不必等水合
  const headings = React.useMemo(
    () => extractHeadingsFromHtml(html, BODY_MIN_LEVEL, BODY_MAX_LEVEL),
    [html],
  )
  const activeId = useActiveSection(headings, les.id)

  // 抽屉开着时 Esc 关闭
  React.useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  // 打印：临时展开所有折叠块，打完还原（否则 <details> 收起时内容不会被印出）
  //
  // 两条触发路径都要覆盖：
  // ① 页内「打印」按钮 → doPrint 显式展开，再调用 window.print()
  // ② 浏览器菜单 / Ctrl+P → 只发 beforeprint 事件，必须在这里展开，
  //    否则默认收起的「答案要点」不会被印出。
  // 展开做成幂等的（用 printingRef 去重），两条路径都走它，
  // 避免按钮触发时又被 beforeprint 记一次基线而还原错状态。
  const prevOpen = React.useRef<boolean[]>([])
  const printingRef = React.useRef(false)

  const expandForPrint = React.useCallback(() => {
    if (printingRef.current) return
    printingRef.current = true
    prevOpen.current = setAllDetails(bodyRef.current, true) ?? []
    document.body.classList.add('ru-mat-printing')
  }, [])

  const restoreAfterPrint = React.useCallback(() => {
    if (!printingRef.current) return
    printingRef.current = false
    setAllDetails(bodyRef.current, false, prevOpen.current)
    document.body.classList.remove('ru-mat-printing')
  }, [])

  React.useEffect(() => {
    window.addEventListener('beforeprint', expandForPrint)
    window.addEventListener('afterprint', restoreAfterPrint)
    return () => {
      window.removeEventListener('beforeprint', expandForPrint)
      window.removeEventListener('afterprint', restoreAfterPrint)
    }
  }, [expandForPrint, restoreAfterPrint])

  const doPrint = React.useCallback(() => {
    // 先自己展开（不依赖浏览器是否派发 beforeprint），再调 print()。
    // 展开幂等，所以即使随后 beforeprint 又触发也不会重复记录基线。
    expandForPrint()
    window.print()
  }, [expandForPrint])

  const jumpTo = React.useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setNavOpen(false)
  }, [])

  return (
    <div className="les-page ru-mat-print">
      {/* 顶部工具条：所有课都在同一位置，不再有第二处「目录 / 打印」入口 */}
      <div className="les-bar no-print">
        {/* 窄屏不出现书名入口：抽屉顶部已有书名，工具栏只留「课程中心 / 课程与小节 / 打印」三项 */}
        <Link to="/lessons" search={() => ({ book: les.book })} className="les-back">
          <ChevronLeft size={14} />
          {t('les.back')}
        </Link>
        {book && !book.reserved && (
          <Link to="/lessons" search={{ book: book.id }} className="les-bar-book">{book.title}</Link>
        )}
        <div className="les-bar-actions">
          <button type="button" className="les-bar-btn les-nav-btn" onClick={() => setNavOpen(true)}>
            <ListTree size={14} />
            {t('les.nav.open')}
          </button>
          <button type="button" className="les-bar-btn" onClick={doPrint}>
            <Printer size={14} />
            {t('ru.mat.print')}
          </button>
        </div>
      </div>

      <div className="les-layout">
        {/* 左栏：本册课程 + 本课小节（窄屏由 CSS 隐藏，改走抽屉） */}
        <aside className="les-rail no-print">
          <LessonNav les={les} book={book} headings={headings} activeId={activeId} onJump={jumpTo} variant="rail" />
        </aside>

        <div className="les-main">
          <header className="les-lesson-head">
            <h1>{les.title}</h1>
            <p>{les.hint}</p>
          </header>

          {!source && (
            /* data-lesson-missing：worker 见到这个标记就不再写 HTML 缓存，
               否则一次瞬时加载失败会被锁在边缘/KV 里一小时（见 worker.ts） */
            <div className="les-missing" data-lesson-missing="1">
              <p>{t('ru.mat.missing')}</p>
              <button type="button" className="les-bar-btn" onClick={() => window.location.reload()}>
                <RefreshCw size={14} />
                {t('les.reload')}
              </button>
            </div>
          )}
          {source && (
            <div
              ref={bodyRef}
              className="markdown-body compact ru-les-body"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {/* 上一课 / 下一课（同册书内按 LESSONS 顺序） */}
          <nav className="les-prevnext no-print">
            {neighbors.prev ? (
              <Link to="/lessons/$lessonId" params={{ lessonId: neighbors.prev.id }} className="les-pn prev" aria-label={t('les.prev')}>
                <ArrowLeft size={14} />
                <span className="les-pn-title">{neighbors.prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {neighbors.next ? (
              <Link to="/lessons/$lessonId" params={{ lessonId: neighbors.next.id }} className="les-pn next" aria-label={t('les.next')}>
                <span className="les-pn-title">{neighbors.next.title}</span>
                <ArrowRight size={14} />
              </Link>
            ) : (
              <span />
            )}
          </nav>
        </div>
      </div>

      {/* 窄屏：一个抽屉同时管选课与找小节 */}
      {navOpen && (
        <div className="les-sheet-mask no-print" onClick={() => setNavOpen(false)}>
          <div className="les-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="les-sheet-head">
              <strong>{book && !book.reserved ? book.title : t('ru.les.books')}</strong>
              <button type="button" aria-label={t('les.nav.close')} onClick={() => setNavOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="les-sheet-body">
              <LessonNav
                les={les}
                book={book}
                headings={headings}
                activeId={activeId}
                onJump={jumpTo}
                variant="sheet"
                onNavigate={() => setNavOpen(false)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 选课 + 找小节。两种形态：
 *
 * · rail（≥1000px 左栏）：两段上下堆叠、课程行单行紧凑——左栏宽度固定 232px，
 *   用户是在「浏览整册书」而不是在狭窄抽屉里翻找。
 * · sheet（窄屏抽屉）：两段用顶部切换分开（本课小节 / 本册课程），课程行补一行
 *   说明文字。抽屉里同时摊开「课」和「节」两串列表正是上一版选书界面的毛病：
 *   几十行长得一样的文字挤在一起，分不清点哪个会换课、点哪个只是滚动。
 */
function LessonNav({
  les,
  book,
  headings,
  activeId,
  onJump,
  variant = 'rail',
  onNavigate,
}: {
  les: LessonMeta
  book?: BookMeta
  headings: OutlineHeading[]
  activeId: string
  onJump: (id: string) => void
  variant?: 'rail' | 'sheet'
  /** 抽屉里点课之后要收起抽屉（路由切换不会卸载本页，状态会留着） */
  onNavigate?: () => void
}) {
  const t = useT()
  const items = LESSONS.filter((m) => m.book === les.book)
  const hasSections = headings.length >= 2
  // 抽屉每次打开都是新实例，默认落在「本课小节」：用户点「课程与小节」多半
  // 是为了在当前这课里跳段；要换课再切一下，代价比误触换课小。
  const [tab, setTab] = React.useState<'sections' | 'lessons'>('sections')

  // 层级归一化：本课最浅出现的标题渲染为 lv2，更深依次 lv3 / lv4
  const baseLevel = headings.length
    ? headings.reduce((m, h) => Math.min(m, h.level), headings[0].level)
    : 0
  const lvOf = (level: number) => Math.min(4, Math.max(2, 2 + (level - baseLevel)))

  /** rich=true 时课程行显示两行（标题 + 说明），用于抽屉 */
  const renderLessons = (rich: boolean) => (
    <nav className="les-nav-list" aria-label={t('les.rail.book')}>
      {GROUPS.map((g) => {
        const rows = items.filter((m) => m.group === g.id)
        if (rows.length === 0) return null
        return (
          <React.Fragment key={g.id}>
            <div className="les-nav-sublabel">{t(g.key)}</div>
            {rows.map((m) => (
              <Link
                key={m.id}
                to="/lessons/$lessonId"
                params={{ lessonId: m.id }}
                className={`les-nav-item${rich ? ' rich' : ''}${m.id === les.id ? ' active' : ''}`}
                onClick={rich ? onNavigate : undefined}
              >
                <span className="les-nav-item-t">{m.title}</span>
                {rich && <span className="les-nav-item-h">{m.hint}</span>}
              </Link>
            ))}
          </React.Fragment>
        )
      })}
    </nav>
  )

  const renderSections = () => (
    <div className="les-nav-list">
      {headings.map((h) => (
        <button
          key={h.id}
          type="button"
          className={`les-nav-sec lv${lvOf(h.level)}${h.id === activeId ? ' active' : ''}`}
          aria-current={h.id === activeId ? 'true' : undefined}
          onClick={() => onJump(h.id)}
        >
          {h.text || '…'}
        </button>
      ))}
    </div>
  )

  if (variant === 'sheet') {
    // 没有小节（总表类条目）时不显示切换，直接给课程列表
    if (!hasSections) {
      return (
        <div className="les-nav">
          <div className="les-nav-head">
            <span className="les-nav-label">{t('les.rail.book')}</span>
            <span className="les-nav-count">{items.length}</span>
          </div>
          {renderLessons(true)}
        </div>
      )
    }
    return (
      <div className="les-nav">
        <div className="les-nav-tabs" role="tablist" aria-label={t('les.nav.open')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sections'}
            className="les-nav-tab"
            onClick={() => setTab('sections')}
          >
            {t('les.rail.sections')}
            <span className="les-nav-count">{headings.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'lessons'}
            className="les-nav-tab"
            onClick={() => setTab('lessons')}
          >
            {t('les.rail.book')}
            <span className="les-nav-count">{items.length}</span>
          </button>
        </div>
        {tab === 'sections' ? renderSections() : renderLessons(true)}
      </div>
    )
  }

  return (
    <div className="les-nav">
      <div className="les-nav-block">
        <div className="les-nav-head">
          <span className="les-nav-label">{book && !book.reserved ? book.title : t('les.rail.book')}</span>
          <span className="les-nav-count">{items.length}</span>
        </div>
        {renderLessons(false)}
      </div>

      {hasSections && (
        <div className="les-nav-block">
          <div className="les-nav-head">
            <span className="les-nav-label">{t('les.rail.sections')}</span>
            <span className="les-nav-count">{headings.length}</span>
          </div>
          {renderSections()}
        </div>
      )}
    </div>
  )
}

export default LessonPage
