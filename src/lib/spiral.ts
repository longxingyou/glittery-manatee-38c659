/**
 * Janet 左阶梯（left-step）螺旋版面。
 *
 * 科学依据：Charles Janet（1928）按 (n + l) 顺序排列轨道，得到 32 列的左阶梯表；
 * 把每一周期卷成一圈（周期 1 在最内），即得极坐标螺旋。
 *
 * 行（周期）长度严格等于周期表周期长度：
 *   L = [2, 8, 8, 18, 18, 32, 32]
 * 行内列号（0 基，共 32 列，s 区最右）：
 *   s: 30–31      p: 24–29      d: 14–23      f: 0–13
 * 角度（0° 指向右侧，屏幕 y 向下，顺时针为正）：
 *   θ(c) = -90° + 360° × (c + 0.5) / 32
 * 半径按周期递增，相邻周期半径差相同 → 同族（同列）自动落在同一条射线上。
 *
 * 校验点（见 scripts/verify-spiral.ts）：
 *   · 每行元素数 = 2/8/8/18/18/32/32；
 *   · La(57) 在第 6 行 f 区首列（c=0），Lu(71) 在 d 区首列（c=14）；
 *   · Ac(89) 在第 7 行 f 区首列，Lr(103) 在 d 区首列；
 *   · H(1) 与 Li/Na/K/Rb/Cs/Fr 同列（c=30，1 族），He(2) 与 Be…Ra 同列（c=31）。
 */

export const SPIRAL_COLUMNS = 32
// 内圈半径按「相邻列弧长 ≥ 节点直径」反推：2π·R0·W/32 ≥ 21px（W=580 时 R0≈0.185）
export const SPIRAL_R0 = 0.2
export const SPIRAL_R1 = 0.44

export interface SpiralPeriod {
  period: number
  start: number
  length: number
}

export const SPIRAL_PERIODS: SpiralPeriod[] = [
  { period: 1, start: 1, length: 2 },
  { period: 2, start: 3, length: 8 },
  { period: 3, start: 11, length: 8 },
  { period: 4, start: 19, length: 18 },
  { period: 5, start: 37, length: 18 },
  { period: 6, start: 55, length: 32 },
  { period: 7, start: 87, length: 32 },
]

export interface SpiralNode {
  z: number
  period: number
  /** 0 基列号（0–31，s 区在右） */
  col: number
  /** 角度（度） */
  theta: number
  /** 半径（0–0.5 的容器比例，用于百分比定位） */
  rho: number
  /** 容器内归一化坐标 0–1 */
  x: number
  y: number
}

export interface SpiralArc {
  period: number
  rho: number
  fromCol: number
  toCol: number
  /** 32 列整圈：用 circle 绘制（首尾同点无法用单段 A 弧） */
  full: boolean
}

export interface SpiralLayout {
  nodes: SpiralNode[]
  /** 连续阅读顺序（原子序数），用于画流动虚线 */
  order: number[]
  arcs: SpiralArc[]
  /** 相邻周期之间的径向连接线（容器内 0–100 坐标） */
  connectors: Array<{ from: [number, number]; to: [number, number] }>
  /** 族号标注：列 → 族（f 区无族号） */
  groups: Array<{ col: number; group: number }>
}

export function spiralTheta(col: number): number {
  return -90 + (360 * (col + 0.5)) / SPIRAL_COLUMNS
}

export function spiralRho(periodIndex: number): number {
  return SPIRAL_R0 + (periodIndex * (SPIRAL_R1 - SPIRAL_R0)) / (SPIRAL_PERIODS.length - 1)
}

/** 极坐标 → viewBox(0–100) 坐标，便于 SVG 与百分比定位共用同一套角度 */
export function spiralPoint(rho: number, thetaDeg: number): { x: number; y: number } {
  const rad = (thetaDeg * Math.PI) / 180
  return { x: 50 + rho * 100 * Math.cos(rad), y: 50 + rho * 100 * Math.sin(rad) }
}

/** row 内各元素的列号：s(30,31) → f(0–13) → d(14–23) → p(24–29) */
function colsOfRow(length: number): number[] {
  const cols: number[] = [30, 31]
  if (length === 32) for (let c = 0; c <= 13; c++) cols.push(c)
  if (length >= 18) for (let c = 14; c <= 23; c++) cols.push(c)
  for (let c = 24; c <= 29; c++) cols.push(c)
  return cols
}

export function layoutSpiralJanet(): SpiralLayout {
  const nodes: SpiralNode[] = []
  const order: number[] = []
  const arcs: SpiralArc[] = []
  const connectors: SpiralLayout['connectors'] = []
  const rows: Array<{ period: number; rho: number; first: [number, number]; last: [number, number] }> = []

  SPIRAL_PERIODS.forEach((p, i) => {
    const rho = spiralRho(i)
    const cols = colsOfRow(p.length)
    const rowNodes: SpiralNode[] = []
    cols.forEach((col, k) => {
      const z = p.start + k
      if (z > p.start + p.length - 1) return
      const theta = spiralTheta(col)
      const pt = spiralPoint(rho, theta)
      rowNodes.push({
        z,
        period: p.period,
        col,
        theta,
        rho,
        x: pt.x / 100,
        y: pt.y / 100,
      })
    })
    // colsOfRow 已按「s → f → d → p」返回，即原子序数递增且角度连续（跨 -90° 接缝）
    for (const n of rowNodes) {
      nodes.push(n)
      order.push(n.z)
    }
    arcs.push({
      period: p.period,
      rho,
      fromCol: SPIRAL_COLUMNS - p.length,
      toCol: SPIRAL_COLUMNS - 1,
      full: p.length === SPIRAL_COLUMNS,
    })
    const first = spiralPoint(rho, spiralTheta(cols[0]))
    const last = spiralPoint(rho, spiralTheta(cols[cols.length - 1]))
    rows.push({ period: p.period, rho, first: [first.x, first.y], last: [last.x, last.y] })
  })

  for (let i = 0; i < rows.length - 1; i++) {
    // 行末（最后一个元素）→ 下一行行首（第 1 族）：屏幕上都是约 11° 的短弧
    const from = rows[i].last
    const to = rows[i + 1].first
    connectors.push({
      from: [Number(from[0].toFixed(2)), Number(from[1].toFixed(2))],
      to: [Number(to[0].toFixed(2)), Number(to[1].toFixed(2))],
    })
  }

  const groups: SpiralLayout['groups'] = [
    { col: 30, group: 1 },
    { col: 31, group: 2 },
  ]
  for (let c = 14; c <= 23; c++) groups.push({ col: c, group: c - 11 }) // 3–12
  for (let c = 24; c <= 29; c++) groups.push({ col: c, group: c - 11 }) // 13–18

  return { nodes, order, arcs, connectors, groups }
}

/** 圆弧 path（viewBox 0–100） */
export function spiralArcPath(rho: number, fromCol: number, toCol: number): string {
  const a0 = spiralTheta(fromCol)
  const a1 = spiralTheta(toCol)
  const p0 = spiralPoint(rho, a0)
  const p1 = spiralPoint(rho, a1)
  const r = rho * 100
  const large = a1 - a0 > 180 ? 1 : 0
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`
}
