import * as React from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowRight, ChevronRight } from 'lucide-react'
import { useT } from '../lib/i18n'
import { BOOKS, GROUPS, LESSONS, LESSON_LAST_KEY, type BookMeta } from '../lib/lessons'

// ──────────────────────────────────────────────
// 课程中心（/lessons）：左「教材」右「课程」。
// 选中的教材记在 URL（?book=），刷新 / 分享都保留。
// 多学科时左栏按学科分组（只有一个学科时不渲染分组标题，避免多余信息）；
// 教材再多，左栏也只是一列可滚动的行，不会把页面越铺越长。
// 移动端左栏收成一行原生下拉（optgroup 直接给出学科分组），下面是课程列表。
// ──────────────────────────────────────────────
export function LessonsIndex() {
  const t = useT()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { book?: string }

  // 可点教材（有内容的），以及「上次阅读」目标（与阅读页共用同一个 key）
  const realBooks = React.useMemo(() => BOOKS.filter((b) => !b.reserved && LESSONS.some((m) => m.book === b.id)), [])
  const lastId = React.useMemo(() => {
    try {
      const v = localStorage.getItem(LESSON_LAST_KEY)
      if (v && LESSONS.some((m) => m.id === v)) return v
    } catch { /* 隐私模式等，忽略 */ }
    return null
  }, [])

  // URL 里的书无效（手改、已下架）时回落到第一册，避免空页面
  const activeBook = realBooks.find((b) => b.id === search.book) ?? realBooks[0]

  // 顶层只分「俄语 / 杂项」；lib 的学科差异写在教材条目里，不再单开分区。
  const bookDomain = (b: BookMeta) => (b.subject === 'russian' ? 'russian' : 'misc')
  const domains = ['russian', 'misc'] as const
  const domainLabel = (d: string) => t(`les.subject.${d}`)

  return (
    <div className="les-hub">
      <header className="les-hub-head">
        <h1>{t('les.index.title')}</h1>
        <p>{t('les.index.sub')}</p>
      </header>

      <div className="les-hub-grid">
        <aside className="les-books">
          {/* 移动端：一行原生下拉，教材再多也不用往下翻 */}
          <select
            className="les-book-select"
            aria-label={t('ru.les.books')}
            value={activeBook?.id ?? ''}
            onChange={(e) => navigate({ to: '/lessons', search: { book: e.target.value } })}
          >
            {domains.map((d) => (
              <optgroup key={d} label={domainLabel(d)}>
                {BOOKS.filter((b) => bookDomain(b) === d).map((b) => (
                  <option key={b.id} value={b.id} disabled={b.reserved}>
                    {b.title || t('ru.les.slot')}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {/* 宽屏：一列教材 */}
          <nav className="les-book-list" aria-label={t('ru.les.books')}>
            {domains.map((d) => (
              <React.Fragment key={d}>
                <div className="les-books-sub">{domainLabel(d)}</div>
                {BOOKS.filter((b) => bookDomain(b) === d).map((b) => (
                  <BookRow key={b.id} book={b} active={b.id === activeBook?.id} />
                ))}
              </React.Fragment>
            ))}
          </nav>
        </aside>

        {activeBook && (
          <section className="les-catalog">
            <CatalogHeader book={activeBook} lastId={lastId} />
            {GROUPS.map((g) => {
              const rows = LESSONS.filter((m) => m.book === activeBook.id && m.group === g.id)
              if (rows.length === 0) return null
              return (
                <div className="les-cat-group" key={g.id}>
                  <div className="les-group-label">{t(g.key)}</div>
                  {rows.map((m) => (
                    <Link
                      key={m.id}
                      to="/lessons/$lessonId"
                      params={{ lessonId: m.id }}
                      className="les-row"
                    >
                      <span className="les-row-main">
                        <span className="les-row-title">{m.title}</span>
                        <span className="les-row-hint">{m.hint}</span>
                      </span>
                      <ChevronRight size={14} className="les-row-chev" />
                    </Link>
                  ))}
                </div>
              )
            })}
          </section>
        )}
      </div>
    </div>
  )
}

function BookRow({ book, active }: { book: BookMeta; active: boolean }) {
  const t = useT()
  const count = LESSONS.filter((m) => m.book === book.id).length
  const reserved = Boolean(book.reserved) || count === 0

  if (reserved) {
    return (
      <div className="les-book-row reserved" title={book.hint || t('ru.les.slot.note')}>
        <span className="les-book-row-title">{book.title || t('ru.les.slot')}</span>
      </div>
    )
  }

  return (
    <Link
      to="/lessons"
      search={{ book: book.id }}
      className={`les-book-row${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="les-book-row-title">{book.title}</span>
      <span className="les-book-row-meta">{book.hint}</span>
    </Link>
  )
}

function CatalogHeader({ book, lastId }: { book: BookMeta; lastId: string | null }) {
  const t = useT()
  const items = LESSONS.filter((m) => m.book === book.id)
  const resume = lastId && items.some((m) => m.id === lastId) ? lastId : items[0]?.id
  const resumeKey = lastId && items.some((m) => m.id === lastId) ? 'les.continue' : 'les.start'

  return (
    <header className="les-cat-head">
      <div className="les-cat-head-text">
        <h2>{book.title}</h2>
        <p>
          {book.hint}
          <span className="les-dot">·</span>
          {t('les.book.count', { count: items.length })}
        </p>
      </div>
      {resume && (
        <Link to="/lessons/$lessonId" params={{ lessonId: resume }} className="les-primary">
          {t(resumeKey)}
          <ArrowRight size={14} />
        </Link>
      )}
    </header>
  )
}

export default LessonsIndex
