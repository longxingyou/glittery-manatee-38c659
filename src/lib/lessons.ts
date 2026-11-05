// ──────────────────────────────────────────────
// 课程中心：元数据 + 按需加载器。内容源在 content/russian-lessons/（.md）。
// 与旧版 russian-lessons.tsx 的关键差异：eager:false —— 每课编译为独立 chunk，
// 首屏只带元数据，正文在路由 loader 里按需取（SSR 时序列化进首屏 HTML）。
//
// 结构分两层：**教材（BOOKS）→ 条目（LESSONS）**。
// 条目分两类：逐课精讲（lesson）与全局条目（global，总表 / 词表）。
// 通用课程中心：BookMeta.subject 标记学科（当前全部为 russian），
// 未来其他学科在此追加 BOOKS/LESSONS + content/<subject>-lessons/ 目录、
// 并在下方 mdLoaders 增加一条 glob 即可。
// 同一系列还会有后续教材，BOOKS 里为它们留了可见的预留位（reserved），
// 因此这里是「系列书架」而不是某一册书的硬编码清单：
//   · 加一个新系列/新一册：BOOKS 里把某个 reserved 条目改写为真实条目；
//   · 加该册的内容：LESSONS 里追加条目，book 填对应 id。
//
// 重音：.md 源码保留组合锐音符 U+0301 —— renderMarkdown 不处理重音，
// 渲染后由 lesson-page.tsx 的 stressHtml()（仅 subject === 'russian'）处理。
// ──────────────────────────────────────────────
const mdLoaders = import.meta.glob('../../content/russian-lessons/*.md', {
  query: '?raw',
  import: 'default',
  eager: false,
}) as Record<string, () => Promise<string>>

const loaderByFile = new Map<string, () => Promise<string>>()
for (const [path, load] of Object.entries(mdLoaders)) {
  loaderByFile.set(path.split('/').pop() || path, load)
}

/**
 * 按需取一课/一条目的 Markdown 源。
 * 返回 undefined 只有两种可能：glob 里没有这个文件（真缺失，需重新构建），
 * 或动态 import 连续失败。后者多半是网络/缓存瞬断（部署后旧 chunk 失效、
 * 弱网拉取超时），所以先重试一次再判定，避免把一次抖动永久显示成「缺失」。
 */
export async function loadLessonSource(file: string): Promise<string | undefined> {
  const load = loaderByFile.get(file)
  if (!load) return undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await load()
    } catch {
      // 第一次失败继续循环重试；第二次仍失败才放弃
    }
  }
  return undefined
}

/** 一册教材（或一个系列）。reserved=true 表示预留位，尚无内容。 */
export interface BookMeta {
  id: string
  /** 学科（课程中心未来按学科分区展示；当前全部为 'russian'） */
  subject: string
  /** 展示名（reserved 条目留空，渲染时用 i18n 的「预留位」文案） */
  title: string
  /** 册别说明，例如 Элементарный уровень · Урок 1–12 */
  hint: string
  reserved?: boolean
}

export interface LessonMeta {
  id: string
  file: string
  title: string
  hint: string
  group: 'lesson' | 'global'
  /** 所属教材 id（对应 BOOKS 中的一项） */
  book: string
}

export const BOOKS: BookMeta[] = [
  { id: 'p-russia', subject: 'russian', title: '《Привет, Россия!》', hint: 'Элементарный уровень · Урок 1–12' },
  // ── 同系列后续教材的预留位 ──
  // 整理新书时：把 reserved 去掉、填上 title/hint，再在下面 LESSONS 里追加条目
  // （book 填该 id）。预留位在页面上可见，接入时无需改动任何渲染代码。
  { id: 'p-russia-baz', subject: 'russian', title: '《Привет, Россия! (Базовый)》', hint: 'Базовый уровень · Урок 1–10' },
  { id: 'slot-b', subject: 'russian', title: '', hint: '', reserved: true },
]

export const LESSONS: LessonMeta[] = [
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
  { id: 'pos', file: '13-words-by-pos.md', title: '词表 · 按词型', hint: '1,353 词按名词/动词/形容词等 10 类（另附参考书补充 95 词）', group: 'global', book: 'p-russia' },
  { id: 'theme', file: '14-words-by-theme.md', title: '词表 · 按主题', hint: '同 1,353 词按 20 个主题归集（另附参考书补充 95 词）', group: 'global', book: 'p-russia' },
  { id: 'compendium', file: '15-key-compendium.md', title: '关键内容精编', hint: '全书语法主干 · 核心问答 · 易混辨析 · 六格速查 · 高频错误自查', group: 'global', book: 'p-russia' },

  // ── 《Привет, Россия! (Базовый)》 独立分区（b 前缀文件，与 Элементарный 不撞名）──
  { id: 'b-l1', file: 'b01-urok-1.md', title: 'Урок 1', hint: 'Ру́сский язы́к — 第六格（形容词/代词）· 年份表达 · 三个「学」', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l2', file: 'b02-urok-2.md', title: 'Урок 2', hint: 'Наро́ды Росси́и — 第六格复数 · 不定人称句 · свой/кото́рый', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l3', file: 'b03-urok-3.md', title: 'Урок 3', hint: 'Необы́чные профе́ссии — 第二格形容词/代词 · 日期 · чтобы · 间接引语', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l4', file: 'b04-urok-4.md', title: 'Урок 4', hint: 'Языки́ и полигло́ты — 第二格复数 · 比较级 · ли 从句', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l5', file: 'b05-urok-5.md', title: 'Урок 5', hint: 'Выбира́ем экску́рсию — 第四格形容词 · 时间表达 · где/куда/откуда · 运动动词前缀', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l6', file: 'b06-urok-6.md', title: 'Урок 6', hint: 'Чем заня́ться — 第四格复数 · который 第四格 · в(о)-/вы-/пере-/до-', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l7', file: 'b07-urok-7.md', title: 'Урок 7', hint: 'Дорога́я моя́ столи́ца — 第三格全体系 · под-/от- · ну́жен', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l8', file: 'b08-urok-8.md', title: 'Урок 8', hint: 'О, спорт, ты — жизнь! — 第五格全体系 · нести/носить · когда́ 从句', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l9', file: 'b09-urok-9.md', title: 'Урок 9', hint: 'Иску́сство и нау́ка — если 条件句 · 及物运动动词 · где/куда́/отку́да · 阶段动词', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-l10', file: 'b10-urok-10.md', title: 'Урок 10', hint: 'До но́вых встреч! — себя́ · -ся 动词 · никто́/ничто́ · 命令式', group: 'lesson', book: 'p-russia-baz' },
  { id: 'b-ov', file: 'b00-overview.md', title: '总览', hint: 'Базовый 全书导航 · 语法主线 · 与 Элементарный 的衔接', group: 'global', book: 'p-russia-baz' },
  { id: 'b-pos', file: 'b13-words-by-pos.md', title: '词表 · 按词型', hint: '121 个 Базовый 真新词按名词/动词/形容词/副词分类', group: 'global', book: 'p-russia-baz' },
  { id: 'b-theme', file: 'b14-words-by-theme.md', title: '词表 · 按主题', hint: '同 121 词按 10 课主题归集（场景联想）', group: 'global', book: 'p-russia-baz' },
  { id: 'b-comp', file: 'b15-key-compendium.md', title: '关键内容精编', hint: '六格体系总表 · 名词/形容词变格全表 · 运动动词九前缀 · 复合句总表 · 易混辨析', group: 'global', book: 'p-russia-baz' },
]

/** 条目分组的展示顺序与文案 key（新增书目沿用同一套分组） */
export const GROUPS = [
  { id: 'lesson', key: 'ru.les.group.lesson' },
  { id: 'global', key: 'ru.les.group.global' },
] as const

export function findLesson(id: string): LessonMeta | undefined {
  return LESSONS.find((m) => m.id === id)
}

export function bookOfLesson(les: LessonMeta): BookMeta | undefined {
  return BOOKS.find((b) => b.id === les.book)
}

/** 同册书内按 LESSONS 顺序的前后邻居（跨 lesson/global 分组，便于通读到底） */
export function lessonNeighbors(les: LessonMeta): { prev?: LessonMeta; next?: LessonMeta } {
  const items = LESSONS.filter((m) => m.book === les.book)
  const i = items.findIndex((m) => m.id === les.id)
  return { prev: i > 0 ? items[i - 1] : undefined, next: i >= 0 ? items[i + 1] : undefined }
}

/** 「上次阅读」localStorage key：与旧版工具箱相同，历史记录直接生效，不做迁移 */
export const LESSON_LAST_KEY = 'dsh.ru.lessons.last'
