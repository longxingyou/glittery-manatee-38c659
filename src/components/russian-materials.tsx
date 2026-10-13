import React from 'react'
import { renderMarkdown } from '../lib/markdown'
import { useT } from '../lib/i18n'

// ──────────────────────────────────────────────
// 俄语语法手册：内容源在 content/russian-materials/（.md 参考表 + .opml 思维导图）。
// 构建期内联为字符串（?raw），编辑内容后重新构建即同步，运行时零网络请求。
// OPML 提供两种视图：markmap 交互画布（默认，可缩放拖拽）+ 可折叠列表；
// 全部材料支持打印（打印按钮挂 body.ru-mat-printing，由 styles.css @media print 接管）。
// ──────────────────────────────────────────────
const mdModules = import.meta.glob('../../content/russian-materials/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const opmlModules = import.meta.glob('../../content/russian-materials/*.opml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const fileContents = new Map<string, string>()
for (const mods of [mdModules, opmlModules]) {
  for (const [path, content] of Object.entries(mods)) {
    fileContents.set(path.split('/').pop() || path, content)
  }
}

type MaterialKind = 'md' | 'opml'

interface MaterialMeta {
  id: string
  file: string
  kind: MaterialKind
  title: string
  hint: string
  group: 'grammar' | 'usage'
}

const MATERIALS: MaterialMeta[] = [
  { id: 'overview', file: 'russian-grammar-overview.opml', kind: 'opml', title: '语法体系总览', hint: '词类 · 名词 · 动词 · 句法 · 构词全景网络', group: 'grammar' },
  { id: 'noun-map', file: 'russian-noun-system.opml', kind: 'opml', title: '名词变格网络', hint: '三变格法 · 前置词支配 · 辅音交替', group: 'grammar' },
  { id: 'noun-decl', file: 'russian-noun-declension.md', kind: 'md', title: '名词变格全表', hint: '六格 × 三变格法 × 三性完整范式', group: 'grammar' },
  { id: 'verb-map', file: 'russian-verb-system.opml', kind: 'opml', title: '动词体系网络', hint: '变位 · 时 · 体 · 式 · 态 · 运动动词', group: 'grammar' },
  { id: 'verb-conj', file: 'russian-verb-conjugation.md', kind: 'md', title: '动词变位全表', hint: '两变位法 × 体对偶 × 形动词/副动词', group: 'grammar' },
  { id: 'adj', file: 'russian-adjectives.md', kind: 'md', title: '形容词与比较级', hint: '硬/软/混合变化 · 短尾 · 比较级与最高级', group: 'grammar' },
  { id: 'pron', file: 'russian-pronouns.md', kind: 'md', title: '代词变格全表', hint: '人称 · 物主 · 指示 · 疑问 · 限定 · 不定', group: 'grammar' },
  { id: 'num', file: 'russian-numerals.md', kind: 'md', title: '数词系统', hint: '基数 · 序数 · 分数 · 数词与名词的格关系', group: 'grammar' },
  { id: 'wfm', file: 'russian-word-formation.opml', kind: 'opml', title: '构词法网络', hint: '前缀 · 后缀 · 复合 · 词根交替 · 去后缀', group: 'grammar' },
  { id: 'phrases', file: 'russian-high-frequency-phrases.md', kind: 'md', title: '高频短语速查', hint: '11 大场景 · 中俄英三语对照', group: 'usage' },
]

// ──────────────────────────────────────────────
// OPML → 树（递归下降解析，不依赖 DOMParser）
// ──────────────────────────────────────────────
interface OpmlNode {
  text: string
  note?: string
  children: OpmlNode[]
}

function readAttr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))
  return m?.[1]
}

function parseOutlineChildren(src: string, pos: { i: number }): OpmlNode[] {
  const out: OpmlNode[] = []
  while (pos.i < src.length) {
    // 先跳过标签间的空白（换行+缩进），否则 </outline> 永不匹配，
    // 后续兄弟 outline 会被串成父子链（画布呈阶梯状分布）
    while (pos.i < src.length && /\s/.test(src[pos.i]!)) pos.i++
    if (src.startsWith('</outline>', pos.i)) {
      pos.i += 10
      return out
    }
    const lt = src.indexOf('<outline', pos.i)
    if (lt === -1) break
    const gt = src.indexOf('>', lt)
    if (gt === -1) break
    const selfClose = src.charCodeAt(gt - 1) === 47 /* / */
    const attrs = src.slice(lt + 8, selfClose ? gt - 1 : gt)
    pos.i = gt + 1
    const children = selfClose ? [] : parseOutlineChildren(src, pos)
    out.push({ text: readAttr(attrs, 'text') ?? '', note: readAttr(attrs, '_note'), children })
  }
  return out
}

function parseOpml(xml: string): OpmlNode[] {
  return parseOutlineChildren(xml, { i: 0 })
}

// ──────────────────────────────────────────────
// markmap 画布数据：content 按原始 HTML 注入 foreignObject，
// 先转义再由 CSS（.ru-stress）绘制重音、<small> 追加注释小字
// ──────────────────────────────────────────────
type CanvasNode = { content: string; children: CanvasNode[] }

const RU_STRESS_RE = /([АЕИОУЫЭЮЯаеиоуыэюя])\u0301/g
const RU_CAP_RE = /[АЕИОУЫЭЮЯ]/

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 组合锐音符（U+0301）→ span，交给 CSS 按字形精确绘制（与附件预览页同方案） */
function ruStressHtml(s: string): string {
  return s.replace(RU_STRESS_RE, (_, ch: string) =>
    `<span class="ru-stress${RU_CAP_RE.test(ch) ? ' cap' : ''}">${ch}</span>`)
}

function toCanvasNode(n: OpmlNode): CanvasNode {
  const note = n.note
    ? `<small style="opacity:.62;font-weight:400">${ruStressHtml(escHtml(n.note))}</small>`
    : ''
  return { content: ruStressHtml(escHtml(n.text)) + note, children: n.children.map(toCanvasNode) }
}

/** markmap 画布：动态 import（含 d3，不进主包）；加载/布局失败回调父级降级到列表视图 */
function MindmapCanvas({ tree, onFail }: { tree: CanvasNode; onFail: () => void }) {
  const svgRef = React.useRef<SVGSVGElement>(null)
  React.useEffect(() => {
    let alive = true
    let mm: { destroy?: () => void; fit?: () => void } | null = null
    ;(async () => {
      try {
        const { Markmap } = await import('markmap-view')
        const svg = svgRef.current
        if (!svg || !alive) return
        mm = Markmap.create(svg, { autoFit: true, duration: 200 }, tree)
        void mm.fit?.()
      } catch {
        if (alive) onFail()
      }
    })()
    return () => {
      alive = false
      try { mm?.destroy?.() } catch { /* 已销毁 */ }
      while (svgRef.current?.firstChild) svgRef.current.removeChild(svgRef.current.firstChild)
    }
  }, [tree, onFail])
  return <svg ref={svgRef} className="ru-mat-svg" />
}

// ──────────────────────────────────────────────
// 思维导图列表视图（可折叠树）
// ──────────────────────────────────────────────
type ExpandMode = 'top' | 'all' | 'none'

function initialOpen(mode: ExpandMode, depth: number): boolean {
  if (mode === 'all') return true
  if (mode === 'none') return false
  return depth < 2 // 默认展开前两层
}

function OpmlNodeRow({ node, depth, mode }: { node: OpmlNode; depth: number; mode: ExpandMode }) {
  const [open, setOpen] = React.useState(() => initialOpen(mode, depth))
  const hasChildren = node.children.length > 0
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '3px 0', paddingLeft: depth * 15 }}>
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? 'collapse' : 'expand'}
            aria-expanded={open}
            onClick={() => setOpen(o => !o)}
            style={{
              flexShrink: 0,
              width: 20,
              height: 20,
              marginTop: 2,
              borderRadius: 5,
              border: '1px solid var(--line)',
              background: 'var(--panel-2, transparent)',
              color: 'var(--muted)',
              fontSize: 11,
              lineHeight: '16px',
              textAlign: 'center',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span style={{ flexShrink: 0, width: 20, textAlign: 'center', color: 'var(--muted)', opacity: 0.6, marginTop: 3 }}>·</span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              color: 'var(--text)',
              fontWeight: depth === 0 ? 700 : depth === 1 ? 600 : 400,
              fontSize: depth === 0 ? 14 : 13,
              lineHeight: 1.55,
              wordBreak: 'break-word',
            }}
          >
            {node.text}
          </span>
          {open && node.note && (
            <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, margin: '2px 0 4px', wordBreak: 'break-word' }}>
              {node.note}
            </div>
          )}
          {open && hasChildren && (
            <div>
              {node.children.map((child, i) => (
                <OpmlNodeRow key={i} node={child} depth={depth + 1} mode={mode} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// 语法手册标签页
// ──────────────────────────────────────────────
export function MaterialsTab() {
  const t = useT()
  const [sel, setSel] = React.useState('overview')
  const [mode, setMode] = React.useState<ExpandMode>('top')
  // 画布视图默认开启（与附件预览页一致）；markmap 加载失败自动降级列表
  const [view, setView] = React.useState<'canvas' | 'tree'>('canvas')

  const mat = MATERIALS.find(m => m.id === sel) ?? MATERIALS[0]
  const source = fileContents.get(mat.file)

  const pick = (id: string) => {
    setSel(id)
    setView('canvas')
    setMode('top')
  }

  const mdHtml = React.useMemo(
    () => (mat.kind === 'md' && source ? renderMarkdown(source, 1) : ''),
    [mat.kind, source],
  )
  const tree = React.useMemo(
    () => (mat.kind === 'opml' && source ? parseOpml(source) : []),
    [mat.kind, source],
  )
  const mmTree = React.useMemo<CanvasNode | null>(() => {
    if (tree.length === 0) return null
    const roots = tree.map(toCanvasNode)
    // 单根直接用；多根时合成虚拟根，保证画布有唯一起点
    return roots.length === 1 ? roots[0] : { content: escHtml(mat.title), children: roots }
  }, [tree, mat.title])

  const failToTree = React.useCallback(() => setView('tree'), [])

  // 打印：树视图先全部展开（key 重挂载生效）再唤起打印对话框；
  // body 类由 styles.css @media print 接管（隐藏操作区 + 强制浅色护墨 + 溢出可见防裁剪）
  const doPrint = React.useCallback(() => {
    const start = () => {
      const cleanup = () => document.body.classList.remove('ru-mat-printing')
      document.body.classList.add('ru-mat-printing')
      window.addEventListener('afterprint', cleanup, { once: true })
      window.print()
      window.setTimeout(cleanup, 2000) // 兜底：afterprint 不触发的环境
    }
    if (mat.kind === 'opml' && view === 'tree' && mode !== 'all') {
      setMode('all')
      window.setTimeout(start, 150)
    } else {
      start()
    }
  }, [mat.kind, view, mode])

  const isOpml = mat.kind === 'opml' && tree.length > 0

  return (
    <div className="ru-mat-print">
      {/* 材料选择：每行单组横向滑动（手机友好），打印时隐藏 */}
      <nav className="ru-mat-nav no-print">
        {([['grammar', t('ru.mat.grammar')], ['usage', t('ru.mat.usage')]] as const).map(([group, label]) => (
          <div className="ru-mat-row" key={group}>
            <span className="ru-mat-label">{label}</span>
            {MATERIALS.filter(m => m.group === group).map(m => (
              <button
                type="button"
                key={m.id}
                className={`ru-mat-chip${m.id === sel ? ' active' : ''}`}
                onClick={() => pick(m.id)}
                title={m.hint}
              >
                {m.kind === 'opml' && <span style={{ fontSize: 10, opacity: 0.75 }}>◈</span>}
                {m.title}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* 当前材料头部 */}
      <div className="ru-mat-head">
        <div style={{ minWidth: 0 }}>
          <div className="ru-mat-title">
            {mat.kind === 'opml' && <span style={{ marginRight: 6, fontSize: 12, color: 'var(--muted)' }}>◈</span>}
            {mat.title}
          </div>
          <div className="ru-mat-hint">{mat.hint}</div>
        </div>
        <div className="ru-mat-actions no-print">
          {isOpml && (
            <>
              <button
                type="button"
                className={`ru-mat-btn${view === 'canvas' ? ' active' : ''}`}
                onClick={() => setView('canvas')}
              >
                {t('preview.mind.map')}
              </button>
              <button
                type="button"
                className={`ru-mat-btn${view === 'tree' ? ' active' : ''}`}
                onClick={() => setView('tree')}
              >
                {t('preview.mind.tree')}
              </button>
            </>
          )}
          {isOpml && view === 'tree' && (
            <>
              {([['all', 'ru.mat.expand'], ['top', 'ru.mat.top'], ['none', 'ru.mat.collapse']] as const).map(([m, key]) => (
                <button
                  type="button"
                  key={m}
                  className={`ru-mat-btn${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {t(key)}
                </button>
              ))}
            </>
          )}
          <button type="button" className="ru-mat-btn" onClick={doPrint}>
            {t('ru.mat.print')}
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="ru-mat-panel">
        {!source && (
          <div style={{ color: 'var(--muted)', padding: '20px 0', textAlign: 'center' }}>
            {t('ru.mat.missing')}
          </div>
        )}

        {mat.kind === 'md' && source && (
          // .markdown-body 全局样式自带表格横向滚动（移动端友好）
          <div className="markdown-body compact" dangerouslySetInnerHTML={{ __html: mdHtml }} />
        )}

        {isOpml && view === 'canvas' && mmTree && (
          <div className="ru-mat-canvas">
            <MindmapCanvas tree={mmTree} onFail={failToTree} />
          </div>
        )}

        {isOpml && view === 'tree' && (
          <div key={`${mat.id}-${mode}`} style={{ overflowX: 'auto' }}>
            {tree.map((node, i) => (
              <OpmlNodeRow key={i} node={node} depth={0} mode={mode} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default MaterialsTab
