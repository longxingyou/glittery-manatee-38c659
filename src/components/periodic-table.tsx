import React from 'react'
import { useSearch } from '@tanstack/react-router'
import type { Object3D as ThreeObject3D } from 'three'

import {
  ELEMENTS, ELEMENT_BY_Z, elGridPos,
  GROUP_LABELS_CN, GROUP_LABELS_RU,
  CAT_LABELS, CAT_ORDER, PHASE_COLORS,
  kelvinToCelsius, kelvinToFahrenheit, kjPerMolToEv,
  colorScale, fieldRange,
  PROP_DEFS,
  ISOTOPES, decayModeLabel, fmtHalfLifeUnit,
  type Element, type Cat, type PropKey,
} from '../lib/elements'
import { getElementAudio, playElementName, prefetchElementAudio } from '../lib/element-audio'
import { useLang, type Lang } from '../lib/i18n'
import {
  layoutSpiralJanet, spiralArcPath, spiralPoint, spiralRho, spiralTheta,
  SPIRAL_PERIODS,
} from '../lib/spiral'

// ──────────────────────────────────────────────
// 两层语言：
//   uiText(lang, zh, en, ru) —— 周期表界面文案，跟随全站语言切换器；
//   elText(lang, e)          —— 元素名称 / 分类名 / 属性名，跟随表内「名称语言」。
// 旧版只有一个 RU/CN 开关，界面与元素名绑死；现在两者独立。
// ──────────────────────────────────────────────
function uiText(lang: Lang, zh: string, en: string, ru: string): string {
  return lang === 'zh' ? zh : lang === 'en' ? en : ru
}

/** 当前元素语言下的名称 */
function elText(lang: Lang, e: Element): string {
  return lang === 'zh' ? e.zh : lang === 'en' ? e.en : e.ru
}

/** 除当前语言外的另外两个名称，用于副标题 / tooltip */
function elSub(lang: Lang, e: Element): string {
  if (lang === 'zh') return `${e.en} · ${e.ru}`
  if (lang === 'en') return `${e.zh} · ${e.ru}`
  return `${e.zh} · ${e.en}`
}

/**
 * 源数据中的晶系名称只有英文；非英文界面下本地化。
 * 取值集合固定（14 种），未收录时回退英文原文。
 */
const CRYSTAL_LABELS: Record<string, { zh: string; ru: string }> = {
  'Simple Cubic': { zh: '简单立方', ru: 'простая кубическая' },
  'Body-centered Cubic': { zh: '体心立方', ru: 'объёмно-центрированная кубическая' },
  'Face-centered Cubic': { zh: '面心立方', ru: 'гранецентрированная кубическая' },
  'Face-centered Diamond-cubic': { zh: '面心金刚石立方', ru: 'алмазная кубическая' },
  'Simple Hexagonal': { zh: '简单六方', ru: 'простая гексагональная' },
  'Simple Trigonal': { zh: '简单三方', ru: 'простая тригональная' },
  'Centered Tetragonal': { zh: '体心四方', ru: 'объёмно-центрированная тетрагональная' },
  'Simple Orthorhombic': { zh: '简单正交', ru: 'простая ромбическая' },
  'Base Orthorhombic': { zh: '底心正交', ru: 'базоцентрированная ромбическая' },
  'Face-centered Orthorhombic': { zh: '面心正交', ru: 'гранецентрированная ромбическая' },
  'Simple Monoclinic': { zh: '简单单斜', ru: 'простая моноклинная' },
  'Base-centered Monoclinic': { zh: '底心单斜', ru: 'базоцентрированная моноклинная' },
  'Simple Triclinic': { zh: '简单三斜', ru: 'простая триклинная' },
  'Tetrahedral Packing': { zh: '四面体堆积', ru: 'тетраэдрическая упаковка' },
}

function crystalLabel(name: string, lang: Lang): string {
  if (!name) return '—'
  if (lang === 'en') return name
  return CRYSTAL_LABELS[name]?.[lang] ?? name
}

/** 元素简介：源数据只有英文维基摘要，中文/俄文界面用结构化事实句替代，避免语言错位 */
function summaryText(lang: Lang, e: Element): string {
  if (lang === 'en') return e.summary
  if (lang === 'zh') {
    return `${e.zh}（${e.sym}）是第 ${e.period} 周期、第 ${e.group} 族的${CAT_LABELS[e.cat].zh}，常温常压下为${fmtPhase(e.phase, 'zh')}。`
  }
  return `${e.ru} (${e.sym}) — элемент ${e.period}-го периода, ${e.group}-й группы, ${CAT_LABELS[e.cat].ru.toLowerCase()}; при нормальных условиях — ${fmtPhase(e.phase, 'ru').toLowerCase()}.`
}

// ──────────────────────────────────────────────
// 颜色映射可选字段（pTable.com 风格）
// 扩充 Phase 2：利用 Bowser 主源新字段（rMetallic / molarHeat / conductThermal）
// ──────────────────────────────────────────────
const COLOR_FIELDS: Array<{ key: PropKey; getter: (e: Element) => number | null; ru: string; zh: string; en: string; log?: boolean }> = [
  { key: 'mpK',            getter: (e) => e.mpK,         ru: 'Температура плавления', zh: '熔点',       en: 'Melting point' },
  { key: 'bpK',            getter: (e) => e.bpK,         ru: 'Температура кипения',   zh: '沸点',       en: 'Boiling point' },
  { key: 'density',        getter: (e) => e.density,     ru: 'Плотность (STP)',       zh: '密度',       en: 'Density', log: true },
  { key: 'eneg',           getter: (e) => e.eneg,        ru: 'Электроотрицательность', zh: '电负性',     en: 'Electronegativity' },
  { key: 'eaff',           getter: (e) => e.eaff,        ru: 'Сродство к электрону',  zh: '电子亲合能', en: 'Electron affinity' },
  { key: 'ie1',            getter: (e) => e.ie[0] ?? null, ru: '1-я энергия ионизации', zh: '第一电离能', en: '1st ionization energy' },
  { key: 'rCovSingle',     getter: (e) => e.rCovSingle,  ru: 'Ковалентный (одинарный)', zh: '共价半径（单键）', en: 'Covalent radius (single)' },
  { key: 'rMetallic',      getter: (e) => e.rMetallic,   ru: 'Металлический радиус',  zh: '金属半径',   en: 'Metallic radius' },
  { key: 'valE',           getter: (e) => e.valE,        ru: 'Валентных электронов',  zh: '价电子数',   en: 'Valence electrons' },
  { key: 'molarHeat',      getter: (e) => e.molarHeat,   ru: 'Молярная теплоёмкость', zh: '摩尔热容',   en: 'Molar heat capacity' },
  { key: 'conductThermal', getter: (e) => e.conductThermal, ru: 'Теплопроводность',    zh: '导热系数',   en: 'Thermal conductivity', log: true },
]

type ColorMode = 'cat' | 'phase' | 'field' | 'temp'
type TempUnit = 'K' | 'C' | 'F'
type EnergyUnit = 'kJ' | 'eV'
type LayoutMode = 'standard' | 'leftstep' | 'short' | 'spiral'

// 数值字段在格子/滑杆里的紧凑单位；温度字段固定用 K（颜色映射也按 K）
const FIELD_UNITS: Partial<Record<PropKey, string>> = {
  mpK: 'K', bpK: 'K', density: 'g/cm³', eaff: 'kJ/mol', ie1: 'kJ/mol',
  rCovSingle: 'pm', rMetallic: 'pm', molarHeat: 'J/(mol·K)', conductThermal: 'W/(m·K)',
}

type NumericQuery = { op: '>' | '>=' | '<' | '<=' | '~' | '=' | 'range'; a: number; b?: number }

/** 数值搜索：>1000 / <=300 / 400-800 / ~200 / =3；纯数字仍按序号/名称搜索 */
function parseNumericQuery(input: string): NumericQuery | null {
  const q = input.trim()
  const m = q.match(/^(>=|<=|>|<|~|=)?\s*(-?\d+(?:\.\d+)?)\s*(?:[-–]\s*(-?\d+(?:\.\d+)?))?$/)
  if (!m) return null
  const [, opRaw, aRaw, bRaw] = m
  // 没有运算符也不是范围时不抢走「26」这类序号搜索
  if (!opRaw && bRaw == null) return null
  if (bRaw != null) return { op: 'range', a: Number(aRaw), b: Number(bRaw) }
  return { op: (opRaw as NumericQuery['op']) ?? '=', a: Number(aRaw) }
}

/** 格子里的紧凑数值：避免 6 位小数撑破 54px 宽的格子 */
function fmtCellValue(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1000) return fmtNum(v, 0)
  if (a >= 10) return fmtNum(v, 1)
  return fmtNum(v, 2)
}

// ──────────────────────────────────────────────
// Phase 3：版面坐标函数（三种布局）
// 返回 [row, col] 整数，grid 渲染
// ──────────────────────────────────────────────

/** 标准长表（18 列 × 7 周期 + 镧/锕 2 行接下方） */
function layoutStandard(z: number): [number, number] {
  return elGridPos(z)
}

/**
 * 左阶梯表（Janet left-step，32 列）：按 n+l 顺序排列，s 区在最右。
 *   列 1-14  = f 区（14）
 *   列 15-24 = d 区（10）
 *   列 25-30 = p 区（6）
 *   列 31-32 = s 区（2，最右）
 * 每行从右往左依次补满：第 2/3 周期只有 p+s，第 6/7 周期 f+d+p+s 全满。
 */
function layoutLeftStep(z: number): [number, number] {
  // 第 1 周期
  if (z === 1) return [1, 31]
  if (z === 2) return [1, 32]
  // 第 2 周期
  if (z === 3) return [2, 31]
  if (z === 4) return [2, 32]
  if (z >= 5 && z <= 10) return [2, 20 + z] // B(5)→25 … Ne(10)→30
  // 第 3 周期
  if (z === 11) return [3, 31]
  if (z === 12) return [3, 32]
  if (z >= 13 && z <= 18) return [3, 12 + z] // Al(13)→25 … Ar(18)→30
  // 第 4 周期
  if (z === 19) return [4, 31]
  if (z === 20) return [4, 32]
  if (z >= 21 && z <= 36) return [4, z - 6] // Sc(21)→15 … Zn(30)→24；Ga(31)→25 … Kr(36)→30
  // 第 5 周期
  if (z === 37) return [5, 31]
  if (z === 38) return [5, 32]
  if (z >= 39 && z <= 54) return [5, z - 24] // Y(39)→15 … Cd(48)→24；In(49)→25 … Xe(54)→30
  // 第 6 周期：Cs,Ba 在 s；La-Yb 在 f；Lu-Hg 在 d；Tl-Rn 在 p
  if (z === 55) return [6, 31]
  if (z === 56) return [6, 32]
  if (z >= 57 && z <= 86) return [6, z - 56] // La(57)→1 … Yb(70)→14；Lu(71)→15 … Hg(80)→24；Tl(81)→25 … Rn(86)→30
  // 第 7 周期：Fr,Ra 在 s；Ac-No 在 f；Lr-Cn 在 d；Nh-Og 在 p
  if (z === 87) return [7, 31]
  if (z === 88) return [7, 32]
  if (z >= 89 && z <= 118) return [7, z - 88] // Ac(89)→1 … No(102)→14；Lr(103)→15 … Cn(112)→24；Nh(113)→25 … Og(118)→30
  return layoutStandard(z)
}

/**
 * 俄语教材短表（короткопериодная форма, Менделеев）。
 *
 *  - 8 个族，第 VIII 族横跨 3 个子列：三联组 Fe/Co/Ni、Ru/Rh/Pd、Os/Ir/Pt、Hs/Mt/Ds
 *    横排（俄语教材的「побочная подгруппа」就是三条三素组），稀有气体 Kr/Xe/Rn/Og
 *    落在 VIII 族的第一个子列（Fe 的正下方）。
 *  - 第 1-3 周期各 1 行；第 4-7 周期各 2 行（上排主族 a，下排副族 б）。
 *  - 镧系 Ce-Lu、锕系 Th-Lr 各 14 格，作为条带放在表下方；La/Ac 仍留在 III 族并标 *。
 *
 * 返回 [row, col]（1 基）：row 1-11 = 第 1…7 周期（长周期占 2 行），
 * col 1-7 = I…VII 族，col 8-10 = VIII 族的 3 个子列。
 */
function layoutShortTable(z: number): [number, number] {
  // 第 1 周期
  if (z === 1) return [1, 1]
  if (z === 2) return [1, 8]
  // 第 2 周期
  if (z === 3) return [2, 1]
  if (z === 4) return [2, 2]
  if (z >= 5 && z <= 10) return [2, z - 2] // B5→3 … Ne10→8
  // 第 3 周期
  if (z === 11) return [3, 1]
  if (z === 12) return [3, 2]
  if (z >= 13 && z <= 18) return [3, z - 10] // Al13→3 … Ar18→8
  // 第 4 周期：上排 K…Mn + Fe Co Ni，下排 Cu…Br + Kr
  if (z >= 19 && z <= 28) return [4, z - 18] // K19→1 … Ni28→10
  if (z >= 29 && z <= 36) return [5, z - 28] // Cu29→1 … Kr36→8
  // 第 5 周期：上排 Rb…Tc + Ru Rh Pd，下排 Ag…I + Xe
  if (z >= 37 && z <= 46) return [6, z - 36] // Rb37→1 … Pd46→10
  if (z >= 47 && z <= 54) return [7, z - 46] // Ag47→1 … Xe54→8
  // 第 6 周期（La 57 占 III 族，对应下方镧系条带）
  if (z === 55) return [8, 1]
  if (z === 56) return [8, 2]
  if (z === 57) return [8, 3]
  if (z >= 72 && z <= 78) return [8, z - 68] // Hf72→4 … Pt78→10
  if (z >= 79 && z <= 86) return [9, z - 78] // Au79→1 … Rn86→8
  // 第 7 周期（Ac 89 占 III 族，对应下方锕系条带）
  if (z === 87) return [10, 1]
  if (z === 88) return [10, 2]
  if (z === 89) return [10, 3]
  if (z >= 104 && z <= 110) return [10, z - 100] // Rf104→4 … Ds110→10
  if (z >= 111 && z <= 118) return [11, z - 110] // Rg111→1 … Og118→8
  return layoutStandard(z)
}

/** 短表下方的 f 区条带：Ce-Lu / Th-Lr 各 14 格（La/Ac 已在主表 III 族） */
const SHORT_FBLOCK: Array<{ key: 'lanth' | 'act'; from: number; to: number }> = [
  { key: 'lanth', from: 58, to: 71 },
  { key: 'act', from: 90, to: 103 },
]

// 螺旋版面：见 src/lib/spiral.ts（Janet 左阶梯 32 列极坐标）

// ──────────────────────────────────────────────
// 辅助：格式化属性值
// ──────────────────────────────────────────────
function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '—'
  // 千分位自己拼：Workers 运行时与浏览器 ICU 版本不同时，toLocaleString 会输出
  // 不同文本，SSR 与客户端首帧不一致就会触发 React #418（text 水合失败）。
  if (Math.abs(v) >= 1000) {
    const int = Math.round(v).toString()
    const neg = int.startsWith('-')
    const body = (neg ? int.slice(1) : int).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    return neg ? `-${body}` : body
  }
  return v.toFixed(digits).replace(/\.?0+$/, '')
}

function fmtPhase(p: string, lang: 'ru' | 'zh' | 'en'): string {
  const map: Record<string, Record<string, string>> = {
    ru: { Gas: 'Газ', Liquid: 'Жидкость', Solid: 'Твёрдое', Unknown: 'Неизвестно' },
    zh: { Gas: '气体', Liquid: '液体', Solid: '固体', Unknown: '未知' },
    en: { Gas: 'Gas', Liquid: 'Liquid', Solid: 'Solid', Unknown: 'Unknown' },
  }
  return map[lang][p] ?? p
}

function fmtBlock(b: string): string {
  return `${b}-block`
}

function displayTemp(k: number | null, unit: TempUnit): string {
  if (k == null) return '—'
  if (unit === 'K') return fmtNum(k, 2)
  if (unit === 'C') return fmtNum(kelvinToCelsius(k), 2)
  return fmtNum(kelvinToFahrenheit(k), 2)
}

function displayEnergy(kj: number | null, unit: EnergyUnit): string {
  if (kj == null) return '—'
  if (unit === 'kJ') return fmtNum(kj, 2)
  return fmtNum(kjPerMolToEv(kj), 3)
}

// ──────────────────────────────────────────────
// Phase 2：根据温度判断动态相态
// mpK / bpK 缺失时退回 STP phase
// ──────────────────────────────────────────────
type DynPhase = 'Solid' | 'Liquid' | 'Gas' | 'Unknown'
function phaseAtTemp(e: Element, tempK: number): DynPhase {
  if (e.mpK == null || e.bpK == null) return 'Unknown'
  if (tempK < e.mpK) return 'Solid'
  if (tempK >= e.bpK) return 'Gas'
  return 'Liquid' // mp ≤ T < bp
}
function phaseColor(p: DynPhase): string {
  return PHASE_COLORS[p] ?? PHASE_COLORS.Unknown
}

// ──────────────────────────────────────────────
// 实物图
// 图片已全部自托管到 /elements/（与站点同源），弱网/跨境不再依赖维基或图源站。
// 104–118 只能以单个原子合成，没有可见宏观样品 → 渲染设计占位卡，不发网络请求。
// 加载失败时同样退化为占位卡，不留空框。
// ──────────────────────────────────────────────
function ElementImageCard({ el, lang }: { el: Element; lang: Lang }) {
  const [ready, setReady] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const missing = el.imagePlaceholder || !el.appearanceImgUrl || failed

  if (missing) {
    return (
      <div className="ru-el-img-card ru-el-img-ph" data-z={el.z}>
        <div className="ru-el-img-ph-glyph" aria-hidden="true">
          <span className="z">{el.z}</span>
          <span className="sym">{el.sym}</span>
        </div>
        <div className="ru-el-img-ph-body">
          <div className="ru-el-img-ph-title">
            {uiText(lang, '暂无实物照片', 'No photograph available', 'Фотография отсутствует')}
          </div>
          <p className="ru-el-img-ph-note">
            {lang === 'zh'
              ? '该元素只能以单个原子形式人工合成，至今没有可见的宏观样品。'
              : lang === 'en'
                ? 'This element has only been produced as individual atoms; no visible macroscopic sample exists.'
                : el.imageNote || 'Элемент получен лишь в единичных атомах.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ru-el-img-card" data-ready={ready ? 'true' : 'false'}>
      <img
        src={el.appearanceImgUrl}
        alt={el.appearanceImgTitle || el.en}
        width={400}
        height={400}
        decoding="async"
        onLoad={() => setReady(true)}
        onError={() => setFailed(true)}
      />
      <div className="ru-el-img-attr">
        {el.imageSourceUrl ? (
          <a href={el.imageSourceUrl} target="_blank" rel="noreferrer">
            {el.imageCredit || el.imageProvider}
          </a>
        ) : (
          <span>{el.imageCredit}</span>
        )}
        {el.imageLicense && (
          <>
            {' · '}
            {el.imageLicenseUrl ? (
              <a href={el.imageLicenseUrl} target="_blank" rel="noreferrer">{el.imageLicense}</a>
            ) : (
              <span>{el.imageLicense}</span>
            )}
          </>
        )}
        {el.appearanceImgTitle && <span className="ru-el-img-title"> — {el.appearanceImgTitle}</span>}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// Phase 2：趋势图 / 发现时间轴 / 同位素概要 / 测验
// ──────────────────────────────────────────────

/** 上标数字（用于 10⁵ 这样的量级） */
function supNum(n: number): string {
  const map: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
  }
  return String(n).split('').map((ch) => map[ch] ?? ch).join('')
}

/** 半衰期：源数据单位为「年」；不足 1 年时换天 / 小时 / 分钟 */
function fmtHalfLife(v: number, lang: Lang): string {
  if (!Number.isFinite(v) || v <= 0) return '—'
  const unit = (zh: string, en: string, ru: string) => uiText(lang, zh, en, ru)
  if (v >= 1e4) {
    const exp = Math.floor(Math.log10(v))
    const mant = v / 10 ** exp
    return `${mant.toFixed(2)}·10${supNum(exp)} ${unit('年', 'years', 'лет')}`
  }
  if (v >= 1) return `${fmtNum(v, 2)} ${unit('年', 'years', 'лет')}`
  const days = v * 365.25
  if (days >= 1) return `${fmtNum(days, 1)} ${unit('天', 'days', 'сут')}`
  const hours = days * 24
  if (hours >= 1) return `${fmtNum(hours, 1)} ${unit('小时', 'hours', 'ч')}`
  return `${fmtNum(hours * 60, 1)} ${unit('分钟', 'minutes', 'мин')}`
}

/** 同位素概要：源数据只有字符串清单 + 半衰期数值 */
function isotopeSummary(e: Element) {
  const split = (s: string) =>
    s && s !== 'None' ? s.split(',').map((x) => x.trim()).filter(Boolean) : []
  return {
    known: split(e.isoKnown),
    stable: split(e.isoStable),
    abundance: e.isoAbund && e.isoAbund !== 'None' ? e.isoAbund : '',
  }
}

// ── 趋势图 ──
type TrendMode = 'z' | 'period' | 'group'
interface TrendPoint { x: number; y: number; e: Element }
interface TrendSeries { key: string; label: string; color?: string; points: TrendPoint[] }

const PERIOD_HUES = [200, 168, 140, 88, 46, 22, 350]

function buildTrend(mode: TrendMode, getter: (e: Element) => number | null): TrendSeries[] {
  const push = (out: TrendPoint[], e: Element, x: number) => {
    const y = getter(e)
    if (y != null && Number.isFinite(y)) out.push({ x, y, e })
  }

  if (mode === 'z') {
    const pts: TrendPoint[] = []
    for (const e of ELEMENTS) push(pts, e, e.z)
    return [{ key: 'z', label: '', points: pts }]
  }

  const series: TrendSeries[] = []
  if (mode === 'period') {
    // 横轴 = 族；镧系/锕系只保留 La/Ac（其余 14 个会挤在同一列）
    for (let p = 1; p <= 7; p++) {
      const pts: TrendPoint[] = []
      for (const e of ELEMENTS) {
        if (e.period !== p || !e.group) continue
        if (e.block === 'f' && e.z !== 57 && e.z !== 89) continue
        push(pts, e, e.group)
      }
      pts.sort((a, b) => a.x - b.x)
      if (pts.length) {
        series.push({
          key: `p${p}`, label: `P${p}`,
          color: `hsl(${PERIOD_HUES[p - 1]}, 68%, 58%)`,
          points: pts,
        })
      }
    }
    return series
  }

  // 横轴 = 周期；每个族一条线（III 族含 Sc/Y/La/Ac）
  for (let g = 1; g <= 18; g++) {
    const pts: TrendPoint[] = []
    for (const e of ELEMENTS) {
      if (e.group !== g) continue
      if (e.block === 'f' && e.z !== 57 && e.z !== 89) continue
      push(pts, e, e.period)
    }
    pts.sort((a, b) => a.x - b.x)
    if (pts.length) {
      series.push({
        key: `g${g}`, label: `G${g}`,
        color: `hsl(${Math.round((g - 1) * 20)}, 62%, 60%)`,
        points: pts,
      })
    }
  }
  return series
}

function fmtAxis(v: number): string {
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}k`
  if (a >= 100) return v.toFixed(0)
  if (a >= 1) return v.toFixed(1)
  if (a >= 0.01) return v.toFixed(2)
  return v.toExponential(0)
}

function TrendChart({ uiLang, elLang, onSelect }: { uiLang: Lang; elLang: Lang; onSelect: (e: Element) => void }) {
  const [mode, setMode] = React.useState<TrendMode>('z')
  const [fieldKey, setFieldKey] = React.useState<PropKey>('eneg')
  const [log, setLog] = React.useState(false)
  const field = COLOR_FIELDS.find((f) => f.key === fieldKey)!
  const series = React.useMemo(() => buildTrend(mode, field.getter), [mode, field])
  const [minV, maxV] = React.useMemo(() => {
    const vals = series.flatMap((s) => s.points.map((p) => p.y))
    if (!vals.length) return [0, 1] as [number, number]
    return [Math.min(...vals), Math.max(...vals)] as [number, number]
  }, [series])
  const canLog = minV > 0
  const useLog = log && canLog

  const W = 880, H = 260, PL = 58, PR = 14, PT = 14, PB = 32
  const rawMin = useLog ? Math.log10(minV) : minV
  const rawMax = useLog ? Math.log10(maxV) : maxV
  let yMin = rawMin
  let yMax = rawMax
  if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1 }
  else { const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad }

  const xDomain: [number, number] = mode === 'z' ? [1, 118] : mode === 'period' ? [0.5, 18.5] : [0.5, 7.5]
  const sx = (x: number) => PL + ((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * (W - PL - PR)
  const sy = (y: number) => PT + (1 - (y - yMin) / (yMax - yMin)) * (H - PT - PB)
  const py = (v: number) => sy(useLog ? Math.log10(v) : v)

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const raw = yMin + (yMax - yMin) * t
    return { y: sy(raw), label: fmtAxis(useLog ? 10 ** raw : raw) }
  })
  const xTicks = mode === 'z'
    ? [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 118]
    : mode === 'period'
      ? Array.from({ length: 18 }, (_, i) => i + 1)
      : [1, 2, 3, 4, 5, 6, 7]

  const gapThreshold = mode === 'z' ? 2.5 : 1.4
  const segments = (pts: TrendPoint[]) => {
    const out: TrendPoint[][] = []
    let cur: TrendPoint[] = []
    for (const p of pts) {
      if (cur.length && p.x - cur[cur.length - 1].x > gapThreshold) { out.push(cur); cur = [] }
      cur.push(p)
    }
    if (cur.length) out.push(cur)
    return out
  }

  return (
    <div className="ru-trend">
      <div className="ru-trend-head">
        <strong>{uiText(uiLang, '性质趋势', 'Property trends', 'Тренды свойств')}</strong>
        <div className="ru-el-ctrl-group">
          <button type="button" className={mode === 'z' ? 'active' : ''} onClick={() => setMode('z')}>
            {uiText(uiLang, '按序号', 'by Z', 'по Z')}
          </button>
          <button type="button" className={mode === 'period' ? 'active' : ''} onClick={() => setMode('period')}>
            {uiText(uiLang, '按族', 'by group', 'по группе')}
          </button>
          <button type="button" className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>
            {uiText(uiLang, '按周期', 'by period', 'по периоду')}
          </button>
        </div>
        <select
          className="ru-el-field-select"
          value={fieldKey}
          onChange={(ev) => {
            const k = ev.target.value as PropKey
            setFieldKey(k)
            setLog(COLOR_FIELDS.find((f) => f.key === k)?.log === true)
          }}
          aria-label={uiText(uiLang, '趋势字段', 'Property', 'Свойство')}
        >
          {COLOR_FIELDS.map((f) => (
            <option key={f.key} value={f.key}>{f[elLang]}</option>
          ))}
        </select>
        {canLog && (
          <button type="button" className={log ? 'active' : ''} onClick={() => setLog((v) => !v)}>
            log
          </button>
        )}
        <span className="ru-trend-hint">
          {uiText(uiLang, '点击数据点查看元素', 'Click a point to open the element', 'Нажмите точку')}
        </span>
      </div>
      <div className="ru-trend-scroll">
        <svg className="ru-trend-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={uiText(uiLang, '元素性质趋势图', 'Element property chart', 'График свойств элементов')}>
          {yTicks.map((t, i) => (
            <g key={`y${i}`}>
              <line className="ru-trend-grid" x1={PL} y1={t.y} x2={W - PR} y2={t.y} />
              <text className="ru-trend-axis" x={PL - 6} y={t.y + 3} textAnchor="end">{t.label}</text>
            </g>
          ))}
          {series.map((s) => (
            <g key={s.key}>
              {segments(s.points).map((seg, i) => (
                <polyline
                  key={`l${i}`}
                  className="ru-trend-line"
                  style={s.color ? { stroke: s.color } : undefined}
                  points={seg.map((p) => `${sx(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')}
                />
              ))}
              {s.points.map((p) => (
                <circle
                  key={p.e.z}
                  className="ru-trend-dot"
                  data-c={p.e.cat}
                  cx={sx(p.x)}
                  cy={py(p.y)}
                  r={3.2}
                  role="button"
                  tabIndex={0}
                  aria-label={`${p.e.z} ${p.e.sym} — ${fmtNum(p.y, 3)}`}
                  onClick={() => onSelect(p.e)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(p.e) }
                  }}
                >
                  <title>{`${p.e.z} ${p.e.sym} · ${elText(elLang, p.e)} — ${fmtNum(p.y, 4)}`}</title>
                </circle>
              ))}
            </g>
          ))}
          {xTicks.map((x) => (
            <text key={`x${x}`} className="ru-trend-axis" x={sx(x)} y={H - 8} textAnchor="middle">{x}</text>
          ))}
          <text className="ru-trend-axis-title" x={(PL + W - PR) / 2} y={H - 1} textAnchor="middle">
            {mode === 'z'
              ? 'Z'
              : mode === 'period'
                ? uiText(uiLang, '族', 'Group', 'группа')
                : uiText(uiLang, '周期', 'Period', 'период')}
          </text>
        </svg>
      </div>
      {mode === 'period' && (
        <div className="ru-trend-legend">
          {series.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>
          ))}
          <em>{uiText(uiLang, '镧系/锕系只取 La/Ac，避免同列重叠', 'Only La/Ac from the f-block to avoid overlap', 'из f-блока только La/Ac')}</em>
        </div>
      )}
      {mode === 'group' && (
        <div className="ru-trend-note">
          {uiText(uiLang, '每个族一条线，横轴为周期 1–7', 'One line per group, x-axis: periods 1–7', 'Одна линия — одна группа, по оси X периоды 1–7')}
        </div>
      )}
    </div>
  )
}

// ── 发现时间轴 ──
function DiscoveryTimeline({ uiLang, elLang, onSelect, year, onYearChange }: {
  uiLang: Lang
  elLang: Lang
  onSelect: (e: Element) => void
  year: number | null
  onYearChange: (y: number | null) => void
}) {
  const { bins, ancient } = React.useMemo(() => {
    const map = new Map<number, Element[]>()
    const old: Element[] = []
    for (const e of ELEMENTS) {
      if (e.discYear == null) continue
      if (e.discYear < 1500) { old.push(e); continue }
      const k = Math.floor(e.discYear / 10) * 10
      const arr = map.get(k) ?? []
      arr.push(e)
      map.set(k, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => (a.discYear ?? 0) - (b.discYear ?? 0))
    old.sort((a, b) => (a.discYear ?? 0) - (b.discYear ?? 0))
    return { bins: [...map.entries()].sort((a, b) => a[0] - b[0]), ancient: old }
  }, [])

  const W = 900, H = 200, PL = 86, PR = 16, PT = 14, PB = 28
  const x = (year: number) => PL + ((year - 1500) / (2010 - 1500)) * (W - PL - PR)
  const baseY = H - PB
  // 窄屏默认把视口滚到 19 世纪（元素发现最密集的一段），否则首屏几乎空白
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) * 0.8)
  }, [])

  const makeNode = (e: Element, cx: number, cy: number) => (
    <g
      key={e.z}
      className="ru-tl-node"
      role="button"
      tabIndex={0}
      aria-label={`${e.z} ${e.sym} (${e.discYear})`}
      onClick={() => onSelect(e)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(e) }
      }}
    >
      <circle className="ru-tl-dot" data-c={e.cat} cx={cx} cy={cy} r={4.2} />
      <title>{`${e.z} ${e.sym} · ${elText(elLang, e)} — ${e.discYear}${e.discYear != null && e.discYear < 0 ? uiText(uiLang, '（公元前）', ' BC', ' до н.э.') : ''}`}</title>
    </g>
  )

  const discovered = React.useMemo(
    () => (year == null ? ELEMENTS.length : ELEMENTS.filter((e) => e.discYear == null || e.discYear <= year).length),
    [year],
  )

  return (
    <div className="ru-tl">
      <div className="ru-trend-head">
        <strong>{uiText(uiLang, '发现时间轴', 'Discovery timeline', 'Хронология открытий')}</strong>
        <span className="ru-trend-hint">
          {uiText(uiLang, '1500–2010 · 点击圆点查看元素', '1500–2010 · click a dot to open the element', '1500–2010 · нажмите точку')}
        </span>
      </div>

      {/* 时间机器：拖到某一年，表格只保留该年之前已发现的元素 */}
      <div className="ru-tl-machine">
        <label htmlFor="ru-tl-year">{uiText(uiLang, '时间机器', 'Time machine', 'Машина времени')}</label>
        <input
          id="ru-tl-year"
          type="range"
          min={1500}
          max={2015}
          step={1}
          value={year ?? 2015}
          onChange={(ev) => {
            const v = Number(ev.target.value)
            onYearChange(v >= 2015 ? null : v)
          }}
          aria-label={uiText(uiLang, '选择发现年份', 'Choose a discovery year', 'Выберите год открытия')}
        />
        <span className="ru-tl-machine-val">
          {year == null ? uiText(uiLang, '全部', 'All', 'Все') : `${year}`}
        </span>
        <span className="ru-tl-machine-count" aria-live="polite">{discovered}/118</span>
        {year != null && (
          <button type="button" onClick={() => onYearChange(null)}>
            {uiText(uiLang, '重置', 'Reset', 'Сброс')}
          </button>
        )}
      </div>
      <p className="ru-tl-machine-hint">
        {uiText(
          uiLang,
          '未在该年份前发现的元素会变淡；古代元素始终保留。',
          'Elements not yet discovered fade out; ancient elements stay visible.',
          'Неоткрытые к этому году элементы бледнеют; древние остаются.',
        )}
      </p>

      <div className="ru-tl-scroll" ref={scrollRef}>
        <svg className="ru-tl-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={uiText(uiLang, '元素发现时间轴', 'Element discovery timeline', 'Хронология открытий элементов')}>
          {/* 古代元素（公元前 – 1500） */}
          <text className="ru-trend-axis-title" x={20} y={PT} textAnchor="start">
            {uiText(uiLang, '古代', 'Ancient', 'др.')}
          </text>
          <line className="ru-trend-grid" x1={PL - 12} y1={PT} x2={PL - 12} y2={baseY} />
          {ancient.map((e, i) => makeNode(e, 20 + Math.floor(i / 7) * 18, baseY - 10 - (i % 7) * 12))}

          {/* 年代网格 + 刻度（2000 与 2010 的标签会挤在一起，年份标到 2000 为止） */}
          {Array.from({ length: 11 }, (_, i) => 1500 + i * 50).map((yr) => (
            <g key={yr}>
              <line className="ru-tl-grid" x1={x(yr)} y1={PT + 4} x2={x(yr)} y2={baseY} />
              {yr < 2000 && (
                <text className="ru-trend-axis" x={x(yr)} y={H - 8} textAnchor="middle">{yr}</text>
              )}
            </g>
          ))}
          <line className="ru-tl-grid" x1={x(2010)} y1={PT + 4} x2={x(2010)} y2={baseY} />
          <line className="ru-trend-grid" x1={PL} y1={baseY} x2={W - PR} y2={baseY} />
          <text className="ru-trend-axis-title" x={W - PR} y={H - 8} textAnchor="end">2010</text>

          {/* 时间机器游标：与上方滑杆联动 */}
          {year != null && (
            <g>
              <line
                className="ru-tl-yearline"
                x1={x(Math.min(2010, Math.max(1500, year)))}
                y1={PT}
                x2={x(Math.min(2010, Math.max(1500, year)))}
                y2={baseY}
              />
              <text
                className="ru-tl-yearlabel"
                x={x(Math.min(2010, Math.max(1500, year)))}
                y={PT + 10}
                textAnchor="middle"
              >{year}</text>
            </g>
          )}

          {/* 按十年分桶向上堆叠，避免同年元素互相遮挡 */}
          {bins.map(([decade, list]) =>
            list.map((e, i) => makeNode(e, x(Math.min(2010, e.discYear ?? decade)), baseY - 10 - i * 10)),
          )}
        </svg>
      </div>
    </div>
  )
}

// ── 测验 ──
type QuizKind = 'sym2name' | 'name2sym' | 'position'
interface QuizQuestion {
  kind: QuizKind
  prompt: string
  options: string[]
  answer: string
  el: Element
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function buildQuiz(uiLang: Lang, elLang: Lang): QuizQuestion[] {
  const nameOf = (e: Element) => elText(elLang, e)
  const posOf = (e: Element) => `${e.period} / ${e.group || '—'}`
  const kinds: QuizKind[] = ['sym2name', 'name2sym', 'position']
  // f 区元素的「周期 / 族」是 6 / —，不适合作为位置题；其余 104 个元素足够出题
  const pool = shuffle(ELEMENTS.filter((e) => e.block !== 'f'))
  const questions: QuizQuestion[] = []

  for (let i = 0; i < 10; i++) {
    const el = pool[i]
    const kind = kinds[i % kinds.length]
    let prompt = ''
    let answer = ''
    const options: string[] = []

    if (kind === 'sym2name') {
      prompt = `${el.sym} — ${uiText(uiLang, '这是什么元素？', 'Which element is this?', 'Какой это элемент?')}`
      answer = nameOf(el)
      const others = shuffle(ELEMENTS.filter((e) => e.z !== el.z && nameOf(e) !== answer))
      options.push(answer, ...others.slice(0, 3).map(nameOf))
    } else if (kind === 'name2sym') {
      prompt = `${nameOf(el)} — ${uiText(uiLang, '元素符号是？', 'What is its symbol?', 'Какой символ?')}`
      answer = el.sym
      const others = shuffle(ELEMENTS.filter((e) => e.z !== el.z && e.sym !== answer))
      options.push(answer, ...others.slice(0, 3).map((e) => e.sym))
    } else {
      prompt = `${el.sym} (${nameOf(el)}) — ${uiText(uiLang, '周期 / 族？', 'period / group?', 'период / группа?')}`
      answer = posOf(el)
      const others = shuffle(ELEMENTS.filter((e) => e.z !== el.z && posOf(e) !== answer))
      options.push(answer, ...others.slice(0, 3).map(posOf))
    }

    const uniq = [...new Set(options)].slice(0, 4)
    while (uniq.length < 4) {
      const filler = shuffle(ELEMENTS)[0]
      const v = kind === 'position' ? posOf(filler) : kind === 'name2sym' ? filler.sym : nameOf(filler)
      if (!uniq.includes(v)) uniq.push(v)
    }

    questions.push({ kind, prompt, options: shuffle(uniq), answer, el })
  }
  return questions
}

function QuizModal({ uiLang, elLang, onClose, onSelect }: {
  uiLang: Lang
  elLang: Lang
  onClose: () => void
  onSelect: (e: Element) => void
}) {
  const [round, setRound] = React.useState(0)
  const [qs, setQs] = React.useState<QuizQuestion[]>(() => buildQuiz(uiLang, elLang))
  const [idx, setIdx] = React.useState(0)
  const [picked, setPicked] = React.useState<string | null>(null)
  const [score, setScore] = React.useState(0)
  const [wrong, setWrong] = React.useState<Array<{ q: QuizQuestion; picked: string }>>([])

  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const done = idx >= qs.length
  const q = done ? null : qs[idx]

  function pick(opt: string) {
    if (picked || !q) return
    setPicked(opt)
    if (opt === q.answer) setScore((s) => s + 1)
    else setWrong((w) => [...w, { q, picked: opt }])
  }

  function next() {
    setPicked(null)
    setIdx((i) => i + 1)
  }

  function restart() {
    setQs(buildQuiz(uiLang, elLang))
    setIdx(0)
    setPicked(null)
    setScore(0)
    setWrong([])
    setRound((r) => r + 1)
  }

  return (
    <>
      <div className="ru-el-cmp-scrim" onClick={onClose} aria-hidden="true" />
      <div className="ru-el-cmp-modal ru-quiz-modal" role="dialog" aria-modal="true" aria-label={uiText(uiLang, '元素测验', 'Element quiz', 'Тест по элементам')}>
        <div className="ru-el-cmp-modal-head">
          <strong>
            {uiText(uiLang, '元素测验', 'Element quiz', 'Тест')} · {Math.min(idx + 1, qs.length)}/{qs.length}
            <span className="ru-quiz-score-inline"> {score}</span>
          </strong>
          <button type="button" onClick={onClose} aria-label={uiText(uiLang, '关闭测验', 'Close quiz', 'Закрыть')}>✕</button>
        </div>
        <div className="ru-quiz-body" key={round}>
          <div className="ru-quiz-progress">
            <i style={{ width: `${(Math.min(idx, qs.length) / qs.length) * 100}%` }} />
          </div>

          {done ? (
            <>
              <div className="ru-quiz-done">
                <span className="ru-quiz-score">{score} / {qs.length}</span>
                <span>{uiText(uiLang, '答对题数', 'correct answers', 'правильных ответов')}</span>
              </div>
              {wrong.length > 0 ? (
                <div className="ru-quiz-wrong">
                  <strong>{uiText(uiLang, '错题回顾', 'Review mistakes', 'Разбор ошибок')}</strong>
                  {wrong.map((w, i) => (
                    <button key={`${w.q.el.z}-${i}`} type="button" onClick={() => { onSelect(w.q.el); onClose() }}>
                      <span className="sym">{w.q.el.sym}</span>
                      <span>{w.q.prompt}</span>
                      <span className="bad">{w.picked}</span>
                      <span className="ok">✓ {w.q.answer}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="ru-trend-note">{uiText(uiLang, '全部答对，太棒了。', 'All correct — well done.', 'Всё верно, отлично.')}</p>
              )}
              <div className="ru-quiz-foot">
                <button type="button" className="ru-quiz-next" onClick={restart}>
                  {uiText(uiLang, '再测一次', 'Try again', 'Ещё раз')}
                </button>
                <button type="button" className="ru-quiz-next ghost" onClick={onClose}>
                  {uiText(uiLang, '关闭', 'Close', 'Закрыть')}
                </button>
              </div>
            </>
          ) : q && (
            <>
              <div className="ru-quiz-prompt">{q.prompt}</div>
              <div className="ru-quiz-opts">
                {q.options.map((opt) => {
                  const state = !picked ? '' : opt === q.answer ? ' ok' : opt === picked ? ' bad' : ' muted'
                  return (
                    <button
                      key={opt}
                      type="button"
                      className={`ru-quiz-opt${state}`}
                      disabled={!!picked}
                      onClick={() => pick(opt)}
                    >
                      {opt}
                    </button>
                  )
                })}
              </div>
              <div className="ru-quiz-foot">
                <span className="ru-quiz-note">
                  {picked
                    ? (picked === q.answer
                        ? uiText(uiLang, '✓ 正确', '✓ Correct', '✓ Верно')
                        : uiText(uiLang, `✕ 正确答案：${q.answer}`, `✕ Correct answer: ${q.answer}`, `✕ Верно: ${q.answer}`))
                    : uiText(uiLang, '选择一个答案', 'Pick an answer', 'Выберите ответ')}
                </span>
                <button type="button" className="ru-quiz-next" disabled={!picked} onClick={next}>
                  {idx === qs.length - 1
                    ? uiText(uiLang, '查看结果', 'See results', 'Результат')
                    : uiText(uiLang, '下一题', 'Next', 'Далее')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// ──────────────────────────────────────────────
// 主组件
// ──────────────────────────────────────────────
export function PeriodicTable() {
  // ?el=Fe / ?el=26 深链：SSR 首帧就选中，刷新与分享后仍保持
  const routeSearch = useSearch({ strict: false }) as { el?: string }
  const deepLinkEl = React.useMemo(() => findElementByToken(routeSearch.el), [routeSearch.el])
  const [sel, setSel] = React.useState<Element | null>(deepLinkEl)
  // 检索：符号 / 序号 / 中俄英名称子串；匹配项高亮，其余降透明度
  const [query, setQuery] = React.useState('')
  const searchRef = React.useRef<HTMLInputElement | null>(null)
  // 桌面悬停速览：鼠标移入/键盘聚焦时在右侧空栏预览，不触发朗读
  const [hoverZ, setHoverZ] = React.useState<number | null>(null)
  // 对比：最多 4 个元素
  const [compare, setCompare] = React.useState<number[]>([])
  const [cmpOpen, setCmpOpen] = React.useState(false)
  const [copiedZ, setCopiedZ] = React.useState<number | null>(null)
  // 语言/版面必须用 SSR 默认值初始化，挂载后再从 localStorage 恢复，
  // 否则首帧 SSR 与客户端不一致会触发 React #418 水合报错。
  // 界面语言跟随全站切换器；元素名称语言默认跟随界面，也可在表头单独覆盖。
  // 两者分开后，俄语界面里也能把元素名显示成中文/英文，不再互相绑死。
  const uiLang = useLang()
  const [elLangPref, setElLangPref] = React.useState<'auto' | Lang>('auto')
  const elLang: Lang = elLangPref === 'auto' ? uiLang : elLangPref
  // 持久化放在点击时直接写入，而不是放进 effect：
  // React StrictMode 会重复执行挂载 effect，恢复读到的值会被「默认 auto」的写入覆盖。
  const changeElLangPref = React.useCallback((v: 'auto' | Lang) => {
    setElLangPref(v)
    try { localStorage.setItem('sg-pt-el-lang', v) } catch { /* ignore */ }
  }, [])
  // 版面偏好同理：直接写入，避免挂载 effect 在 StrictMode 下把恢复值覆盖回默认。
  const changeLayout = React.useCallback((v: LayoutMode) => {
    setLayoutMode(v)
    try { localStorage.setItem('sg-ru-pt-layout', v) } catch { /* ignore */ }
  }, [])
  const [colorMode, setColorMode] = React.useState<ColorMode>('cat')
  const [colorField, setColorField] = React.useState<PropKey>('eneg')
  const [colorLog, setColorLog] = React.useState(false)
  // 选中数值字段时，把属性值写进每个格子（默认只着色，不改原有信息层级）
  const [showCellValue, setShowCellValue] = React.useState(false)
  const changeCellValue = React.useCallback((v: boolean) => {
    setShowCellValue(v)
    try { localStorage.setItem('sg-pt-cell-value', v ? '1' : '0') } catch { /* ignore */ }
  }, [])
  // 阈值滑杆：低于阈值的元素变淡；null 表示不过滤
  const [fieldThreshold, setFieldThreshold] = React.useState<number | null>(null)
  // 离开数值字段模式时清掉阈值，避免“看不见的过滤”继续生效
  React.useEffect(() => {
    if (colorMode !== 'field') setFieldThreshold(null)
  }, [colorMode])
  const [highlightBlock, setHighlightBlock] = React.useState<string | null>(null) // 's'|'p'|'d'|'f'
  const [highlightSeries, setHighlightSeries] = React.useState<Cat | null>(null)
  const tempUnitState = React.useState<TempUnit>('K')
  const tempUnit: TempUnit = tempUnitState[0]
  const setTempUnit = tempUnitState[1]
  // energyUnit 暂不提供前端切换（可后续加到 UI 控制栏）
  const energyUnit: EnergyUnit = 'kJ'
  const [listView, setListView] = React.useState(false)
  const [noVoice, setNoVoice] = React.useState(false)
  // 首屏是服务端直出的表格，但事件要等水合完成才生效。这段时间给出明确提示，
  // 避免用户点击后误以为坏了（水合一旦失败也不会挡住内容阅读）。
  const [booted, setBooted] = React.useState(false)
  React.useEffect(() => { setBooted(true) }, [])
  // 手机横屏：把整个面板旋转 90° 铺满竖屏视口。不依赖 Screen Orientation API
  //（iOS Safari 不支持），设备真的转成横屏后由 media query 取消旋转，交还原生布局。
  const [land, setLand] = React.useState(false)
  // 横屏（transform 模式 / 设备真横屏）下，控制栏+图例收进 FAB 浮层，省垂直空间。
  // 竖屏时 fabOpen 恒等于 false（浮层永远不显示）。
  const [fabOpen, setFabOpen] = React.useState(false)
  React.useEffect(() => {
    if (!fabOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFabOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fabOpen])
  // 切回竖屏/退出横屏时自动收起浮层（防止残留）
  React.useEffect(() => { if (!land) setFabOpen(false) }, [land])
  React.useEffect(() => {
    if (!land) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [land])
  // 用系统手势退出全屏时同步退出横屏，避免留下一个空的定位面板
  React.useEffect(() => {
    if (!land) return
    const onFs = () => { if (!document.fullscreenElement) setLand(false) }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [land])
  async function toggleLand() {
    if (land) {
      setLand(false)
      if (document.fullscreenElement) {
        try { await document.exitFullscreen() } catch { /* ignore */ }
      }
      return
    }
    setLand(true)
    // 尽量隐藏地址栏；不支持（iOS）或被拒绝时忽略，CSS 旋转照样生效
    try { await document.documentElement.requestFullscreen?.() } catch { /* ignore */ }
  }
  // Phase 2：温度游标（摄氏度，范围 -100 到 6000，默认 25 = STP）
  const [tempCurC, setTempCurC] = React.useState<number>(25)
  // Phase 3：版面模式
  const [layoutMode, setLayoutMode] = React.useState<LayoutMode>('standard')
  // P2：趋势图 / 时间轴 / 测验（默认关闭，SSR 首帧一致）
  const [trendOpen, setTrendOpen] = React.useState(false)
  const [tlOpen, setTlOpen] = React.useState(false)
  const [quizOpen, setQuizOpen] = React.useState(false)
  // 时间机器：只保留该年份之前已发现的元素；null = 全部
  const [timeYear, setTimeYear] = React.useState<number | null>(null)
  // 挂载后恢复偏好（仅客户端执行），避免水合不一致
  const prefsLoaded = React.useRef(false)
  React.useEffect(() => {
    try {
      const el = localStorage.getItem('sg-pt-el-lang')
      if (el === 'auto' || el === 'zh' || el === 'en' || el === 'ru') setElLangPref(el)
      // 旧版只有一个 RU/CN 开关，键已废弃，顺手清理
      localStorage.removeItem('sg-ru-pt-ver')
      const l = localStorage.getItem('sg-ru-pt-layout')
      if (l === 'standard' || l === 'leftstep' || l === 'short' || l === 'spiral') setLayoutMode(l)
      if (localStorage.getItem('sg-pt-cell-value') === '1') setShowCellValue(true)
    } catch { /* ignore */ }
    prefsLoaded.current = true
  }, [])

  // 左阶梯右端才是 s 区（H/He）。窄屏下表格必然要横向滚动，
  // 若停在最左侧，首屏只能看到第 1-5 行的空白前缀，看起来像没排好。
  const gridWrapRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = gridWrapRef.current
    if (!el) return
    if (layoutMode === 'leftstep') { el.scrollLeft = el.scrollWidth }
    else { el.scrollLeft = 0 }
  }, [layoutMode])

  // 计算色阶范围（当前字段）
  const fieldRangeMemo = React.useMemo(() => {
    const f = COLOR_FIELDS.find((x) => x.key === colorField)!
    return fieldRange(f.getter)
  }, [colorField])

  const fieldMin = fieldRangeMemo.min
  const fieldMax = fieldRangeMemo.max
  const currentFieldDef = COLOR_FIELDS.find((x) => x.key === colorField)!
  const fieldGetter = currentFieldDef.getter
  const fieldUnit = FIELD_UNITS[colorField] ?? ''
  const fieldLabel = currentFieldDef[elLang]
  const numericQuery = React.useMemo(() => parseNumericQuery(query), [query])

  const groups = elLang === 'ru' ? GROUP_LABELS_RU : GROUP_LABELS_CN
  const tempCurK = tempCurC + 273.15

  // 格子颜色
  function cellBg(e: Element): string {
    if (colorMode === 'temp') return phaseColor(phaseAtTemp(e, tempCurK))
    if (colorMode === 'phase') return PHASE_COLORS[e.phase] ?? '#d4d4d4'
    if (colorMode === 'cat') return '' // 由 CSS data-c 处理
    // field
    const v = fieldGetter(e)
    return colorScale(v, fieldMin, fieldMax, 220, 0, colorLog) ?? '#e8e8e8'
  }

  // 检索命中集合：null 表示未搜索；支持 >1000 / 400-800 / ~200 这类数值表达式
  const searchHits = React.useMemo(() => {
    const raw = query.trim()
    if (!raw) return null
    const nq = parseNumericQuery(raw)
    const hits = new Set<number>()
    if (nq) {
      const getter = COLOR_FIELDS.find((x) => x.key === colorField)!.getter
      if (nq.op === '~') {
        // 最近值：只命中一个，适合「~200」快速定位
        let bestZ: number | null = null
        let bestD = Infinity
        for (const e of ELEMENTS) {
          const v = getter(e)
          if (v == null) continue
          const d = Math.abs(v - nq.a)
          if (d < bestD) { bestD = d; bestZ = e.z }
        }
        if (bestZ != null) hits.add(bestZ)
        return hits
      }
      const lo = nq.op === 'range' ? Math.min(nq.a, nq.b ?? nq.a) : nq.a
      const hi = nq.op === 'range' ? Math.max(nq.a, nq.b ?? nq.a) : nq.a
      for (const e of ELEMENTS) {
        const v = getter(e)
        if (v == null) continue
        const ok =
          nq.op === 'range' ? v >= lo && v <= hi
            : nq.op === '>' ? v > nq.a
              : nq.op === '>=' ? v >= nq.a
                : nq.op === '<' ? v < nq.a
                  : nq.op === '<=' ? v <= nq.a
                    : Math.abs(v - nq.a) < 1e-9
        if (ok) hits.add(e.z)
      }
      return hits
    }
    const q = raw.toLowerCase()
    for (const e of ELEMENTS) {
      if (
        e.sym.toLowerCase().includes(q) ||
        e.en.toLowerCase().includes(q) ||
        e.ru.toLowerCase().includes(q) ||
        e.zh.includes(q) ||
        String(e.z).includes(q)
      ) hits.add(e.z)
    }
    return hits
  }, [query, colorField])

  // 选中/高亮判断
  function isDimmed(e: Element): boolean {
    if (searchHits && !searchHits.has(e.z)) return true
    if (timeYear != null && e.discYear != null && e.discYear > timeYear) return true
    if (fieldThreshold != null) {
      const v = fieldGetter(e)
      if (v == null || v < fieldThreshold) return true
    }
    if (highlightBlock && e.block !== highlightBlock) return true
    if (highlightSeries && e.cat !== highlightSeries) return true
    return false
  }

  // 温度游标恰好落在某个元素的熔点/沸点附近时给出相变提示
  const transitions = React.useMemo(() => {
    if (colorMode !== 'temp') return []
    const out: Array<{ e: Element; kind: 'melt' | 'boil' }> = []
    for (const e of ELEMENTS) {
      if (e.mpK != null && Math.abs(e.mpK - tempCurK) <= 5) out.push({ e, kind: 'melt' })
      else if (e.bpK != null && Math.abs(e.bpK - tempCurK) <= 5) out.push({ e, kind: 'boil' })
    }
    return out.slice(0, 5)
  }, [colorMode, tempCurK])

  // 方向键导航：网格坐标 → 上下左右移动焦点（螺旋版面交给原生 Tab）
  const navPos = React.useMemo(() => {
    const map = new Map<number, [number, number]>()
    for (const e of ELEMENTS) {
      let row: number, col: number
      if (layoutMode === 'leftstep') { [row, col] = layoutLeftStep(e.z) }
      else if (layoutMode === 'short') { [row, col] = layoutShortTable(e.z) }
      else { [row, col] = layoutStandard(e.z) }
      map.set(e.z, [row, col])
    }
    if (layoutMode === 'short') {
      // 短表 f 区条带另起两行（12/13），方向键可以下移进入
      SHORT_FBLOCK.forEach((g, gi) => {
        for (let z = g.from; z <= g.to; z++) map.set(z, [12 + gi, z - g.from + 1])
      })
    }
    return map
  }, [layoutMode])

  function onGridKeyDown(ev: React.KeyboardEvent<HTMLDivElement>) {
    if (layoutMode === 'spiral') return
    const dirs: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    }
    const dir = dirs[ev.key]
    if (!dir) {
      // Home / End：跳到第一个 / 最后一个元素，长表里少用滚动
      if (ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault()
        const targetZ = ev.key === 'Home' ? 1 : 118
        const target = gridWrapRef.current?.querySelector<HTMLElement>(`.ru-el[data-z="${targetZ}"]`)
          ?? document.querySelector<HTMLElement>(`.ru-el[data-z="${targetZ}"]`)
        target?.focus()
      }
      return
    }
    const active = document.activeElement as HTMLElement | null
    const z = Number(active?.dataset?.z)
    if (!z) return
    const from = navPos.get(z)
    if (!from) return
    ev.preventDefault()
    let bestZ: number | null = null
    let bestScore = Infinity
    navPos.forEach((pos, cand) => {
      if (cand === z) return
      const dy = pos[0] - from[0]
      const dx = pos[1] - from[1]
      const proj = dy * dir[0] + dx * dir[1]
      if (proj <= 0) return
      const perp = Math.abs(dy * dir[1] - dx * dir[0])
      const score = proj + perp * 2.2
      if (score < bestScore) { bestScore = score; bestZ = cand }
    })
    if (bestZ != null) {
      const target = gridWrapRef.current?.querySelector<HTMLElement>(`.ru-el[data-z="${bestZ}"]`)
        ?? document.querySelector<HTMLElement>(`.ru-el[data-z="${bestZ}"]`)
      target?.focus()
    }
  }

  // 地址栏同步：?el= 便于刷新 / 复制分享；用 replaceState，避免每次点元素都产生历史记录
  function syncUrl(e: Element | null) {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (e) url.searchParams.set('el', e.sym)
    else url.searchParams.delete('el')
    window.history.replaceState(window.history.state, '', url)
  }
  function select(e: Element | null) {
    setSel(e)
    syncUrl(e)
  }

  async function say(e: Element) {
    select(e)
    // 按当前元素语言播放：优先自托管真人录音，缺失时用浏览器语音合成兜底
    if (!(await playElementName(e.z, elText(elLang, e), elLang))) setNoVoice(true)
  }

  function toggleCompare(z: number) {
    setCompare((cur) => {
      if (cur.includes(z)) return cur.filter((x) => x !== z)
      return cur.length >= 4 ? cur : [...cur, z]
    })
  }

  async function copyLink(e: Element) {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    url.searchParams.set('el', e.sym)
    const text = url.toString()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 非安全上下文 / 旧浏览器回退
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      ta.remove()
    }
    setCopiedZ(e.z)
    window.setTimeout(() => setCopiedZ((cur) => (cur === e.z ? null : cur)), 1800)
  }

  // "/" 聚焦表内搜索；Esc 先清空搜索，再收起面板。
  // Ctrl/⌘+K 永远留给站点全局搜索：周期表不再抢占它，否则在周期表页
  // 按 ⌘K 只会聚焦表内搜索、全站搜索无法唤出（快捷键语义冲突）。
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        const target = ev.target as HTMLElement | null
        const tag = target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
        ev.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (ev.key === 'Escape' && query) {
        setQuery('')
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [query])

  // Esc 收起重面板：测验 > 对比视图 > 详情抽屉
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      if (quizOpen) { setQuizOpen(false); return }
      if (cmpOpen) { setCmpOpen(false); return }
      if (sel) select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quizOpen, cmpOpen, sel]) // eslint-disable-line react-hooks/exhaustive-deps

  // 深链首次进入：把选中的格子滚到可视区中央（只执行一次）
  React.useEffect(() => {
    if (!booted || !deepLinkEl) return
    const node = document.querySelector<HTMLElement>(`.ru-el[data-z="${deepLinkEl.z}"]`)
    node?.scrollIntoView({ block: 'center', inline: 'center' })
  }, [booted, deepLinkEl])

  // 标题同步：分享 / 收藏时标签页能看出当前元素
  React.useEffect(() => {
    if (typeof document === 'undefined' || !sel) return
    const prev = document.title
    document.title = `${sel.sym} · ${elText(elLang, sel)} — ${uiText(uiLang, '元素周期表', 'Periodic table', 'Периодическая таблица')}`
    return () => { document.title = prev }
  }, [sel, elLang, uiLang])

  // ────── 渲染网格（Standard / Left-step） ──────
  const gridRows: React.ReactNode[] = []
  // 螺旋版面数据（单独渲染）
  const spiralView = React.useMemo(() => {
    if (layoutMode !== 'spiral') return null
    const layout = layoutSpiralJanet()
    const byZ = new Map(layout.nodes.map((p) => [p.z, p]))
    // 螺旋轨迹：按周期内真实阅读顺序（s → f → d → p，跨 -90° 接缝）串联
    const pts = layout.order
      .map((z) => {
        const p = byZ.get(z)!
        return `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`
      })
      .join(' ')
    const nodes = ELEMENTS.map((e) => {
      const pos = byZ.get(e.z)!
      const bg = colorMode !== 'cat' ? cellBg(e) : undefined
      const dimmed = isDimmed(e)
      const dynPhase = colorMode === 'temp' ? phaseAtTemp(e, tempCurK) : null
      const isLiquidHighlight = colorMode === 'temp' && dynPhase === 'Liquid'
      return (
        <button
          key={e.z}
          type="button"
          className={`ru-el${sel?.z === e.z ? ' sel' : ''}${dimmed ? ' dimmed' : ''}${searchHits?.has(e.z) ? ' match' : ''}${isLiquidHighlight ? ' liquid-hl' : ''} spiral`}
          data-c={e.cat}
          data-phase={e.phase}
          data-block={e.block}
          data-z={e.z}
          style={{
            // 百分比定位：x,y ∈ [0,1] → 映射到 [0%, 100%]
            left: `${pos.x * 100}%`,
            top: `${pos.y * 100}%`,
            transform: 'translate(-50%, -50%)',
            backgroundColor: bg,
            color: bg ? getTextColor(bg) : undefined,
          }}
          onMouseEnter={() => { setHoverZ(e.z); prefetchElementAudio(e.z, elLang) }}
          onMouseLeave={() => setHoverZ((cur) => (cur === e.z ? null : cur))}
          onFocus={() => setHoverZ(e.z)}
          onBlur={() => setHoverZ((cur) => (cur === e.z ? null : cur))}
          onClick={() => void say(e)}
          title={`${e.z} ${e.sym} · ${elText(elLang, e)} (${elSub(elLang, e)})${isLiquidHighlight ? ` · ${uiText(uiLang, '当前温度下为液态', 'Liquid at this temperature', 'Жидкость при этой температуре')}` : ''}`}
        >
          <span className="n">{e.z}</span>
          <span className="s">{e.sym}</span>
        </button>
      )
    })
    // 螺旋辅助层：周期弧线、周期间连接线、族号、周期号
    const guides = (
      <svg className="ru-pt-spiral-guides" viewBox="0 0 100 100" aria-hidden="true">
        {layout.arcs.map((a) =>
          a.full ? (
            <circle key={`arc-${a.period}`} cx={50} cy={50} r={a.rho * 100} />
          ) : (
            <path key={`arc-${a.period}`} d={spiralArcPath(a.rho, a.fromCol, a.toCol)} />
          ),
        )}
        {layout.connectors.map((c, i) => (
          <line
            key={`conn-${i}`}
            className="conn"
            x1={c.from[0]}
            y1={c.from[1]}
            x2={c.to[0]}
            y2={c.to[1]}
          />
        ))}
        {layout.groups.map((g) => {
          const pt = spiralPoint(0.478, spiralTheta(g.col))
          return (
            <text key={`grp-${g.col}`} x={pt.x} y={pt.y} textAnchor="middle" dominantBaseline="middle">
              {g.group}
            </text>
          )
        })}
        {/* 中心留白处标注形态来源，避免内圈空洞 */}
        <text className="hub" x={50} y={49} textAnchor="middle" dominantBaseline="middle">Janet</text>
        <text className="hub-sub" x={50} y={53.4} textAnchor="middle" dominantBaseline="middle">1928</text>
        {SPIRAL_PERIODS.map((p, i) => {
          const pt = spiralPoint(spiralRho(i), -90)
          return (
            <text
              key={`per-${p.period}`}
              className="per"
              x={pt.x}
              y={pt.y}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {p.period}
            </text>
          )
        })}
      </svg>
    )
    return { nodes, pts, guides }
  }, [layoutMode, colorMode, colorLog, colorField, tempCurC, highlightBlock, highlightSeries, searchHits, sel, elLang, uiLang])

  // grid 模式才画列头/行头/占位
  const isLeftStep = layoutMode === 'leftstep'
  const isShort = layoutMode === 'short'
  const showGridChrome = layoutMode !== 'spiral'
  if (showGridChrome) {
    if (isLeftStep) {
      // 左阶梯：按 s/p/d/f 区标注列头
      const blockHeads: Array<{ label: string; from: number; span: number }> = [
        { label: 'f', from: 1, span: 14 },
        { label: 'd', from: 15, span: 10 },
        { label: 'p', from: 25, span: 6 },
        { label: 's', from: 31, span: 2 },
      ]
      for (const bh of blockHeads) {
        gridRows.push(
          <span
            key={`bh-${bh.label}`}
            className="ru-pt-blockhead"
            style={{ gridRow: 1, gridColumn: `${bh.from + 1} / span ${bh.span}` }}
          >{bh.label}</span>,
        )
      }
    } else if (isShort) {
      // 短表：8 个族，第 VIII 族横跨 3 个子列（三联组）
      const SHORT_GROUPS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
      for (let i = 0; i < SHORT_GROUPS.length; i++) {
        gridRows.push(
          <span key={`gh-short-${i}`} className="ru-pt-colhead" style={{ gridRow: 1, gridColumn: i + 2 }}>
            {SHORT_GROUPS[i]}
          </span>,
        )
      }
      gridRows.push(
        <span key="gh-short-8" className="ru-pt-colhead" style={{ gridRow: 1, gridColumn: '9 / span 3' }}>
          VIII
        </span>,
      )
    } else {
      for (let i = 0; i < 18; i++) {
        gridRows.push(
          <span key={`gh-${i}`} className="ru-pt-colhead" style={{ gridRow: 1, gridColumn: i + 2 }}>
            {groups[i]}
          </span>,
        )
      }
    }
    // 行号 —— 短表只标周期切换位置（长周期占 2 行）
    if (isShort) {
      const periodBands: Array<{ row: number; span: number; label: string }> = [
        { row: 2, span: 1, label: '1' },
        { row: 3, span: 1, label: '2' },
        { row: 4, span: 1, label: '3' },
        { row: 5, span: 2, label: '4' },
        { row: 7, span: 2, label: '5' },
        { row: 9, span: 2, label: '6' },
        { row: 11, span: 2, label: '7' },
      ]
      for (const b of periodBands) {
        gridRows.push(
          <span
            key={`rh-short-${b.label}`}
            className="ru-pt-rowhead"
            style={{ gridRow: `${b.row} / span ${b.span}`, gridColumn: 1 }}
          >
            {b.label}
          </span>,
        )
      }
    } else {
      for (let p = 1; p <= 7; p++) {
        gridRows.push(
          <span key={`rh-${p}`} className="ru-pt-rowhead" style={{ gridRow: p + 1, gridColumn: 1 }}>{p}</span>,
        )
      }
      if (!isLeftStep) {
        gridRows.push(
          <span key="ls" className="ru-el-series" data-c="lanth" style={{ gridRow: 10, gridColumn: '2 / span 3' }}>
            {uiText(uiLang, '镧系', 'Lanthanides', 'Лантаноиды')}
          </span>,
        )
        gridRows.push(
          <span key="as" className="ru-el-series" data-c="act" style={{ gridRow: 11, gridColumn: '2 / span 3' }}>
            {uiText(uiLang, '锕系', 'Actinides', 'Актиноиды')}
          </span>,
        )
      }
    }
  }

  // grid 模式的元素渲染
  const renderEl = (e: Element, style: React.CSSProperties, extraClass = '') => {
    const bg = colorMode !== 'cat' ? cellBg(e) : undefined
    const dimmed = isDimmed(e)
    const dynPhase = colorMode === 'temp' ? phaseAtTemp(e, tempCurK) : null
    const isLiquidHighlight = colorMode === 'temp' && dynPhase === 'Liquid'
    const cellValue = colorMode === 'field' ? fieldGetter(e) : null
    const showValue = colorMode === 'field' && showCellValue
    let barPct = 0
    if (cellValue != null && fieldMax > fieldMin) {
      barPct = colorLog && fieldMin > 0 && cellValue > 0
        ? (Math.log10(cellValue) - Math.log10(fieldMin)) / (Math.log10(fieldMax) - Math.log10(fieldMin)) * 100
        : (cellValue - fieldMin) / (fieldMax - fieldMin) * 100
      barPct = Math.max(0, Math.min(100, barPct))
    }
    const valueTitle = showValue && cellValue != null
      ? ` · ${fieldLabel} ${fmtNum(cellValue, 2)}${fieldUnit ? ` ${fieldUnit}` : ''}`
      : ''
    return (
      <button
        key={e.z}
        type="button"
        className={`ru-el${sel?.z === e.z ? ' sel' : ''}${dimmed ? ' dimmed' : ''}${searchHits?.has(e.z) ? ' match' : ''}${isLiquidHighlight ? ' liquid-hl' : ''}${extraClass ? ` ${extraClass}` : ''}`}
        data-c={e.cat}
        data-phase={e.phase}
        data-block={e.block}
        data-z={e.z}
        data-temp-phase={dynPhase ?? undefined}
        style={{
          ...style,
          backgroundColor: bg,
          color: bg ? getTextColor(bg) : undefined,
        }}
        onMouseEnter={() => { setHoverZ(e.z); prefetchElementAudio(e.z, elLang) }}
        onMouseLeave={() => setHoverZ((cur) => (cur === e.z ? null : cur))}
        onFocus={() => setHoverZ(e.z)}
        onBlur={() => setHoverZ((cur) => (cur === e.z ? null : cur))}
        onClick={() => void say(e)}
        title={`${e.z} ${e.sym} · ${elText(elLang, e)} (${elSub(elLang, e)})${valueTitle}${isLiquidHighlight ? ` · ${uiText(uiLang, '当前温度下为液态', 'Liquid at this temperature', 'Жидкость при этой температуре')}` : ''}`}
      >
        <span className="n">{e.z}</span>
        <span className="s">{e.sym}</span>
        <span className="nm" lang={elLang === 'zh' ? 'zh-CN' : elLang}>{elText(elLang, e)}</span>
        <span className={`w${showValue ? ' val' : ''}`}>
          {showValue ? fmtCellValue(cellValue) : fmtNum(e.mass, 3)}
        </span>
        {showValue && cellValue != null && (
          <span className="ru-el-valbar" aria-hidden="true"><i style={{ width: `${barPct}%` }} /></span>
        )}
        {isShort && (e.z === 57 || e.z === 89) && <span className="ru-el-star">*</span>}
      </button>
    )
  }

  if (layoutMode !== 'spiral') {
    for (const e of ELEMENTS) {
      // 短表里 Ce-Lu / Th-Lr 由下方条带渲染，主网格跳过（否则会落到标准表坐标）
      if (isShort && SHORT_FBLOCK.some((f) => e.z >= f.from && e.z <= f.to)) continue
      let row: number, col: number
      if (isLeftStep) { [row, col] = layoutLeftStep(e.z) }
      else if (isShort) { [row, col] = layoutShortTable(e.z) }
      else { [row, col] = layoutStandard(e.z) }
      gridRows.push(renderEl(e, { gridRow: row + 1, gridColumn: col + 1 }))
    }
  }

  // 短表下方：镧系/锕系条带（Ce-Lu、Th-Lr 各 14 格）
  const shortFblocks = isShort
    ? SHORT_FBLOCK.map((g) => (
        <div key={g.key} className="ru-pt-fblock">
          <span className="ru-pt-fblock-label">
            {g.key === 'lanth'
              ? uiText(uiLang, '* 镧系', '* Lanthanides', '* Лантаноиды')
              : uiText(uiLang, '* 锕系', '* Actinides', '* Актиноиды')}
          </span>
          {ELEMENTS.filter((e) => e.z >= g.from && e.z <= g.to).map((e) => renderEl(e, {}, 'mini'))}
        </div>
      ))
    : null

  // ────── 色阶图例 ──────
  function ColorBar() {
    if (colorMode !== 'field') return null
    const steps = 11
    const items = Array.from({ length: steps }, (_, i) => {
      const t = i / (steps - 1)
      const v = colorLog
        ? Math.pow(10, Math.log10(Math.max(fieldMin, 1e-10)) + (Math.log10(Math.max(fieldMax, 1e-10)) - Math.log10(Math.max(fieldMin, 1e-10))) * t)
        : fieldMin + (fieldMax - fieldMin) * t
      return { t, v, color: colorScale(v, fieldMin, fieldMax, 220, 0, colorLog)! }
    })
    const curField = COLOR_FIELDS.find((x) => x.key === colorField)!
    return (
      <div className="ru-el-colorbar">
        <span className="ru-el-colorbar-label">
          {curField[elLang]}
        </span>
        <div className="ru-el-colorbar-strip">
          {items.map((it, i) => (
            <span key={i} style={{ backgroundColor: it.color, width: `${100 / steps}%` }} />
          ))}
        </div>
        <span className="ru-el-colorbar-min">{fmtNum(fieldMin, 2)}</span>
        <span className="ru-el-colorbar-max">{fmtNum(fieldMax, 2)}</span>
      </div>
    )
  }

  // ────── 桌面悬停速览（不朗读、不打断当前选中） ──────
  function PeekPanel({ e }: { e: Element }) {
    const t = (zh: string, en: string, ru: string) => uiText(uiLang, zh, en, ru)
    const temp = (k: number | null) => (k == null ? '—' : `${displayTemp(k, tempUnit)} ${tempUnit}`)
    const disc = e.discYear == null ? '—'
      : e.discYear < 0 ? t(`公元前 ${Math.abs(e.discYear)} 年`, `${Math.abs(e.discYear)} BC`, `${Math.abs(e.discYear)} до н.э.`)
        : e.discYear < 1500 ? t('古代', 'Ancient', 'Древность')
          : String(e.discYear)
    const rows: Array<[string, string]> = [
      [t('原子量', 'Atomic mass', 'Атомная масса'), `${fmtNum(e.mass, 3)} u`],
      [t('熔点', 'Melting point', 'Плавление'), temp(e.mpK)],
      [t('沸点', 'Boiling point', 'Кипение'), temp(e.bpK)],
      [t('密度', 'Density', 'Плотность'), e.density == null ? '—' : `${fmtNum(e.density, 4)} g/cm³`],
      [t('电负性', 'Electronegativity', 'Электроотриц.'), fmtNum(e.eneg, 2)],
      [t('发现年份', 'Discovered', 'Открыт'), disc],
    ]
    return (
      <aside className="ru-el-detail-placeholder ru-el-peek">
        <div className="ru-el-peek-head">
          <span className="ru-el-peek-sym">{e.sym}</span>
          <div className="ru-el-peek-title">
            <strong lang={elLang === 'zh' ? 'zh-CN' : elLang}>{elText(elLang, e)}</strong>
            <small>{e.z} · {CAT_LABELS[e.cat][elLang]}</small>
          </div>
        </div>
        <div className="ru-el-peek-grid">
          {rows.map(([k, v]) => (
            <div key={k}>
              <span>{k}</span>
              <b>{v}</b>
            </div>
          ))}
        </div>
        {e.eConf && (
          <div className="ru-el-peek-conf">
            <span>{t('电子构型', 'Configuration', 'Конфигурация')}</span>
            <b>{e.eConf}</b>
          </div>
        )}
        <p className="ru-el-peek-hint">{t('点击查看完整属性', 'Click for full properties', 'Нажмите для подробностей')}</p>
      </aside>
    )
  }

  // ────── 详细属性面板 ──────
  function DetailPanel({ e }: { e: Element }) {
    const lang = elLang
    const audioRec = getElementAudio(e.z, elLang)
    const labelOf = (key: PropKey) => PROP_DEFS.find((p) => p.key === key)?.[lang] ?? key
    const inCompare = compare.includes(e.z)
    const compareFull = !inCompare && compare.length >= 4

    const massIsotope = (() => {
      // 稳定元素显示标准原子量；放射性/超重元素有些标注半衰期最长的同位素（括号内）
      if (e.mass == null) return '—'
      // 简单规则：Tc(43), Pm(61), 84+ 及 104+ 超重用 (mass) 标记
      const parentheses = e.z === 43 || e.z === 61 || e.z >= 84 || (e.z >= 104 && e.z <= 118)
      return parentheses ? `(${fmtNum(e.mass, 0)})` : fmtNum(e.mass, 4)
    })()

    return (
      <div className="ru-el-detail-panel">
        <button
          type="button"
          className="ru-el-detail-close"
          onClick={() => select(null)}
          aria-label={uiText(uiLang, '关闭详情', 'Close details', 'Закрыть')}
          title={uiText(uiLang, '关闭详情', 'Close details', 'Закрыть')}
        >✕</button>
        {/* 头部 + 简介 + 图片 */}
        <div className="ru-el-detail-head">
          <div className="ru-el-detail-header-left">
            <span className="ru-el-detail-z">{e.z}</span>
            <span className="ru-el-detail-sym">{e.sym}</span>
          </div>
          <div className="ru-el-detail-header-right">
            <div className="ru-el-detail-name" lang={elLang === 'zh' ? 'zh-CN' : elLang}>{elText(elLang, e)}</div>
            <div className="ru-el-detail-sub">
              {elSub(elLang, e)}
            </div>
            <div className="ru-el-detail-meta">
              <span>{massIsotope} u</span>
              <span>{fmtPhase(e.phase, elLang)}</span>
              <span>{CAT_LABELS[e.cat][elLang]}</span>
              {e.wiki && (
                <a href={e.wiki} target="_blank" rel="noreferrer">
                  {uiText(uiLang, '维基百科', 'Wikipedia', 'Википедия')} ↗
                </a>
              )}
            </div>
          </div>
          <button
            type="button"
            className="ru-el-say-btn"
            onClick={async () => { if (!(await playElementName(e.z, elText(elLang, e), elLang))) setNoVoice(true) }}
            title={uiText(uiLang, '朗读当前名称', 'Pronounce current name', 'Произнести текущее название')}
          >🔊</button>
        </div>

        {/* 元素简介：英文用维基摘要原文，中/俄文用本地化事实句 */}
        {e.summary && <div className="ru-el-summary">{summaryText(elLang, e)}</div>}

        {/* 真人发音标识；无公开署名的录音只保留标记 */}
        {audioRec && (
          <div className="ru-el-audio-credit">
            <span className="ru-el-audio-credit-tag">{uiText(uiLang, '真人发音', 'Recorded', 'Живая запись')}</span>
            {audioRec.credit && (
              <a href={audioRec.sourceUrl} target="_blank" rel="noreferrer">{audioRec.credit}</a>
            )}
            {audioRec.license && <span>{audioRec.license}</span>}
          </div>
        )}

        {/* 深链 / 对比操作 */}
        <div className="ru-el-detail-actions">
          <button
            type="button"
            className={inCompare ? 'active' : ''}
            disabled={compareFull}
            onClick={() => toggleCompare(e.z)}
            title={compareFull ? uiText(uiLang, '最多对比 4 个元素', 'Compare up to 4 elements', 'Не более 4 элементов') : undefined}
          >
            {inCompare
              ? uiText(uiLang, '✓ 已在对比中', '✓ In comparison', '✓ В сравнении')
              : uiText(uiLang, '+ 加入对比', '+ Add to comparison', '+ В сравнение')}
          </button>
          <button type="button" onClick={() => void copyLink(e)}>
            {copiedZ === e.z
              ? uiText(uiLang, '已复制链接', 'Link copied', 'Ссылка скопирована')
              : uiText(uiLang, '复制链接', 'Copy link', 'Копировать ссылку')}
          </button>
        </div>

        {/* 实物图（全部自托管，含署名与许可）；无实物照片的元素渲染占位卡 */}
        <ElementImageCard key={`img-${e.z}`} el={e} lang={elLang} />

        {/* 发现 & 基本布局 */}
        <div className="ru-el-detail-grid">
          <div className="ru-el-detail-row">
            <span className="ru-el-detail-k">{labelOf('group')}</span>
            <span className="ru-el-detail-v">{e.group || '—'}</span>
          </div>
          <div className="ru-el-detail-row">
            <span className="ru-el-detail-k">{labelOf('period')}</span>
            <span className="ru-el-detail-v">{e.period || '—'}</span>
          </div>
          <div className="ru-el-detail-row">
            <span className="ru-el-detail-k">{labelOf('block')}</span>
            <span className="ru-el-detail-v">{fmtBlock(e.block)}</span>
          </div>
          <div className="ru-el-detail-row">
            <span className="ru-el-detail-k">{labelOf('discYear')}</span>
            <span className="ru-el-detail-v">{e.discYear ?? '—'}</span>
          </div>
          {e.ox && (
            <div className="ru-el-detail-row full">
              <span className="ru-el-detail-k">{labelOf('ox')}</span>
              <span className="ru-el-detail-v">{e.ox}</span>
            </div>
          )}
          {e.discoveredBy && (
            <div className="ru-el-detail-row full">
              <span className="ru-el-detail-k">{labelOf('discoveredBy')}</span>
              <span className="ru-el-detail-v">{e.discoveredBy}</span>
            </div>
          )}
          {e.namedBy && e.namedBy !== e.discoveredBy && (
            <div className="ru-el-detail-row full">
              <span className="ru-el-detail-k">{labelOf('namedBy')}</span>
              <span className="ru-el-detail-v">{e.namedBy}</span>
            </div>
          )}
        </div>

        {/* 热力学 */}
        <Section title={uiText(uiLang, '热力学', 'Thermodynamics', 'Термодинамика')}>
          <UnitRow
            k={labelOf('mpK')}
            v={displayTemp(e.mpK, tempUnit)}
            unit={tempUnit}
            onUnit={setTempUnit}
          />
          <UnitRow
            k={labelOf('bpK')}
            v={displayTemp(e.bpK, tempUnit)}
            unit={tempUnit}
            onUnit={setTempUnit}
          />
          <Row k={labelOf('heatFus')} v={displayEnergy(e.heatFus, energyUnit)} />
          <Row k={labelOf('heatVap')} v={displayEnergy(e.heatVap, energyUnit)} />
          <Row k={labelOf('heatSp')} v={fmtNum(e.heatSp, 0)} />
          {e.molarHeat != null && <Row k={labelOf('molarHeat')} v={fmtNum(e.molarHeat, 3)} />}
          <Row k={labelOf('density')} v={e.density != null ? `${fmtNum(e.density, 5)} g/cm³` : '—'} />
        </Section>

        {/* 化学 */}
        <Section title={uiText(uiLang, '化学属性', 'Chemical properties', 'Химические свойства')}>
          <Row k={labelOf('eneg')} v={fmtNum(e.eneg, 2)} />
          <Row k={labelOf('eaff')} v={displayEnergy(e.eaff, energyUnit)} />
          <Row k={labelOf('ox')} v={e.ox || '—'} />
        </Section>

        {/* 原子半径 */}
        <Section title={uiText(uiLang, '原子半径', 'Atomic radii', 'Атомные радиусы')}>
          <Row k={labelOf('rCalc')} v={e.rCalc != null ? `${e.rCalc} pm` : '—'} />
          <Row k={labelOf('rEmp')} v={e.rEmp != null ? `${e.rEmp} pm` : '—'} />
          {e.rCovSingle != null && <Row k={labelOf('rCovSingle')} v={`${e.rCovSingle} pm`} />}
          {e.rCovTriple != null && <Row k={labelOf('rCovTriple')} v={`${e.rCovTriple} pm`} />}
          {e.rMetallic != null && <Row k={labelOf('rMetallic')} v={`${e.rMetallic} pm`} />}
          <Row k={labelOf('rvdw')} v={e.rvdw != null ? `${e.rvdw} pm` : '—'} />
        </Section>

        {/* 电离能 */}
        {e.ie.length > 0 && (
          <Section title={uiText(uiLang, `电离能（${e.ie.length} 级）`, `Ionization energies (${e.ie.length} levels)`, `Энергии ионизации (${e.ie.length} уровней)`)}>
            <div className="ru-el-ie-grid">
              {e.ie.slice(0, 12).map((val, i) => (
                <div key={i} className="ru-el-ie-item">
                  <span className="ru-el-ie-n">{i + 1}</span>
                  <span className="ru-el-ie-v">{displayEnergy(val, energyUnit)}</span>
                </div>
              ))}
              {e.ie.length > 12 && (
                <span className="ru-el-ie-more">
                  {uiText(uiLang, `还有 ${e.ie.length - 12} 级…`, `+ ${e.ie.length - 12} more…`, `+ ещё ${e.ie.length - 12}…`)}
                </span>
              )}
            </div>
          </Section>
        )}

        {/* 电子结构 */}
        <Section title={uiText(uiLang, '电子结构', 'Electron configuration', 'Электронная структура')}>
          {e.eConf && <Row k={labelOf('eConf')} v={e.eConf} />}
          {e.eConfSem && <Row k={labelOf('eConfSem')} v={e.eConfSem} />}
          {e.shells && <Row k={labelOf('shells')} v={e.shells} />}
          {e.valE != null && <Row k={labelOf('valE')} v={String(e.valE)} />}
        </Section>

        {/* 原子结构可视化：Bohr / 轨道 / 可选 Three.js */}
        <Section title={uiText(uiLang, '原子模型', 'Atomic model', 'Модель атома')}>
          <AtomModel el={e} lang={elLang} />
        </Section>

        {/* 同位素：概要 + 逐核素表（P3 数据补全） */}
        {(() => {
          const iso = isotopeSummary(e)
          const rows = ISOTOPES[e.sym] ?? []
          if (!iso.known.length && !iso.stable.length && e.halfLife == null && !iso.abundance && rows.length === 0) return null
          const life = typeof e.halfLife === 'number'
            ? fmtHalfLife(e.halfLife, elLang)
            : e.halfLife && e.halfLife !== 'Stable' && e.halfLife !== 'None' ? String(e.halfLife) : ''
          const stableLabel = uiText(uiLang, '稳定', 'stable', 'стабилен')
          return (
            <Section title={uiText(uiLang, '同位素', 'Isotopes', 'Изотопы')}>
              <Row k={uiText(uiLang, '已知同位素', 'Known isotopes', 'Известных изотопов')} v={iso.known.length ? String(iso.known.length) : '—'} />
              <Row
                k={uiText(uiLang, '稳定同位素', 'Stable isotopes', 'Стабильных')}
                v={iso.stable.length ? String(iso.stable.length) : uiText(uiLang, '无', 'none', 'нет')}
              />
              {iso.stable.length > 0 && (
                <Row k={uiText(uiLang, '稳定核素', 'Stable nuclides', 'Стабильные нуклиды')} v={iso.stable.slice(0, 8).join(', ')} />
              )}
              {life && <Row k={uiText(uiLang, '半衰期（最稳定）', 'Half-life (longest)', 'Период полураспада')} v={life} />}
              {e.halfLife === 'Stable' && (
                <Row k={uiText(uiLang, '半衰期', 'Half-life', 'Период полураспада')} v={stableLabel} />
              )}
              {iso.abundance && <Row k={uiText(uiLang, '天然丰度', 'Natural abundance', 'Природная доля')} v={iso.abundance} />}
              {iso.known.length > 0 && (
                <div className="ru-iso-bar" title={uiText(uiLang, '稳定 / 已知同位素比例', 'Stable / known isotope ratio', 'доля стабильных изотопов')}>
                  <i style={{ width: `${Math.min(100, (iso.stable.length / iso.known.length) * 100)}%` }} />
                  <span>{iso.stable.length} / {iso.known.length}</span>
                </div>
              )}
              {rows.length > 0 && (
                <div className="ru-iso-table-wrap">
                  <table className="ru-iso-table">
                    <thead>
                      <tr>
                        <th>{uiText(uiLang, '核素', 'Nuclide', 'Нуклид')}</th>
                        <th>{uiText(uiLang, '质量 (u)', 'Mass (u)', 'Масса (а.е.м.)')}</th>
                        <th>{uiText(uiLang, '丰度 (%)', 'Abundance (%)', 'Доля (%)')}</th>
                        <th>{uiText(uiLang, '半衰期', 'Half-life', 'Период полураспада')}</th>
                        <th>{uiText(uiLang, '衰变方式', 'Decay mode', 'Распад')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const [a, mass, abund, stable, decay, hlVal, hlUnit] = r
                        const hl = stable ? stableLabel : fmtHalfLifeUnit(hlVal, hlUnit, elLang)
                        const dm = stable
                          ? '—'
                          : decay.split(',').map((c) => decayModeLabel(c.trim(), elLang)).join(', ')
                        return (
                          <tr key={i}>
                            <td><sup>{a}</sup>{e.sym}</td>
                            <td>{mass != null ? mass : '—'}</td>
                            <td>{abund != null ? fmtNum(abund, 4) : '—'}</td>
                            <td>{hl}</td>
                            <td>{dm}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )
        })()}

        {/* 丰度 */}
        <Section title={uiText(uiLang, '丰度', 'Abundance', 'Распространённость')}>
          <Row k={labelOf('abUniv')} v={e.abUniv != null ? `${fmtNum(e.abUniv, 2)}%` : '—'} />
          <Row k={labelOf('abSolar')} v={e.abSolar != null ? `${fmtNum(e.abSolar, 2)}%` : '—'} />
          <Row k={labelOf('abCrust')} v={e.abCrust != null ? `${fmtNum(e.abCrust, 3)}%` : '—'} />
          <Row k={labelOf('abOcean')} v={e.abOcean != null ? `${fmtNum(e.abOcean, 3)}%` : '—'} />
          <Row k={labelOf('abHuman')} v={e.abHuman != null ? `${fmtNum(e.abHuman, 3)}%` : '—'} />
        </Section>

        {/* 晶体结构 & 热学补全 */}
        {(e.crystalStructure || e.latticeConstants || e.spaceGroupName || e.conductThermal != null) && (
          <Section title={uiText(uiLang, '晶体结构', 'Crystal structure', 'Кристалл. структура')}>
            {e.crystalStructure && <Row k={labelOf('crystalStructure')} v={crystalLabel(e.crystalStructure, elLang)} />}
            {e.latticeConstants && <Row k={labelOf('latticeConstants')} v={e.latticeConstants} />}
            {e.latticeAngles && <Row k={labelOf('latticeAngles')} v={e.latticeAngles} />}
            {e.spaceGroupName && <Row k={labelOf('spaceGroupName')} v={e.spaceGroupName} />}
            {e.conductThermal != null && <Row k={labelOf('conductThermal')} v={fmtNum(e.conductThermal, 2)} />}
          </Section>
        )}

        {/* 更多链接：维基百科 + 权威元素库 + MIT 源 */}
        <div className="ru-el-links">
          {e.wiki && <a href={e.wiki} target="_blank" rel="noreferrer">{uiText(uiLang, '维基百科详情', 'More on Wikipedia', 'Подробнее в Википедии')} ↗</a>}
          <a href={`https://www.rsc.org/periodic-table/element/${e.z}/${e.en.toLowerCase()}`} target="_blank" rel="noreferrer" title="Royal Society of Chemistry">RSC ↗</a>
          <a href={`https://pubchem.ncbi.nlm.nih.gov/element/${e.z}`} target="_blank" rel="noreferrer" title="PubChem (NCBI)">PubChem ↗</a>
          <a href={`https://www.webelements.com/${e.en.toLowerCase()}/`} target="_blank" rel="noreferrer" title="WebElements">WebElements ↗</a>
          <span className="ru-el-license">
            {uiText(uiLang,
              '数据：Bowser PT (CC BY 3.0) + ptable-data-complete (MIT)',
              'Data: Bowser PT (CC BY 3.0) + ptable-data-complete (MIT)',
              'Данные: Bowser PT (CC BY 3.0) + ptable-data-complete (MIT)')}
          </span>
        </div>
      </div>
    )
  }

  // ────── 有序列表视图 ──────
  function ListView() {
    return (
      <div className="ru-el-list">
        <div className="ru-el-list-head">
          <span>#</span><span>Sym</span>
          <span>{uiText(uiLang, '中文名', 'Chinese', 'Кит.')}</span>
          <span>{uiText(uiLang, '英文名', 'English', 'Англ.')}</span>
          <span>{uiText(uiLang, '俄语名', 'Russian', 'Рус.')}</span>
          <span>{uiText(uiLang, '原子量', 'Mass', 'Масса')}</span>
          <span>{uiText(uiLang, '熔点 K', 'MP K', 'Плавл. K')}</span>
          <span>{uiText(uiLang, '沸点 K', 'BP K', 'Кип. K')}</span>
        </div>
        {ELEMENTS.map((e) => (
          <button
            key={e.z}
            type="button"
            className={`ru-el-list-row${sel?.z === e.z ? ' sel' : ''}${isDimmed(e) ? ' dimmed' : ''}${searchHits?.has(e.z) ? ' match' : ''}`}
            data-c={e.cat}
            data-z={e.z}
            onClick={() => void say(e)}
          >
            <span>{e.z}</span>
            <span className="sym">{e.sym}</span>
            <span>{e.zh}</span>
            <span>{e.en}</span>
            <span>{e.ru}</span>
            <span>{fmtNum(e.mass, 4)}</span>
            <span>{e.mpK != null ? fmtNum(e.mpK, 1) : '—'}</span>
            <span>{e.bpK != null ? fmtNum(e.bpK, 1) : '—'}</span>
          </button>
        ))}
      </div>
    )
  }

  // ────── 对比视图（最多 4 个元素） ──────
  function CompareView({ onClose }: { onClose: () => void }) {
    const items = compare.map((z) => ELEMENT_BY_Z[z]).filter(Boolean)
    if (items.length < 2) return null
    const lang = elLang
    type NumRow = { key: string; label: string; unit?: string; digits?: number; get: (e: Element) => number | null }
    const rows: NumRow[] = [
      { key: 'mass', label: uiText(uiLang, '原子量', 'Atomic mass', 'Атомная масса'), unit: 'u', digits: 3, get: (e) => e.mass },
      { key: 'mpK', label: uiText(uiLang, '熔点', 'Melting point', 'Т. плавления'), unit: 'K', digits: 1, get: (e) => e.mpK },
      { key: 'bpK', label: uiText(uiLang, '沸点', 'Boiling point', 'Т. кипения'), unit: 'K', digits: 1, get: (e) => e.bpK },
      { key: 'density', label: uiText(uiLang, '密度', 'Density', 'Плотность'), unit: 'g/cm³', digits: 3, get: (e) => e.density },
      { key: 'eneg', label: uiText(uiLang, '电负性', 'Electronegativity', 'Электроотрицательность'), digits: 2, get: (e) => e.eneg },
      { key: 'eaff', label: uiText(uiLang, '电子亲合能', 'Electron affinity', 'Сродство к e⁻'), unit: 'kJ/mol', digits: 1, get: (e) => e.eaff },
      { key: 'valE', label: uiText(uiLang, '价电子', 'Valence e⁻', 'Валентные e⁻'), digits: 0, get: (e) => e.valE },
      { key: 'rCovSingle', label: uiText(uiLang, '共价半径', 'Covalent radius', 'Ковалентный радиус'), unit: 'pm', digits: 0, get: (e) => e.rCovSingle },
      { key: 'conductThermal', label: uiText(uiLang, '导热系数', 'Thermal conductivity', 'Теплопроводность'), unit: 'W/(m·K)', digits: 1, get: (e) => e.conductThermal },
      { key: 'discYear', label: uiText(uiLang, '发现年份', 'Discovered', 'Год открытия'), digits: 0, get: (e) => e.discYear },
    ]
    return (
      <>
        <div className="ru-el-cmp-scrim" onClick={onClose} aria-hidden="true" />
        <div className="ru-el-cmp-modal" role="dialog" aria-modal="true" aria-label={uiText(uiLang, '元素对比', 'Compare elements', 'Сравнение элементов')}>
          <div className="ru-el-cmp-modal-head">
            <strong>{uiText(uiLang, `元素对比 · ${items.length}`, `Compare elements · ${items.length}`, `Сравнение · ${items.length}`)}</strong>
            <button type="button" onClick={onClose} aria-label={uiText(uiLang, '关闭对比', 'Close comparison', 'Закрыть')}>✕</button>
          </div>
          <div className="ru-el-cmp-scroll">
            <table className="ru-el-cmp-table">
              <thead>
                <tr>
                  <th className="rowhead" />
                  {items.map((e) => (
                    <th key={e.z}>
                      <button
                        type="button"
                        className="ru-el-cmp-el"
                        data-c={e.cat}
                        onClick={() => { select(e); onClose() }}
                      >
                        <span className="sym">{e.sym}</span>
                        <span className="nm" lang={elLang === 'zh' ? 'zh-CN' : elLang}>{elText(elLang, e)}</span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>{uiText(uiLang, '类别', 'Category', 'Категория')}</th>
                  {items.map((e) => <td key={e.z}>{CAT_LABELS[e.cat][lang]}</td>)}
                </tr>
                <tr>
                  <th>{uiText(uiLang, '周期 / 族', 'Period / group', 'Период / группа')}</th>
                  {items.map((e) => <td key={e.z}>{e.period} / {e.group}</td>)}
                </tr>
                {rows.map((r) => {
                  const vals = items.map(r.get)
                  const abs = vals.map((v) => (v == null ? 0 : Math.abs(v)))
                  const max = Math.max(...abs, 0) || 1
                  return (
                    <tr key={r.key}>
                      <th>
                        {r.label}
                        {r.unit && <span className="unit"> {r.unit}</span>}
                      </th>
                      {items.map((e, i) => (
                        <td key={e.z}>
                          <span className="num">{vals[i] == null ? '—' : fmtNum(vals[i], r.digits ?? 2)}</span>
                          {vals[i] != null && (
                            <span className="bar">
                              <i style={{ width: `${Math.min(100, (abs[i] / max) * 100)}%` }} />
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </>
    )
  }

  // ────── 横屏 FAB：右下角悬浮按钮，点击展开控制栏+图例浮层 ──────
  // 浮层里完整复用下方 ControlsAndLegend 函数（同一套 state / 事件），避免复制 JSX
  const isLandAnywhere = land
  // 设备真横屏（移动端）才需要 FAB：orientation: landscape 且视口高度 ≤ 600px
  // 电脑端窗口宽>高也匹配 landscape，但高度远 > 600px，所以不会误触发
  const [isRealLandscape, setIsRealLandscape] = React.useState(false)
  React.useEffect(() => {
    const MQ = '(orientation: landscape) and (max-height: 600px)'
    const check = () => setIsRealLandscape(window.matchMedia(MQ).matches)
    check()
    const mq = window.matchMedia(MQ)
    mq.addEventListener?.('change', check)
    return () => mq.removeEventListener?.('change', check)
  }, [])
  const needFAB = isLandAnywhere || isRealLandscape
  // 竖屏：原位显示所有控制区；横屏：原位隐藏，只在 FAB 浮层展开时显示
  // 始终只有一份 DOM（条件渲染互斥），避免 searchRef 等 ref 绑定混乱
  const showInline = !needFAB
  const hoverEl = hoverZ != null ? ELEMENT_BY_Z[hoverZ] ?? null : null

  // ────── ControlsBundle：搜索框 + 控制栏 + 图例 + 色阶
  // 竖屏时在原位渲染，横屏时只在 FAB 浮层内渲染 ──────
  const ControlsBundle = (
    <>
      {/* 检索：符号 / 序号 / 中俄英名称 */}
      <div className="ru-el-search" role="search">
        <span className="ru-el-search-icon" aria-hidden="true">⌕</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && searchHits && searchHits.size > 0) {
              const first = ELEMENTS.find((el) => searchHits.has(el.z))
              if (!first) return
              ev.preventDefault()
              // Enter 打开详情；Shift+Enter 只朗读俄语名
              if (ev.shiftKey) void say(first)
              else select(first)
            }
          }}
          placeholder={uiText(uiLang, '搜索名称、符号、序号或 >1000…', 'Search name, symbol, number or >1000…', 'Поиск: название, символ, номер или >1000…')}
          aria-label={uiText(uiLang, '搜索元素', 'Search elements', 'Поиск элементов')}
          spellCheck={false}
          autoComplete="off"
        />
        {query && (
          <>
            <span className="ru-el-search-count" aria-live="polite">{searchHits?.size ?? 0}/118</span>
            <button
              type="button"
              className="ru-el-search-clear"
              onClick={() => setQuery('')}
              aria-label={uiText(uiLang, '清除搜索', 'Clear search', 'Очистить поиск')}
            >✕</button>
          </>
        )}
        <kbd className="ru-el-search-kbd" title={uiText(uiLang, '按 / 聚焦元素搜索', 'Press / to focus element search', 'Нажмите / для поиска')}>/</kbd>
      </div>

      {/* 数值检索提示：明确作用于哪个字段，并可一键切到数值字段模式 */}
      {numericQuery && (
        <div className="ru-el-search-hint" role="status">
          <span>
            {uiText(uiLang, '数值检索', 'Numeric search', 'Числовой поиск')}: <b>{fieldLabel}</b>
            {fieldUnit ? ` · ${fieldUnit}` : ''}
            {' '}
            {numericQuery.op === 'range'
              ? `${fmtNum(Math.min(numericQuery.a, numericQuery.b ?? numericQuery.a), 2)}–${fmtNum(Math.max(numericQuery.a, numericQuery.b ?? numericQuery.a), 2)}`
              : `${numericQuery.op === '~' ? '≈' : numericQuery.op} ${fmtNum(numericQuery.a, 2)}`}
            {' · '}{searchHits?.size ?? 0}/118
          </span>
          {colorMode !== 'field' && (
            <button type="button" onClick={() => setColorMode('field')}>
              {uiText(uiLang, '切到数值字段', 'Switch field', 'К полю')}
            </button>
          )}
        </div>
      )}

      {/* 控制栏：颜色模式、字段、block/series 高亮、温度游标、列表切换 */}
      <div className="ru-el-controls">
        <div className="ru-el-ctrl-group">
          <label className="ru-el-ctrl-label">{uiText(uiLang, '按', 'Color by', 'Окрасить по')}:</label>
          <button type="button" className={colorMode === 'cat' ? 'active' : ''} aria-pressed={colorMode === 'cat'} onClick={() => setColorMode('cat')}>
            {uiText(uiLang, '类别', 'Category', 'Категории')}
          </button>
          <button type="button" className={colorMode === 'phase' ? 'active' : ''} aria-pressed={colorMode === 'phase'} onClick={() => setColorMode('phase')}>
            {uiText(uiLang, '相态', 'Phase', 'Состоянию')}
          </button>
          <button type="button" className={colorMode === 'temp' ? 'active' : ''} aria-pressed={colorMode === 'temp'} onClick={() => setColorMode('temp')} title={uiText(uiLang, '按当前温度的动态相态', 'Dynamic phase at the current temperature', 'Динамическая фаза при T')}>
            🌡
          </button>
          <button type="button" className={colorMode === 'field' ? 'active' : ''} aria-pressed={colorMode === 'field'} onClick={() => setColorMode('field')}>
            {uiText(uiLang, '数值字段', 'Property', 'Полю')}
          </button>
        </div>

        {/* Phase 2：温度游标（仅 temp 模式显示） */}
        {colorMode === 'temp' && (
          <div className="ru-el-ctrl-group ru-el-temp-ctrl">
            <label className="ru-el-ctrl-label">{uiText(uiLang, '温度', 'Temp.', 'T')}:</label>
            <input
              type="range"
              className="ru-el-temp-slider"
              min={-100}
              max={6000}
              step={10}
              value={tempCurC}
              onChange={(e) => setTempCurC(Number(e.target.value))}
            />
            <span className="ru-el-temp-val">{tempCurC}°C</span>
            <button type="button" onClick={() => setTempCurC(25)} title={uiText(uiLang, '重置为 25°C（STP）', 'Reset to 25°C (STP)', 'Сброс 25°C (STP)')}>STP</button>
          </div>
        )}

        {colorMode === 'field' && (
          <div className="ru-el-ctrl-group">
            <select
              className="ru-el-field-select"
              value={colorField}
              onChange={(e) => {
                setColorField(e.target.value as PropKey)
                setFieldThreshold(null)
              }}
            >
              {COLOR_FIELDS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f[elLang]}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setColorLog((v) => !v)}>
              {colorLog ? (uiText(uiLang, '对数 ▲', 'log ▲', 'log ▲')) : (uiText(uiLang, '线性 ▼', 'linear ▼', 'lin ▼'))}
            </button>
            <button
              type="button"
              className={showCellValue ? 'active' : ''}
              aria-pressed={showCellValue}
              onClick={() => changeCellValue(!showCellValue)}
              title={uiText(uiLang, '把所选属性值写进每个格子', 'Show the selected property value inside each cell', 'Показать значение свойства в клетке')}
            >
              {uiText(uiLang, '格内数值', 'Values', 'Значения')}
            </button>
          </div>
        )}

        {/* 属性阈值：滑杆把低于阈值的元素压暗，与搜索高亮互补 */}
        {colorMode === 'field' && fieldMax > fieldMin && (
          <div className="ru-el-ctrl-group ru-el-threshold-ctrl">
            <label className="ru-el-ctrl-label">{uiText(uiLang, '阈值', 'Min', 'Порог')}:</label>
            <input
              type="range"
              className="ru-el-threshold-slider"
              min={fieldMin}
              max={fieldMax}
              step={(fieldMax - fieldMin) / 100}
              value={fieldThreshold ?? fieldMin}
              onChange={(ev) => {
                const v = Number(ev.target.value)
                setFieldThreshold(v <= fieldMin ? null : v)
              }}
              aria-label={uiText(uiLang, `按${fieldLabel}设置下限`, `Minimum ${fieldLabel}`, `Минимум: ${fieldLabel}`)}
            />
            <span className="ru-el-threshold-val">
              {fieldThreshold == null
                ? uiText(uiLang, '全部', 'All', 'Все')
                : `≥ ${fmtNum(fieldThreshold, 2)}${fieldUnit ? ` ${fieldUnit}` : ''}`}
            </span>
            {fieldThreshold != null && (
              <button type="button" onClick={() => setFieldThreshold(null)} aria-label={uiText(uiLang, '清除阈值', 'Clear threshold', 'Сбросить порог')}>✕</button>
            )}
          </div>
        )}

        <div className="ru-el-ctrl-group">
          <label className="ru-el-ctrl-label">{uiText(uiLang, '区:', 'Block:', 'Блок:')}</label>
          {(['s', 'p', 'd', 'f'] as const).map((b) => (
            <button
              key={b}
              type="button"
              className={highlightBlock === b ? 'active' : ''}
              aria-pressed={highlightBlock === b}
              onClick={() => setHighlightBlock((cur) => (cur === b ? null : b))}
            >{b}</button>
          ))}
          {highlightBlock && (
            <button type="button" onClick={() => setHighlightBlock(null)}>✕</button>
          )}
        </div>

        {/* P2：学习工具入口 */}
        <div className="ru-el-ctrl-group ru-el-ctrl-group-tools">
          <button
            type="button"
            className={trendOpen ? 'active' : ''}
            aria-pressed={trendOpen}
            onClick={() => setTrendOpen((v) => !v)}
            title={uiText(uiLang, '性质趋势图', 'Property trends', 'Графики свойств')}
          >📈 {uiText(uiLang, '趋势', 'Trends', 'Тренды')}</button>
          <button
            type="button"
            className={tlOpen ? 'active' : ''}
            aria-pressed={tlOpen}
            onClick={() => setTlOpen((v) => !v)}
            title={uiText(uiLang, '发现时间轴与时间机器', 'Discovery timeline & time machine', 'Хронология и машина времени')}
          >⏳ {uiText(uiLang, '时间轴', 'Timeline', 'Хронология')}{timeYear != null ? ` · ${timeYear}` : ''}</button>
          <button
            type="button"
            onClick={() => setQuizOpen(true)}
            title={uiText(uiLang, '10 题小测验', '10-question quiz', 'Тест из 10 вопросов')}
          >🎯 {uiText(uiLang, '测验', 'Quiz', 'Тест')}</button>
        </div>

        {/* Phase 3：版面模式 */}
        <div className="ru-el-ctrl-group">
          <label className="ru-el-ctrl-label">{uiText(uiLang, '版面:', 'Layout:', 'Вид:')}</label>
          <button type="button" className={layoutMode === 'standard' ? 'active' : ''} aria-pressed={layoutMode === 'standard'} onClick={() => changeLayout('standard')} title={uiText(uiLang, '标准长表', 'Standard long form', 'Стандартная таблица')}>
            {uiText(uiLang, '标准', 'Std', 'Станд.')}
          </button>
          <button type="button" className={layoutMode === 'leftstep' ? 'active' : ''} aria-pressed={layoutMode === 'leftstep'} onClick={() => changeLayout('leftstep')} title={uiText(uiLang, '左阶梯', 'Left-step', 'Лестница')}>
            {uiText(uiLang, '阶梯', 'Step', 'Лест.')}
          </button>
          <button type="button" className={layoutMode === 'short' ? 'active' : ''} aria-pressed={layoutMode === 'short'} onClick={() => changeLayout('short')} title={uiText(uiLang, '门捷列夫短表（8 族）', 'Mendeleev short form (8 groups)', 'Короткая Менделеева')}>
            {uiText(uiLang, '短表', 'Short', 'Корот.')}
          </button>
          <button type="button" className={layoutMode === 'spiral' ? 'active' : ''} aria-pressed={layoutMode === 'spiral'} onClick={() => changeLayout('spiral')} title={uiText(uiLang, '螺旋', 'Spiral (Janet)', 'Спираль')}>
            {uiText(uiLang, '螺旋', 'Spiral', 'Спир.')}
          </button>
        </div>

        <div className="ru-el-ctrl-group">
          <button type="button" className={listView ? 'active' : ''} aria-pressed={listView} onClick={() => setListView((v) => !v)}>
            {listView ? uiText(uiLang, '表格视图', 'Table view', 'Таблица') : uiText(uiLang, '列表视图', 'List view', 'Список')}
          </button>
          <button
            type="button"
            onClick={() => {
              document.body.classList.add('ru-pt-printing')
              const cleanup = () => {
                document.body.classList.remove('ru-pt-printing')
                window.removeEventListener('afterprint', cleanup)
              }
              window.addEventListener('afterprint', cleanup)
              window.print()
              window.setTimeout(cleanup, 1500)
            }}
            title={uiText(uiLang, '打印当前周期表（A4 横向）', 'Print the current table (A4 landscape)', 'Печать таблицы (A4 альбом)')}
          >🖨 {uiText(uiLang, '打印', 'Print', 'Печать')}</button>
        </div>
      </div>

      {/* 类别图例（仅 cat 模式） */}
      {colorMode === 'cat' && (
        <div className="ru-el-legend">
          {CAT_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              className="ru-el-legend-item-btn"
              onClick={() => setHighlightSeries((cur) => (cur === c ? null : c))}
            >
              <i data-c={c} />
              {CAT_LABELS[c][elLang]}
            </button>
          ))}
        </div>
      )}

      {/* 相态图例（仅 phase / temp 模式） */}
      {(colorMode === 'phase' || colorMode === 'temp') && (
        <div className="ru-el-legend">
          {colorMode === 'temp' && (
            <span className="ru-el-legend-temp" title={uiText(uiLang, '当前游标温度', 'Current cursor temperature', 'Текущая температура')}>
              🌡 {tempCurC}°C ({tempCurK.toFixed(0)} K)
            </span>
          )}
          {(['Gas', 'Liquid', 'Solid', 'Unknown'] as const).map((p) => (
            <span key={p} className="ru-el-legend-item">
              <i style={{ backgroundColor: PHASE_COLORS[p] }} />
              {fmtPhase(p, elLang)}
            </span>
          ))}
          {colorMode === 'temp' && (
            <span className="ru-el-legend-hl">
              <i className="liquid-bd" />
              {uiText(uiLang, '蓝色边框 = 当前温度下为液态', 'Blue border = liquid at this temperature', 'Синяя рамка = жидкость при T')}
            </span>
          )}
          {colorMode === 'temp' && transitions.length > 0 && (
            <span className="ru-el-phase-hint">
              {uiText(uiLang, '≈ 相变：', '≈ Transitions: ', '≈ Переходы: ')}
              {transitions.map(({ e, kind }) => (
                <button key={`${e.z}-${kind}`} type="button" onClick={() => select(e)}>
                  {e.sym} {kind === 'melt' ? uiText(uiLang, '熔化', 'melt', 'плавл.') : uiText(uiLang, '沸腾', 'boil', 'кип.')}
                </button>
              ))}
            </span>
          )}
        </div>
      )}

      {/* 色阶 */}
      {colorMode === 'field' && <ColorBar />}
    </>
  )

  // ────── 渲染 ──────
  return (
    <section className={`panel ru-pt-panel${booted ? '' : ' ru-pt-booting'}${land ? ' ru-pt-land' : ''}${fabOpen ? ' ru-el-fab-open' : ''}`} lang={uiLang === 'zh' ? 'zh-CN' : uiLang} style={{ marginTop: 14 }}>
      <div className="ru-el-head">
        <h2 style={{ margin: 0, fontSize: 16 }}>
          <span style={{ marginRight: 6 }}>⚛</span>
          {uiText(uiLang, '元素周期表', 'Periodic table', 'Периодическая таблица')}
        </h2>
        {!booted && (
          <span className="ru-pt-boot-hint" aria-live="polite">
            {uiText(uiLang, '正在初始化交互…', 'Initializing…', 'Инициализация…')}
          </span>
        )}
        {land ? (
          <button type="button" className="ru-pt-exit" onClick={() => void toggleLand()}>
            ✕ {uiText(uiLang, '退出横屏', 'Exit', 'Выйти')}
          </button>
        ) : (
          <button
            type="button"
            className="ru-el-land-btn"
            onClick={() => void toggleLand()}
            title={uiText(uiLang, '手机横屏全屏显示', 'Fullscreen landscape', 'Альбомный полноэкранный режим')}
          >
            ⛶ {uiText(uiLang, '横屏', 'Landscape', 'Альбом')}
          </button>
        )}
        <div className="ru-el-ver" role="group" aria-label={uiText(uiLang, '元素名称语言', 'Element name language', 'Язык названий элементов')}>
          <span className="ru-el-ver-label">{uiText(uiLang, '名称', 'Names', 'Названия')}</span>
          <button
            type="button"
            className={elLangPref === 'auto' ? 'active' : ''}
            onClick={() => changeElLangPref('auto')}
            title={uiText(uiLang, '跟随界面语言', 'Follow the interface language', 'Как язык интерфейса')}
          >{uiText(uiLang, '跟随', 'Auto', 'Авто')}</button>
          <button type="button" className={elLangPref === 'zh' ? 'active' : ''} onClick={() => changeElLangPref('zh')} title="中文">中</button>
          <button type="button" className={elLangPref === 'en' ? 'active' : ''} onClick={() => changeElLangPref('en')} title="English">EN</button>
          <button type="button" className={elLangPref === 'ru' ? 'active' : ''} onClick={() => changeElLangPref('ru')} title="Русский">RU</button>
        </div>
      </div>

      <p style={{ margin: '8px 0 10px', color: 'var(--muted)', fontSize: 13, overflowWrap: 'break-word' }}>
        {noVoice
          ? uiText(uiLang, '浏览器不支持 TTS', 'Speech synthesis is not available', 'В вашем браузере нет TTS')
          : uiText(uiLang, '点击元素查看详情 + 朗读当前语言名称', 'Click an element for details + pronunciation', 'Кликните элемент — просмотр + озвучка названия')}
        <span className="ru-pt-kbd-hint">
          {' · '}
          {uiText(uiLang, '方向键移动，Enter 打开，Esc 关闭', 'Arrows to move, Enter to open, Esc to close', 'Стрелки — выбор, Enter — открыть, Esc — закрыть')}
        </span>
      </p>

      {/* 竖屏时原位显示完整控制区，横屏时只在 FAB 浮层展开时显示 */}
      {showInline && ControlsBundle}

      {/* P2：趋势图 / 发现时间轴 */}
      {trendOpen && <TrendChart uiLang={uiLang} elLang={elLang} onSelect={(e) => select(e)} />}
      {tlOpen && <DiscoveryTimeline uiLang={uiLang} elLang={elLang} onSelect={(e) => select(e)} year={timeYear} onYearChange={setTimeYear} />}

      {/* 对比条：0–4 个元素，选满 2 个即可打开对比视图 */}
      {compare.length > 0 && (
        <div className="ru-el-cmp-bar">
          <span className="ru-el-cmp-label">
            {uiText(uiLang, '对比', 'Compare', 'Сравнение')} {compare.length}/4
          </span>
          <div className="ru-el-cmp-chips">
            {compare.map((z) => {
              const e = ELEMENT_BY_Z[z]
              return (
                <span key={z} className="ru-el-cmp-chip" data-c={e.cat}>
                  <button type="button" className="sym" onClick={() => select(e)} title={elText(elLang, e)}>
                    {e.sym}
                  </button>
                  <button
                    type="button"
                    className="x"
                    onClick={() => toggleCompare(z)}
                    aria-label={uiText(uiLang, `移除 ${e.sym}`, `Remove ${e.sym}`, `Убрать ${e.sym}`)}
                  >✕</button>
                </span>
              )
            })}
          </div>
          <button
            type="button"
            className="ru-el-cmp-open"
            disabled={compare.length < 2}
            onClick={() => setCmpOpen(true)}
          >
            {uiText(uiLang, '查看对比', 'Open', 'Открыть')}
          </button>
          <button type="button" className="ru-el-cmp-clear" onClick={() => setCompare([])}>
            {uiText(uiLang, '清空', 'Clear', 'Очистить')}
          </button>
        </div>
      )}

      {/* 主体 + 详情侧栏：宽屏右侧常驻吸附，窄屏为底部抽屉 */}
      <div className="ru-pt-main">
        <div className="ru-pt-main-body">
          {listView ? (
            <ListView />
          ) : layoutMode === 'spiral' ? (
            <div className="ru-pt-wrap">
              <div className="ru-pt-spiral">
                {spiralView?.guides}
                <svg className="ru-pt-spiral-line" viewBox="0 0 100 100" aria-hidden="true">
                  <polyline points={spiralView?.pts ?? ''} vectorEffect="non-scaling-stroke" />
                </svg>
                {spiralView?.nodes}
              </div>
              <p className="ru-pt-spiral-note">
                {uiText(uiLang,
                  'Janet 左阶梯螺旋（1928）：每圈一个周期，行长为 2 / 8 / 8 / 18 / 18 / 32 / 32；同一列即同一族，圈越外周期越大。',
                  'Janet left-step spiral (1928): one turn per period, row lengths 2 / 8 / 8 / 18 / 18 / 32 / 32; one column is one group, outer turns mean higher periods.',
                  'Спираль Джанета (1928): один виток — один период, длины рядов 2 / 8 / 8 / 18 / 18 / 32 / 32; один столбец — одна группа.')}
              </p>
            </div>
          ) : (
            <div className="ru-pt-wrap" ref={gridWrapRef} onKeyDown={onGridKeyDown}>
              <div className={`ru-pt ${isShort ? 'ru-pt-short' : isLeftStep ? 'ru-pt-33' : 'ru-pt-19'}`}>{gridRows}</div>
              {isShort && <div className="ru-pt-short-fblocks">{shortFblocks}</div>}
            </div>
          )}
        </div>

        {sel ? (
          <>
            <div className="ru-el-detail-scrim" onClick={() => select(null)} aria-hidden="true" />
            <DetailPanel e={sel} />
          </>
        ) : hoverEl ? (
          <PeekPanel e={hoverEl} />
        ) : (
          <aside className="ru-el-detail-placeholder" aria-hidden="true">
            {uiText(uiLang, '点击任意元素查看详细属性', 'Select any element to see its properties', 'Нажмите на элемент, чтобы увидеть свойства')}
          </aside>
        )}
      </div>

      {cmpOpen && <CompareView onClose={() => setCmpOpen(false)} />}
      {quizOpen && <QuizModal uiLang={uiLang} elLang={elLang} onClose={() => setQuizOpen(false)} onSelect={(e) => select(e)} />}

      {/* FAB 悬浮按钮 + 浮层：横屏时展开完整控制区 */}
      {needFAB && (
        <>
          <button
            type="button"
            className="ru-el-fab"
            onClick={() => setFabOpen((v) => !v)}
            aria-label={fabOpen ? uiText(uiLang, '关闭控制面板', 'Close controls', 'Закрыть') : uiText(uiLang, '打开控制面板', 'Open controls', 'Открыть')}
            aria-expanded={fabOpen}
          >
            {fabOpen ? '✕' : '⚙'}
          </button>
          {fabOpen && (
            <>
              <div
                className="ru-el-fab-scrim"
                onClick={() => setFabOpen(false)}
                aria-hidden="true"
              />
              <div className="ru-el-fab-sheet" role="dialog" aria-label={uiText(uiLang, '控制面板', 'Controls', 'Настройки')}>
                {ControlsBundle}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

// ──────────────────────────────────────────────
// 子组件
// ──────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ru-el-section">
      <h4>{title}</h4>
      <div className="ru-el-section-body">{children}</div>
    </div>
  )
}

function Row({ k, v, unit, onUnit }: { k: string; v: React.ReactNode; unit?: string; onUnit?: (u: string) => void }) {
  return (
    <div className="ru-el-detail-row">
      <span className="ru-el-detail-k">{k}</span>
      <span className="ru-el-detail-v">
        {v}
        {unit && onUnit && (
          <span className="ru-el-unit-switch">
            <button type="button" onClick={() => onUnit(unit === 'K' ? 'C' : unit === 'C' ? 'F' : 'K')}>°</button>
          </span>
        )}
      </span>
    </div>
  )
}

function UnitRow(props: { k: string; v: string; unit: TempUnit | EnergyUnit; onUnit: (u: any) => void }) {
  const { k, v, unit, onUnit } = props
  const isTemp = unit === 'K' || unit === 'C' || unit === 'F'
  return (
    <div className="ru-el-detail-row">
      <span className="ru-el-detail-k">{k}</span>
      <span className="ru-el-detail-v">
        {v}
        <span className="ru-el-unit-switch">
          {isTemp ? (
            <>
              <button type="button" className={unit === 'K' ? 'active' : ''} onClick={() => onUnit('K')}>K</button>
              <button type="button" className={unit === 'C' ? 'active' : ''} onClick={() => onUnit('C')}>°C</button>
              <button type="button" className={unit === 'F' ? 'active' : ''} onClick={() => onUnit('F')}>°F</button>
            </>
          ) : (
            <>
              <button type="button" className={unit === 'kJ' ? 'active' : ''} onClick={() => onUnit('kJ')}>kJ/mol</button>
              <button type="button" className={unit === 'eV' ? 'active' : ''} onClick={() => onUnit('eV')}>eV</button>
            </>
          )}
        </span>
      </span>
    </div>
  )
}

// ──────────────────────────────────────────────
// 工具：根据背景亮度选文字颜色
// ──────────────────────────────────────────────
function getTextColor(bg: string): string {
  // 解析 HSL "hsl(h, s%, l%)"，当 l < 50 用白字
  const m = /hsl\((\d+),\s*(\d+)%?,\s*(\d+)%?\)/.exec(bg)
  if (m) return +m[3] < 50 ? '#fff' : '#1a1a1a'
  // 十六进制
  if (bg.startsWith('#') && bg.length >= 7) {
    const r = parseInt(bg.slice(1, 3), 16)
    const g = parseInt(bg.slice(3, 5), 16)
    const b = parseInt(bg.slice(5, 7), 16)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    return lum < 140 ? '#fff' : '#1a1a1a'
  }
  return '#1a1a1a'
}

// ──────────────────────────────────────────────
// 深链解析：支持 ?el=Fe / ?el=26
// ──────────────────────────────────────────────
function findElementByToken(token: string | undefined): Element | null {
  if (!token) return null
  const t = token.trim()
  if (!t) return null
  const z = Number(t)
  if (Number.isInteger(z) && z >= 1 && z <= 118) return ELEMENT_BY_Z[z] ?? null
  const lower = t.toLowerCase()
  return ELEMENTS.find((e) => e.sym.toLowerCase() === lower) ?? null
}

// ──────────────────────────────────────────────
// 原子结构：Bohr / 轨道形状 / 能级方块（SVG + CSS，默认视图）
// ──────────────────────────────────────────────
const SUBSHELL_CAP: Record<string, number> = { s: 2, p: 6, d: 10, f: 14 }
// 角量子数 l 的数值：用于按 n+l（Madelung 规则）排序能级
const L_VALUE: Record<string, number> = { s: 0, p: 1, d: 2, f: 3 }

function parseShells(s: string): number[] {
  return (s.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0).slice(0, 7)
}

interface Subshell { n: number; l: string; count: number }

function parseSubshells(conf: string): Subshell[] {
  const out: Subshell[] = []
  const re = /(\d+)([spdf])(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(conf))) out.push({ n: Number(m[1]), l: m[2], count: Number(m[3]) })
  return out
}

/** 按 n+l（Madelung 规则）升序排列；n+l 相同时 n 小的在前。
 *  即 1s, 2s, 2p, 3s, 3p, 4s, 3d, 4p, 5s, 4d, 5p, 6s, 4f, 5d, 6p, 7s, 5f, 6d, 7p */
function sortByEnergy(a: Subshell, b: Subshell): number {
  const na = a.n + (L_VALUE[a.l] ?? 0)
  const nb = b.n + (L_VALUE[b.l] ?? 0)
  if (na !== nb) return na - nb
  return a.n - b.n
}

/** 洪特规则：每个轨道先单占（↑），再配对（↑↓）。
 *  cap 是电子容量（s=2,p=6,d=10,f=14），轨道数 = cap/2。 */
function fillArrows(n: number, cap: number): string[] {
  const orb = cap / 2 // 轨道数：s=1, p=3, d=5, f=7
  const cells: string[] = []
  for (let i = 0; i < orb; i++) {
    if (i < n) {
      // 前 (n - orb) 个轨道已配对，之后的为单占
      cells.push(i < n - orb ? '↑↓' : '↑')
    } else {
      cells.push('') // 空轨道
    }
  }
  return cells
}

function AtomModel({ el, lang }: { el: Element; lang: Lang }) {
  const [view, setView] = React.useState<'bohr' | 'orbital' | '3d'>('bohr')
  const [paused, setPaused] = React.useState(false)
  const shells = React.useMemo(() => parseShells(el.shells || ''), [el.shells])
  const subshells = React.useMemo(() => parseSubshells(el.eConf || '').sort(sortByEnergy), [el.eConf])
  const t = (zh: string, en: string, ru: string) => uiText(lang, zh, en, ru)

  return (
    <div className="ru-atom">
      <div className="ru-atom-head">
        <div className="ru-atom-tabs" role="tablist" aria-label={t('原子模型', 'Atomic model', 'Модель атома')}>
          {(['bohr', 'orbital', '3d'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={view === v ? 'active' : ''}
              onClick={() => setView(v)}
            >
              {v === 'bohr' ? 'Bohr' : v === 'orbital' ? t('轨道', 'Orbitals', 'Орбитали') : '3D'}
            </button>
          ))}
        </div>
        <button type="button" className="ru-atom-play" onClick={() => setPaused((p) => !p)}>
          {paused ? '▶' : '❚❚'}
          <span>{paused ? t('继续', 'Resume', 'Пуск') : t('暂停', 'Pause', 'Пауза')}</span>
        </button>
      </div>

      {view === 'bohr' && <BohrDiagram el={el} shells={shells} paused={paused} lang={lang} />}
      {view === 'orbital' && <OrbitalShapes el={el} paused={paused} lang={lang} />}
      {view === '3d' && <ThreeAtomView el={el} paused={paused} lang={lang} />}
      {view === 'orbital' && subshells.length > 0 && <LevelBoxes subshells={subshells} lang={lang} />}
    </div>
  )
}

function BohrDiagram({
  el, shells, paused, lang,
}: { el: Element; shells: number[]; paused: boolean; lang: Lang }) {
  const size = 220
  const c = size / 2
  const n = Math.max(shells.length, 1)
  const minR = 26
  const maxR = 92
  const step = n > 1 ? (maxR - minR) / (n - 1) : 0
  const shellNames = ['K', 'L', 'M', 'N', 'O', 'P', 'Q']
  return (
    <div className="ru-bohr-wrap">
      <div className="ru-bohr" data-paused={paused ? 'true' : 'false'}>
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${el.sym}: ${shells.join(', ')} e⁻`}>
          {shells.map((count, i) => {
            const r = minR + step * i
            const shown = Math.min(count, 32)
            return (
              <g key={i}>
                <circle className="ru-bohr-ring" cx={c} cy={c} r={r} />
                <g
                  className="ru-bohr-shell"
                  style={{
                    animationDuration: `${16 + i * 4}s`,
                    animationDirection: i % 2 ? 'reverse' : 'normal',
                  }}
                >
                  {Array.from({ length: shown }, (_, k) => {
                    const a = (k / shown) * Math.PI * 2
                    return (
                      <circle
                        key={k}
                        className="ru-bohr-e"
                        cx={c + Math.cos(a) * r}
                        cy={c + Math.sin(a) * r}
                        r={shown > 18 ? 1.7 : 2.5}
                      />
                    )
                  })}
                </g>
              </g>
            )
          })}
          <circle className="ru-bohr-nuc" cx={c} cy={c} r={13} />
          <text className="ru-bohr-sym" x={c} y={c} textAnchor="middle" dominantBaseline="central">{el.sym}</text>
        </svg>
      </div>
      <div className="ru-bohr-legend">
        {shells.map((count, i) => (
          <span key={i}><b>{shellNames[i] ?? i + 1}</b> {count}</span>
        ))}
        <em>{uiText(lang, '电子层分布（每层电子数）', 'Electron shells (electrons per shell)', 'Электронные слои')}</em>
      </div>
    </div>
  )
}

function OrbitalShapes({
  el, paused, lang,
}: { el: Element; paused: boolean; lang: Lang }) {
  const [rot, setRot] = React.useState({ x: -16, y: 22 })
  const dragRef = React.useRef<{ x: number; y: number; rx: number; ry: number } | null>(null)
  const block: 's' | 'p' | 'd' | 'f' = el.block === 'p' || el.block === 'd' || el.block === 'f' ? el.block : 's'
  const gid = `ru-orb-g-${el.z}`
  const lobes = (() => {
    const list: Array<{ cx: number; cy: number; rx: number; ry: number; angle: number }> = []
    if (block === 'p') {
      list.push({ cx: 56, cy: 100, rx: 38, ry: 22, angle: 0 })
      list.push({ cx: 144, cy: 100, rx: 38, ry: 22, angle: 0 })
    } else if (block === 'd') {
      for (const a of [45, 135, 225, 315]) list.push({ cx: 100 + Math.cos(a * Math.PI / 180) * 46, cy: 100 + Math.sin(a * Math.PI / 180) * 46, rx: 36, ry: 19, angle: a })
    } else if (block === 'f') {
      for (const a of [0, 60, 120, 180, 240, 300]) list.push({ cx: 100 + Math.cos(a * Math.PI / 180) * 44, cy: 100 + Math.sin(a * Math.PI / 180) * 44, rx: 32, ry: 16, angle: a })
    }
    return list
  })()
  const shapeName: Record<string, { zh: string; en: string; ru: string }> = {
    s: { zh: '球形电子云', en: 'spherical cloud', ru: 'сферическая' },
    p: { zh: '哑铃形（p 轨道）', en: 'dumbbell (p orbital)', ru: 'гантель (p)' },
    d: { zh: '四叶形（d 轨道）', en: 'four-lobed (d orbital)', ru: 'четырёхлепестковая (d)' },
    f: { zh: '六叶形（f 轨道）', en: 'six-lobed (f orbital)', ru: 'шестилепестковая (f)' },
  }
  return (
    <div className="ru-orb-wrap">
      <div
        className="ru-orb"
        data-paused={paused ? 'true' : 'false'}
        onPointerDown={(ev) => {
          dragRef.current = { x: ev.clientX, y: ev.clientY, rx: rot.x, ry: rot.y }
          ev.currentTarget.setPointerCapture(ev.pointerId)
        }}
        onPointerMove={(ev) => {
          const d = dragRef.current
          if (!d) return
          setRot({
            x: Math.max(-80, Math.min(80, d.rx - (ev.clientY - d.y) * 0.55)),
            y: d.ry + (ev.clientX - d.x) * 0.55,
          })
        }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
      >
        <div className="ru-orb-float">
          <div className="ru-orb-stage" style={{ transform: `rotateX(${rot.x}deg) rotateY(${rot.y}deg)` }}>
            <svg viewBox="0 0 200 200" aria-hidden="true">
              <defs>
                <radialGradient id={gid} cx="38%" cy="32%" r="72%">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0.22" />
                </radialGradient>
              </defs>
              <g className="ru-orb-axes">
                <line x1="100" y1="14" x2="100" y2="186" />
                <line x1="14" y1="100" x2="186" y2="100" />
                <circle cx="100" cy="100" r="64" />
              </g>
              {block === 's' ? (
                <circle className="ru-orb-lobe" cx="100" cy="100" r="48" fill={`url(#${gid})`} />
              ) : (
                lobes.map((l, i) => (
                  <ellipse
                    key={i}
                    className="ru-orb-lobe"
                    cx={l.cx}
                    cy={l.cy}
                    rx={l.rx}
                    ry={l.ry}
                    transform={l.angle ? `rotate(${l.angle} ${l.cx} ${l.cy})` : undefined}
                    fill={`url(#${gid})`}
                  />
                ))
              )}
              <circle className="ru-orb-nuc" cx="100" cy="100" r="6" />
            </svg>
          </div>
        </div>
      </div>
      <p className="ru-orb-caption">
        <b>{block}-{uiText(lang, '轨道', 'orbital', 'орбиталь')}</b> · {shapeName[block][lang]}
        <span className="ru-orb-hint">{uiText(lang, '拖拽旋转', 'drag to rotate', 'потяните, чтобы вращать')}</span>
      </p>
    </div>
  )
}

function LevelBoxes({ subshells, lang }: { subshells: Subshell[]; lang: Lang }) {
  return (
    <div className="ru-levels-wrap">
      <div className="ru-levels">
        {subshells.map((s, i) => (
          <div key={i} className="ru-level-box" title={`${s.n}${s.l}${s.count}`}>
            <span className="ru-level-label">{s.n}{s.l}<sup>{s.count}</sup></span>
            <span className="ru-level-cells">
              {fillArrows(s.count, SUBSHELL_CAP[s.l] ?? 2).map((a, k) => <i key={k}>{a}</i>)}
            </span>
          </div>
        ))}
      </div>
      <p className="ru-levels-note">
        {uiText(lang,
          '能级方块图：每个小格是一条轨道，箭头为电子自旋方向（洪特规则）',
          'Energy level boxes: each cell is one orbital, arrows are electron spins (Hund\'s rule)',
          'Энергетические ячейки: клетка — орбиталь, стрелки — спин (правило Хунда)')}
      </p>
    </div>
  )
}

function ThreeAtomView({ el, paused, lang }: { el: Element; paused: boolean; lang: Lang }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const pausedRef = React.useRef(paused)
  pausedRef.current = paused
  const buildRef = React.useRef<((item: Element) => void) | null>(null)
  const disposeRef = React.useRef<(() => void) | null>(null)

  React.useEffect(() => () => { disposeRef.current?.() }, [])

  // 切换元素时重建模型（three 已加载的情况下即时重建）
  React.useEffect(() => {
    if (phase === 'ready') buildRef.current?.(el)
  }, [el, phase])

  async function start() {
    if (phase === 'loading' || phase === 'ready') return
    setPhase('loading')
    try {
      const THREE = await import('three')
      const host = hostRef.current
      if (!host) { setPhase('idle'); return }

      const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setClearColor(0x000000, 0)
      host.appendChild(renderer.domElement)

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
      camera.position.set(0, 1.4, 5.6)
      camera.lookAt(0, 0, 0)
      scene.add(new THREE.AmbientLight(0xffffff, 0.9))
      const sun = new THREE.DirectionalLight(0xffffff, 1.1)
      sun.position.set(3, 5, 4)
      scene.add(sun)

      const root = new THREE.Group()
      scene.add(root)

      type Disposable = { geometry?: { dispose(): void }; material?: { dispose(): void } }
      const disposeObject = (obj: ThreeObject3D) => {
        obj.traverse((node) => {
          const mesh = node as unknown as Disposable
          mesh.geometry?.dispose()
          mesh.material?.dispose()
        })
      }

      let alive = true
      let raf = 0
      let last = performance.now()
      const resize = () => {
        const w = host.clientWidth || 240
        const h = Math.min(Math.max(w, 200), 300)
        renderer.setSize(w, h, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      resize()
      const ro = new ResizeObserver(resize)
      ro.observe(host)

      const loop = (now: number) => {
        if (!alive) return
        const dt = Math.min((now - last) / 1000, 0.05)
        last = now
        if (!pausedRef.current) root.rotation.y += dt * 0.45
        renderer.render(scene, camera)
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)

      disposeRef.current = () => {
        alive = false
        cancelAnimationFrame(raf)
        ro.disconnect()
        disposeObject(root)
        renderer.dispose()
        renderer.domElement.remove()
        disposeRef.current = null
      }

      buildRef.current = (item: Element) => {
        for (const child of [...root.children]) {
          root.remove(child)
          disposeObject(child)
        }
        const shells = parseShells(item.shells || '')
        const nucleus = new THREE.Mesh(
          new THREE.SphereGeometry(0.2, 20, 20),
          new THREE.MeshStandardMaterial({ color: 0x5de4c7, emissive: 0x0f4a3f }),
        )
        root.add(nucleus)
        const n = Math.max(shells.length, 1)
        shells.forEach((count, i) => {
          const radius = 0.5 + (2.1 * i) / Math.max(n - 1, 1)
          const group = new THREE.Group()
          group.rotation.x = (i % 2 ? 1 : -1) * (0.22 + i * 0.05)
          group.rotation.z = i * 0.4
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(radius, 0.008, 6, 72),
            new THREE.MeshBasicMaterial({ color: 0x82aaff, transparent: true, opacity: 0.5 }),
          )
          ring.rotation.x = Math.PI / 2
          group.add(ring)
          const shown = Math.min(count, 32)
          for (let k = 0; k < shown; k++) {
            const a = (k / shown) * Math.PI * 2
            const dot = new THREE.Mesh(
              new THREE.SphereGeometry(0.045, 8, 8),
              new THREE.MeshStandardMaterial({ color: 0xd9e1ec }),
            )
            dot.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius)
            group.add(dot)
          }
          root.add(group)
        })
        root.rotation.set(0.18, 0, 0)
      }
      buildRef.current(el)
      setPhase('ready')
    } catch {
      setPhase('error')
    }
  }

  return (
    <div className="ru-atom3d">
      <div className="ru-atom3d-host" ref={hostRef} aria-hidden="true" />
      {phase !== 'ready' && (
        <div className="ru-atom3d-gate">
          <button type="button" className="ru-atom3d-btn" onClick={() => void start()} disabled={phase === 'loading'}>
            {phase === 'loading'
              ? uiText(lang, '正在加载 WebGL…', 'Loading WebGL…', 'Загрузка WebGL…')
              : phase === 'error'
                ? uiText(lang, '加载失败，点击重试', 'Failed to load — click to retry', 'Ошибка, повторить')
                : uiText(lang, '启动 3D 模型', 'Start 3D model', 'Запустить 3D')}
          </button>
          <p className="ru-atom3d-note">
            {uiText(lang,
              '可选增强：three.js 约 600 KB，仅点击后按需下载；无 WebGL 时请使用 Bohr / 轨道视图。',
              'Optional: three.js (~600 KB) downloads only after you click. Without WebGL, use Bohr / orbitals.',
              'Опция: three.js ~600 КБ загружается только по клику. Без WebGL используйте Bohr / орбитали.')}
          </p>
        </div>
      )}
    </div>
  )
}
