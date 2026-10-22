import React from 'react'
import { extractHeadingsFromHtml, renderMarkdown } from '../lib/markdown'
import { useT } from '../lib/i18n'
import { ArticleOutline } from './article-outline'

// ──────────────────────────────────────────────
// 课程精讲：内容源在 content/russian-lessons/（.md）。
// 构建期内联为字符串（?raw），编辑内容后重新构建即同步，运行时零网络请求。
//
// 结构分两层：**教材（BOOKS）→ 条目（LESSONS）**。
// 条目分两类：逐课精讲（lesson，每课覆盖课堂指令语、核心句型、关键语法、
// 特例、易混辨析、单词表、自测清单）与全局条目（global，总表 / 词表）。
// 同一系列还会有后续教材，BOOKS 里为它们留了可见的预留位（reserved），
// 因此这里是「系列书架」而不是某一册书的硬编码清单：
//   · 加一个新系列/新一册：BOOKS 里把某个 reserved 条目改写为真实条目；
//   · 加该册的内容：LESSONS 里追加条目，book 填对应 id。
// 渲染逻辑按 book + group 自动分组，不需要改动。
//
// 重音：.md 源码保留组合锐音符 U+0301 —— renderMarkdown 不处理重音，
// 渲染后由 stressHtml() 把「元音+U+0301」转成 <span class="stressed">，
// 交给 CSS 绘制（与词汇点读 / 附件预览页同一方案）。
// ──────────────────────────────────────────────
const mdModules = import.meta.glob('../../content/russian-lessons/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const fileContents = new Map<string, string>()
for (const [path, content] of Object.entries(mdModules)) {
  fileContents.set(path.split('/').pop() || path, content)
}

/** 一册教材（或一个系列）。reserved=true 表示预留位，尚无内容。 */
interface BookMeta {
  id: string
  /** 展示名（reserved 条目留空，渲染时用 i18n 的「预留位」文案） */
  title: string
  /** 册别说明，例如 Элементарный уровень · Урок 1–12 */
  hint: string
  reserved?: boolean
}

interface LessonMeta {
  id: string
  file: string
  title: string
  hint: string
  group: 'lesson' | 'global'
  /** 所属教材 id（对应 BOOKS 中的一项） */
  book: string
}

const BOOKS: BookMeta[] = [
  { id: 'p-russia', title: '《Привет, Россия!》', hint: 'Элементарный уровень · Урок 1–12' },
  // ── 同系列后续教材的预留位 ──
  // 整理新书时：把 reserved 去掉、填上 title/hint，再在下面 LESSONS 里追加条目
  // （book 填该 id）。预留位在页面上可见，接入时无需改动任何渲染代码。
  { id: 'slot-a', title: '', hint: '', reserved: true },
  { id: 'slot-b', title: '', hint: '', reserved: true },
]

const LESSONS: LessonMeta[] = [
  { id: 'overview', file: '00-overview.md', title: '全局总表', hint: '课堂指令语 · 疑问词系统 · 化学与数学词表', group: 'global', book: 'p-russia' },
  { id: 'l1', file: '01-urok-1.md', title: 'Урок 1', hint: 'Здра́вствуйте — 问候 · 自我介绍 · 语调', group: 'lesson', book: 'p-russia' },
  { id: 'l2', file: '02-urok-2.md', title: 'Урок 2', hint: 'Все профе́ссии ну́жны — 职业 · 谁/什么', group: 'lesson', book: 'p-russia' },
  { id: 'l3', file: '03-urok-3.md', title: 'Урок 3', hint: 'Мой день — 一天作息 · 变位法 · 时间', group: 'lesson', book: 'p-russia' },
  { id: 'l4', file: '04-urok-4.md', title: 'Урок 4', hint: 'Моя́ жизнь — 居住 · мочь/уме́ть · 四季', group: 'lesson', book: 'p-russia' },
  { id: 'l5', file: '05-urok-5.md', title: 'Урок 5', hint: 'Мои́ интере́сы — 爱好 · изуча́ть · 食物', group: 'lesson', book: 'p-russia' },
  { id: 'l6', file: '06-urok-6.md', title: 'Урок 6', hint: 'На вкус и цвет — 形容词 · 颜色 · 性数一致', group: 'lesson', book: 'p-russia' },
  { id: 'l7', file: '07-urok-7.md', title: 'Урок 7', hint: 'Мы е́дем — идти́/е́хать · куда́/где · 交通', group: 'lesson', book: 'p-russia' },
  { id: 'l8', file: '08-urok-8.md', title: 'Урок 8', hint: 'Весь мир онла́йн — 过去时 · 时间 · 序数词', group: 'lesson', book: 'p-russia' },
  { id: 'l9', file: '09-urok-9.md', title: 'Урок 9', hint: 'Добро́ пожа́ловать — 第二格 · у кого́ есть', group: 'lesson', book: 'p-russia' },
  { id: 'l10', file: '10-urok-10.md', title: 'Урок 10', hint: 'Сде́лал де́ло — 动词的体 НСВ/СВ · 天气', group: 'lesson', book: 'p-russia' },
  { id: 'l11', file: '11-urok-11.md', title: 'Урок 11', hint: 'Семья́ — э́то семь «Я» — 将来时 · 第五格', group: 'lesson', book: 'p-russia' },
  { id: 'l12', file: '12-urok-12.md', title: 'Урок 12', hint: 'Мы жела́ем сча́стья вам — 第三格 · 六个格', group: 'lesson', book: 'p-russia' },
  { id: 'pos', file: '13-words-by-pos.md', title: '词表 · 按词型', hint: '1,340 词按名词/动词/形容词等 10 类', group: 'global', book: 'p-russia' },
  { id: 'theme', file: '14-words-by-theme.md', title: '词表 · 按主题', hint: '同 1,340 词按 20 个主题归集', group: 'global', book: 'p-russia' },
]

/** 条目分组的展示顺序与文案 key（新增书目沿用同一套分组） */
const GROUPS = [
  { id: 'lesson', key: 'ru.les.group.lesson' },
  { id: 'global', key: 'ru.les.group.global' },
] as const

// ──────────────────────────────────────────────
// 重音渲染：U+0301 → <span class="stressed">（交给 CSS 绘制，理由同 stressNodes）。
// 只匹配「西里尔元音 + 组合锐音符」这一对，替换出的 $1 是元音本身，
// 因此不会误伤标签名/属性值，也无法注入任意 HTML。
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

// ──────────────────────────────────────────────
// 课程精讲标签页
// ──────────────────────────────────────────────
const LAST_KEY = 'dsh.ru.lessons.last'

/** 正文用 renderMarkdown(src, 1) 渲染：整体下移一级，标题实际落在 h3–h5 */
const BODY_MIN_LEVEL = 3
const BODY_MAX_LEVEL = 5

export function LessonsTab() {
  const t = useT()
  // 记住上次看的课：从别处回到这个标签页时不必重新定位
  const [sel, setSel] = React.useState(() => {
    try {
      const v = localStorage.getItem(LAST_KEY)
      if (v && LESSONS.some((m) => m.id === v)) return v
    } catch { /* 隐私模式等，忽略 */ }
    return 'l1'
  })
  const bodyRef = React.useRef<HTMLDivElement>(null)

  const les = LESSONS.find((m) => m.id === sel) ?? LESSONS[0]
  const source = fileContents.get(les.file)

  const pick = React.useCallback((id: string) => {
    setSel(id)
    try { localStorage.setItem(LAST_KEY, id) } catch { /* ignore */ }
  }, [])

  const html = React.useMemo(
    // headingShift=1：与「语法手册」一致，正文从 h2 起步，避免与页面 h1 冲突
    () => (source ? stressHtml(renderMarkdown(source, 1)) : ''),
    [source],
  )

  // 首屏（SSR/首次水合前）即可用的大纲：从渲染好的 HTML 字符串里提取，
  // 与水合后的 DOM 提取同口径，避免弱网下大纲按钮要等水合才出现。
  const initialHeadings = React.useMemo(
    () => extractHeadingsFromHtml(html, BODY_MIN_LEVEL, BODY_MAX_LEVEL),
    [html],
  )

  // 切换课程后把正文滚动容器归位，否则会停在上一课的中段。
  // 正文在手机上不再内部滚动，但宽屏 / 打印等情形仍可能是内部容器，故两者都复位。
  React.useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [html])

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

  return (
    <div className="ru-mat-print">
      {/* 教材选择：每册书一段，段内按「逐课精讲 / 全局」分组横向滑动。
          预留位可见但不可点（尚无内容），提示后续同系列书目将在此接入。 */}
      <nav className="ru-mat-nav no-print" aria-label={t('ru.les.books')}>
        {BOOKS.map((b) => {
          const items = LESSONS.filter((m) => m.book === b.id)
          const reserved = Boolean(b.reserved) || items.length === 0
          return (
            <div className="ru-les-book" key={b.id}>
              <div className="ru-les-book-head">
                <span className="ru-les-book-name">{reserved ? t('ru.les.slot') : b.title}</span>
                {!reserved && b.hint && <span className="ru-les-book-hint">{b.hint}</span>}
              </div>
              {reserved ? (
                <p className="ru-les-slot-note">{t('ru.les.slot.note')}</p>
              ) : (
                GROUPS.map((g) => {
                  const rows = items.filter((m) => m.group === g.id)
                  if (rows.length === 0) return null
                  return (
                    <div className="ru-mat-row" key={g.id}>
                      <span className="ru-mat-label">{t(g.key)}</span>
                      {rows.map((m) => (
                        <button
                          type="button"
                          key={m.id}
                          className={`ru-mat-chip${m.id === sel ? ' active' : ''}`}
                          onClick={() => pick(m.id)}
                          title={m.hint}
                        >
                          {m.title}
                        </button>
                      ))}
                    </div>
                  )
                })
              )}
            </div>
          )
        })}
      </nav>

      {/* 当前课程头部 */}
      <div className="ru-mat-head">
        <div style={{ minWidth: 0 }}>
          <div className="ru-mat-title">{les.title}</div>
          <div className="ru-mat-hint">{les.hint}</div>
        </div>
        <div className="ru-mat-actions no-print">
          <button type="button" className="ru-mat-btn" onClick={doPrint}>
            {t('ru.mat.print')}
          </button>
        </div>
      </div>

      {/* 内容区：正文。小节导航交给 ArticleOutline（右下角大纲钮 / 宽屏停靠侧栏 /
          窄屏底部抽屉），与文章页完全同一套交互；手机上正文不再内部滚动。 */}
      <div className="ru-mat-panel ru-les-panel">
        {!source && (
          <div style={{ color: 'var(--muted)', padding: '20px 0', textAlign: 'center' }}>
            {t('ru.mat.missing')}
          </div>
        )}
        {source && (
          <>
            <div ref={bodyRef} className="markdown-body compact ru-les-body" dangerouslySetInnerHTML={{ __html: html }} />
            <ArticleOutline
              containerRef={bodyRef}
              docId={les.id}
              initialHeadings={initialHeadings}
              minLevel={BODY_MIN_LEVEL}
              maxLevel={BODY_MAX_LEVEL}
              titleKey="ru.les.toc"
              openKey="ru.les.toc.open"
              closeKey="ru.les.toc.close"
            />
          </>
        )}
      </div>
    </div>
  )
}

export default LessonsTab