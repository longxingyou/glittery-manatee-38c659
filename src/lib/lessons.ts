// ──────────────────────────────────────────────
// 课程中心：元数据 + 按需加载器。内容源在 content/russian-lessons/（.md）。
// 与旧版 russian-lessons.tsx 的关键差异：eager:false —— 每课编译为独立 chunk，
// 首屏只带元数据，正文在路由 loader 里按需取（SSR 时序列化进首屏 HTML）。
//
// 结构分两层：**教材（BOOKS）→ 条目（LESSONS）**。
// 条目分两类：逐课精讲（lesson）与全局条目（global，总表 / 词表）。
// 通用课程中心：BookMeta.subject 标记学科。俄语讲义在 content/russian-lessons/；
// lib 自编课程按 content/<学科>-lessons/<课程>/*.md 放（学科目录名对应 BOOKS 的 subject），
// 一门课一个子目录，避免不同课程的同号课互相覆盖。
// 新增学科只需：BOOKS 增加条目 + 对应的 content/<学科>-lessons/ 目录，
// 下方 mdLoaders 的两条 glob 已覆盖「平铺」与「课程子目录」两种布局。
// 同一系列还会有后续教材，BOOKS 里为它们留了可见的预留位（reserved），
// 因此这里是「系列书架」而不是某一册书的硬编码清单：
//   · 加一个新系列/新一册：BOOKS 里把某个 reserved 条目改写为真实条目；
//   · 加该册的内容：LESSONS 里追加条目，book 填对应 id，
//     新学科的 file 建议写相对 content 的完整路径（如 math-lessons/analysis-1/01.md）。
//
// 重音：.md 源码保留组合锐音符 U+0301 —— renderMarkdown 不处理重音，
// 渲染后由 lesson-page.tsx 的 stressHtml()（仅 subject === 'russian'）处理。
// ──────────────────────────────────────────────
const mdLoaders = {
  ...(import.meta.glob('../../content/*-lessons/*.md', {
    query: '?raw', import: 'default', eager: false,
  }) as Record<string, () => Promise<string>>),
  ...(import.meta.glob('../../content/*-lessons/*/*.md', {
    query: '?raw', import: 'default', eager: false,
  }) as Record<string, () => Promise<string>>),
}

const loaderByFile = new Map<string, () => Promise<string>>()
for (const [path, load] of Object.entries(mdLoaders)) {
  const rel = path.split('/content/')[1] || path
  loaderByFile.set(rel, load)
  // 兼容既有条目：file 只写了文件名。新学科建议写完整相对路径以避免同名。
  const base = rel.split('/').pop() || rel
  if (!loaderByFile.has(base)) loaderByFile.set(base, load)
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

// ──────────────────────────────────────────────
// 讲义配图：图片放 src/assets/lessons/（可再分子目录），讲义里写 ![](fig1.png)
// 或沿用 Obsidian 的 ![[fig1.png]] 即可。这里用 glob + ?url 把图交给 Vite：
// 开发时按 /src/assets/… 直接服务，构建时输出带 hash 的 /assets/… 并返回 URL
// （不能放 content/ 或 public/ 再 glob：content/ 不被 dev server 服务，public/ 不能进模块图）。
// 解析顺序：先按完整相对路径（ch1/fig1.png），再退回全局同名文件。
const lessonImages = import.meta.glob('../assets/lessons/**/*.{png,jpg,jpeg,webp,avif,gif,svg,bmp}', {
  query: '?url', import: 'default', eager: true,
}) as Record<string, string>

const imageByPath = new Map<string, string>()
const imageByName = new Map<string, string>()
for (const [path, url] of Object.entries(lessonImages)) {
  const rel = path.split('/assets/lessons/')[1] || path
  imageByPath.set(rel, url)
  const base = rel.split('/').pop() || rel
  if (!imageByName.has(base)) imageByName.set(base, url)
}

/** 讲义里的相对图片引用（fig1.png / ch1/fig1.png）→ 可用的资源 URL；解析不到返回 undefined */
export function resolveLessonImage(href: string): string | undefined {
  const clean = href.trim().replace(/^\.\//, '').split(/[?#]/)[0]
  if (!clean || /^(?:[a-z]+:|\/)/i.test(clean)) return undefined
  return imageByPath.get(clean) ?? imageByName.get(clean.split('/').pop() || clean)
}

/** 一册教材（或一个系列）。reserved=true 表示预留位，尚无内容。 */
export interface BookMeta {
  id: string
  /** 学科：russian / math / mechanics / meteorology / chemistry… */
  subject: string
  /** 展示名（reserved 条目可留空，留空时渲染 i18n 的「预留位」文案） */
  title: string
  /** 册别说明，例如 Элементарный уровень · Урок 1–12 */
  hint: string
  reserved?: boolean
}

export interface LessonMeta {
  id: string
  /** 相对 content/ 的路径；也可只写文件名（仅限全站唯一时） */
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
  // ── lib 自编课程：统一归「杂项」，学科只作为条目说明 ──
  // 把书编成课后，在 content/misc-lessons/<课程>/ 放 md，再把这条 slot 改成真实条目；
  // 需要区分学科时在 title/hint 里写（如「数学 · 数学分析（一）」），不再单开分区。
  { id: 'lib-linalg', subject: 'misc', title: '数学 · 线性代数', hint: 'Axler《线性代数应该这样学》第四版 · 38 讲 +《行列式入门》专题补充' },
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

  // ── 数学 · 线性代数（38 讲 + 附录 + 总表）──
  // 内容源：content/misc-lessons/linear-algebra/（与 Rag 课程库单一真源同步）
  // 登记顺序 = 站内上一讲/下一讲顺序；新增讲次时**按编号插入**，不要追加到末尾。
  { id: 'la-ov', file: 'misc-lessons/linear-algebra/00-overview.md', title: '课程导航', hint: '讲什么 · 三种读法 · 知识地图 · 记号约定 · 学习计划', group: 'global', book: 'lib-linalg' },
  // ⚠️ 以下由 _pipeline/gen_lessons_ts.py 按**真实文件名**自动生成。
  // 手工修改会被覆盖；要改概要（hint），改脚本读到的现有条目即可。
  // <<<LA-LESSONS-BEGIN>>>
  { id: 'la-01', file: 'misc-lessons/linear-algebra/01-向量与坐标.md', title: '01 向量与坐标', hint: '数域为何要封闭 · 复数与旋转 · 有序数组的五种看法 · 三种运算', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-02', file: 'misc-lessons/linear-algebra/02-向量空间.md', title: '02 向量空间', hint: '六条性质（对照「八条」）· 四类例子 · 量词顺序 · 零元与逆元唯一', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-03', file: 'misc-lessons/linear-algebra/03-子空间.md', title: '03 子空间', hint: '三条判据 · 常见反例 · 和与直和', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-04', file: 'misc-lessons/linear-algebra/04-张成与线性无关.md', title: '04 张成与线性无关', hint: '线性组合 · 张成空间 · 线性相关性引理 · 长度不等式', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-05', file: 'misc-lessons/linear-algebra/05-基.md', title: '05 基', hint: '基的判定 · 削减定理 · 扩充定理', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-06', file: 'misc-lessons/linear-algebra/06-维数.md', title: '06 维数', hint: '基同长定理 · 维数不依赖基的选择 · 和维数公式', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-07', file: 'misc-lessons/linear-algebra/07-线性映射.md', title: '07 线性映射', hint: '加性与齐性两条就够 · L(V,W) 是向量空间 · 复合', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-08', file: 'misc-lessons/linear-algebra/08-零空间与值域.md', title: '08 零空间与值域', hint: '线性映射基本定理 · 单射判据 · 维数记账', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-09', file: 'misc-lessons/linear-algebra/09-矩阵.md', title: '09 矩阵', hint: '矩阵乘法为什么那样定义 · 四种读法 · 复合即相乘', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-10', file: 'misc-lessons/linear-algebra/10-可逆性与同构.md', title: '10 可逆性与同构', hint: '单射⟺满射的有限维魔法 · 同构⟺维数相等 · 换基', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-11', file: 'misc-lessons/linear-algebra/11-积与商空间.md', title: '11 积与商空间', hint: '直积的维数 · 商空间怎么读 · 商映射', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-12', file: 'misc-lessons/linear-algebra/12-对偶.md', title: '12 对偶', hint: '12 对偶', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-13', file: 'misc-lessons/linear-algebra/13-多项式的零点.md', title: '13 多项式的零点', hint: '13 多项式的零点', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-14', file: 'misc-lessons/linear-algebra/14-带余除法.md', title: '14 带余除法', hint: '14 带余除法', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-15', file: 'misc-lessons/linear-algebra/15-复系数分解.md', title: '15 复系数分解', hint: '15 复系数分解', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-16', file: 'misc-lessons/linear-algebra/16-实系数分解.md', title: '16 实系数分解', hint: '16 实系数分解', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-17', file: 'misc-lessons/linear-algebra/17-不变子空间.md', title: '17 不变子空间', hint: '17 不变子空间', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-18', file: 'misc-lessons/linear-algebra/18-极小多项式.md', title: '18 极小多项式', hint: '18 极小多项式', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-19', file: 'misc-lessons/linear-algebra/19-上三角矩阵.md', title: '19 上三角矩阵', hint: '19 上三角矩阵', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-20', file: 'misc-lessons/linear-algebra/20-可对角化.md', title: '20 可对角化', hint: '20 可对角化', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-21', file: 'misc-lessons/linear-algebra/21-可交换算子.md', title: '21 可交换算子', hint: '21 可交换算子', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-22', file: 'misc-lessons/linear-algebra/22-内积与范数.md', title: '22 内积与范数', hint: '22 内积与范数', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-23', file: 'misc-lessons/linear-algebra/23-规范正交基.md', title: '23 规范正交基', hint: '23 规范正交基', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-24', file: 'misc-lessons/linear-algebra/24-正交补与最小化.md', title: '24 正交补与最小化', hint: '24 正交补与最小化', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-25', file: 'misc-lessons/linear-algebra/25-自伴与正规算子.md', title: '25 自伴与正规算子', hint: '25 自伴与正规算子', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-26', file: 'misc-lessons/linear-algebra/26-谱定理.md', title: '26 谱定理', hint: '26 谱定理', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-27', file: 'misc-lessons/linear-algebra/27-正算子.md', title: '27 正算子', hint: '27 正算子', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-28', file: 'misc-lessons/linear-algebra/28-等距与矩阵分解.md', title: '28 等距与矩阵分解', hint: '28 等距与矩阵分解', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-29', file: 'misc-lessons/linear-algebra/29-奇异值分解.md', title: '29 奇异值分解', hint: '29 奇异值分解', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-30', file: 'misc-lessons/linear-algebra/30-SVD-的推论.md', title: '30 SVD-的推论', hint: '30 SVD-的推论', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-31', file: 'misc-lessons/linear-algebra/31-广义特征向量与幂零算子.md', title: '31 广义特征向量与幂零算子', hint: '31 广义特征向量与幂零算子', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-32', file: 'misc-lessons/linear-algebra/32-广义特征空间分解.md', title: '32 广义特征空间分解', hint: '32 广义特征空间分解', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-33', file: 'misc-lessons/linear-algebra/33-Jordan-形.md', title: '33 Jordan-形', hint: '33 Jordan-形', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-34', file: 'misc-lessons/linear-algebra/34-迹.md', title: '34 迹', hint: '34 迹', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-35', file: 'misc-lessons/linear-algebra/35-双线性型与二次型.md', title: '35 双线性型与二次型', hint: '35 双线性型与二次型', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-36', file: 'misc-lessons/linear-algebra/36-交错多重线性型.md', title: '36 交错多重线性型', hint: '36 交错多重线性型', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-37', file: 'misc-lessons/linear-algebra/37-行列式.md', title: '37 行列式', hint: '37 行列式', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-38', file: 'misc-lessons/linear-algebra/38-张量积.md', title: '38 张量积', hint: '38 张量积', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-a1', file: 'misc-lessons/linear-algebra/A1-线性方程组与消元.md', title: 'A1-线性方程组与消元', hint: 'A1-线性方程组与消元', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-a2', file: 'misc-lessons/linear-algebra/A2-数学预备.md', title: 'A2-数学预备', hint: 'A2-数学预备', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-s1', file: 'misc-lessons/linear-algebra/S1-符号表.md', title: 'S1-符号表', hint: 'S1-符号表', group: 'lesson', book: 'lib-linalg' },
  { id: 'la-s2', file: 'misc-lessons/linear-algebra/S2-定理速查.md', title: 'S2-定理速查', hint: 'S2-定理速查', group: 'lesson', book: 'lib-linalg' },
  // <<<LA-LESSONS-END>>>
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
