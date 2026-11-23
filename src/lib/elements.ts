/**
 * 元素周期表数据层。
 *
 * 主源：Bowser/Periodic-Table-JSON（CC BY 3.0）— 提供 summary、image、网格坐标、共价半径等字段
 * 补全源：periodic-table-data-complete（MIT）— 提供丰度、同位素、氧化态、热学、晶体结构等字段
 * 经 scripts/extract-elements.mjs 合并站内三语名字（ru/zh/en）后生成 src/lib/elements.json。
 * 本文件提供 grid 布局、类别配色、单位换算、属性描述表等运行时工具。
 */
import elementsData from './elements.json' with { type: 'json' }
import elementImages from './element-images.json' with { type: 'json' }
import isotopesData from './isotopes.json' with { type: 'json' }

// ──────────────────────────────────────────────
// 基础类型
// ──────────────────────────────────────────────
export type Phase = 'Gas' | 'Liquid' | 'Solid' | 'Unknown' | ''
export type Block = 's' | 'p' | 'd' | 'f' | ''
export type Cat =
  | 'alkali' | 'alkaline' | 'transition' | 'post' | 'metalloid'
  | 'nonmetal' | 'halogen' | 'noble' | 'lanth' | 'act'

export interface Element {
  // === 基础布局 ===
  z: number
  sym: string
  en: string
  ru: string
  zh: string
  group: number
  period: number
  block: Block
  phase: Phase
  cat: Cat
  xpos: number // Bowser 主源网格 x 坐标（1-18）
  ypos: number // Bowser 主源网格 y 坐标（1-7，镧系/锕系 9/10）
  // === 物理属性 ===
  mass: number | null
  cpk: string
  appearance: string
  // === 热力学 ===
  mpK: number | null
  bpK: number | null
  density: number | null // g/cm³（自动转换）
  densityUnit: string // 原始单位字符串
  // === 化学属性 ===
  eneg: number | null
  eaff: number | null
  ox: string
  // === 半径（pm） ===
  rEmp: number | null
  rCalc: number | null
  rvdw: number | null
  rCovSingle: number | null
  rCovTriple: number | null
  rMetallic: number | null
  // === 电离能 ===
  ie: number[]
  // === 热学 ===
  heatSp: number | null
  heatFus: number | null
  heatVap: number | null
  molarHeat: number | null
  // === 丰度（%） ===
  abUniv: number | null
  abSolar: number | null
  abCrust: number | null
  abOcean: number | null
  abHuman: number | null
  // === 电子结构 ===
  eConf: string
  eConfSem: string
  shells: string
  valE: number | null
  // === 同位素 & 放射性 ===
  isoKnown: string
  isoStable: string
  isoAbund: string
  halfLife: string | number | null
  lifetime: string | number | null
  // === 发现 ===
  discYear: number | null
  discoveredBy: string
  namedBy: string
  // === 简介 & 图片（CC BY 3.0 署名） ===
  summary: string
  appearanceImgUrl: string
  appearanceImgAttribution: string
  appearanceImgTitle: string
  // 自托管图片清单（src/lib/element-images.json）覆盖后的附加签名信息
  imageCredit: string
  imageLicense: string
  imageLicenseUrl: string
  imageSourceUrl: string
  imageProvider: string
  imagePlaceholder: boolean
  imageNote: string
  bohrImgUrl: string
  bohr3dUrl: string
  spectralImgUrl: string
  // === 晶体结构 ===
  crystalStructure: string
  latticeConstants: string
  latticeAngles: string
  spaceGroupName: string
  spaceGroupNumber: number | null
  // === 导电/导热 ===
  conductThermal: number | null
  // === 链接 ===
  wiki: string
}

/**
 * elements.json 为紧凑编码：每行是一个值数组，字段顺序由 FIELDS 决定。
 * 64 个字段名只写一次，数据文件从 326KB 降到 194KB（≈40%）。
 * 修改数据时请保持行内值的顺序与 FIELDS 完全一致。
 */
const FIELDS = [
  'z', 'sym', 'en', 'ru', 'zh', 'group', 'period', 'block', 'phase', 'cat', 'xpos', 'ypos',
  'mass', 'cpk', 'appearance', 'mpK', 'bpK', 'density', 'densityUnit', 'eneg', 'eaff', 'ox',
  'rEmp', 'rCalc', 'rvdw', 'rCovSingle', 'rCovTriple', 'rMetallic', 'ie', 'heatSp', 'heatFus',
  'heatVap', 'molarHeat', 'abUniv', 'abSolar', 'abCrust', 'abOcean', 'abHuman', 'eConf',
  'eConfSem', 'shells', 'valE', 'isoKnown', 'isoStable', 'isoAbund', 'halfLife', 'lifetime',
  'discYear', 'discoveredBy', 'namedBy', 'summary', 'appearanceImgUrl', 'appearanceImgAttribution',
  'appearanceImgTitle', 'bohrImgUrl', 'bohr3dUrl', 'spectralImgUrl', 'crystalStructure',
  'latticeConstants', 'latticeAngles', 'spaceGroupName', 'spaceGroupNumber', 'conductThermal', 'wiki',
] as const satisfies readonly (keyof Element)[]

type Cell = string | number | number[] | null

export const ELEMENTS: Element[] = (elementsData as unknown as Cell[][]).map((row) => {
  const out: Record<string, Cell> = {}
  for (let i = 0; i < FIELDS.length; i++) out[FIELDS[i]] = row[i]
  return out as unknown as Element
})
export const ELEMENT_BY_Z: Record<number, Element> = Object.fromEntries(ELEMENTS.map((e) => [e.z, e]))

// ──────────────────────────────────────────────
// 逐核素同位素数据（scripts/build-isotopes.py 生成）。
// 每个核素为紧凑数组：
//   [质量数A, 原子质量(u), 天然丰度%, 稳定?, 衰变方式串, 半衰期数值, 半衰期单位]
// 稳定核素的半衰期字段为 null / ""；衰变方式串形如 "A(100%), SF(5.44%)"。
// ──────────────────────────────────────────────
export type IsotopeRow = [number, number | null, number | null, boolean, string, number | null, string]
export const ISOTOPES: Record<string, IsotopeRow[]> = isotopesData as unknown as Record<string, IsotopeRow[]>


// ──────────────────────────────────────────────
// 实物图：用自托管清单（scripts/fetch-element-images.mjs 生成）覆盖源数据里的外链。
// 全部指向 /elements/<z>.<ext>，与站点同源同 CDN；104–118 无实物照片，标记占位。
// ──────────────────────────────────────────────
interface ElementImageEntry {
  src?: string
  title?: string
  credit?: string
  license?: string
  licenseUrl?: string
  sourceUrl?: string
  provider?: string
  placeholder?: boolean
  note?: string
}
const IMAGES = elementImages as Record<string, ElementImageEntry>
for (const e of ELEMENTS) {
  const img = IMAGES[String(e.z)] ?? {}
  e.appearanceImgUrl = img.src ?? ''
  e.appearanceImgTitle = img.title ?? ''
  e.appearanceImgAttribution = img.credit
    ? `${img.credit}${img.license ? ` · ${img.license}` : ''}`
    : ''
  e.imageCredit = img.credit ?? ''
  e.imageLicense = img.license ?? ''
  e.imageLicenseUrl = img.licenseUrl ?? ''
  e.imageSourceUrl = img.sourceUrl ?? ''
  e.imageProvider = img.provider ?? ''
  e.imagePlaceholder = img.placeholder === true
  e.imageNote = img.note ?? ''
}


// ──────────────────────────────────────────────
// 周期表网格坐标。
// Bowser 主源已提供 xpos（列 1-18）/ ypos（行 1-7，镧系 9，锕系 10），
// 直接返回即可；若个别元素缺失则回退到传统计算。
// 返回 [行 ypos, 列 xpos]。
// ──────────────────────────────────────────────
export function elGridPos(z: number): [number, number] {
  const e = ELEMENT_BY_Z[z]
  if (e?.xpos && e?.ypos) return [e.ypos, e.xpos]
  // 回退：极端情况用传统算法
  if (z === 1) return [1, 1]
  if (z === 2) return [1, 18]
  if (z >= 58 && z <= 71) return [9, z - 54]
  if (z >= 90 && z <= 103) return [10, z - 86]
  if (z <= 57) return [z < 58 ? 6 : 6, z <= 57 ? z - 54 : 0]
  if (z <= 86) return [6, z - 68]
  return [7, z - 100]
}

// ──────────────────────────────────────────────
// 族号表头（中国/国际通用 IUPAC 1–18；俄国教材传统 I–VIII 族 + A/B 标注）
// ──────────────────────────────────────────────
export const GROUP_LABELS_CN = ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18']
export const GROUP_LABELS_RU = ['IA','IIA','IIIB','IVB','VB','VIB','VIIB','VIIIB','VIIIB','VIIIB','IB','IIB','IIIA','IVA','VA','VIA','VIIA','VIIIA']

// ──────────────────────────────────────────────
// 颜色：按类别（默认分类）
// 与 src/styles.css 中 .ru-el[data-c=xxx] 保持一致
// ──────────────────────────────────────────────
export const CAT_LABELS: Record<Cat, { ru: string; zh: string; en: string }> = {
  alkali:     { ru: 'Щелочные металлы',   zh: '碱金属',     en: 'Alkali metals' },
  alkaline:   { ru: 'Щелочноземельные',   zh: '碱土金属',   en: 'Alkaline earth metals' },
  transition: { ru: 'Переходные металлы', zh: '过渡金属',   en: 'Transition metals' },
  post:       { ru: 'Постпереходные',     zh: '贫金属',     en: 'Post-transition metals' },
  metalloid:  { ru: 'Металлоиды',         zh: '类金属',     en: 'Metalloids' },
  nonmetal:   { ru: 'Неметаллы',          zh: '非金属',     en: 'Nonmetals' },
  halogen:    { ru: 'Галогены',           zh: '卤素',       en: 'Halogens' },
  noble:      { ru: 'Благородные газы',   zh: '稀有气体',   en: 'Noble gases' },
  lanth:      { ru: 'Лантаноиды',         zh: '镧系',       en: 'Lanthanoids' },
  act:        { ru: 'Актиноиды',          zh: '锕系',       en: 'Actinoids' },
}

export const CAT_ORDER: Cat[] = ['alkali','alkaline','transition','post','metalloid','nonmetal','halogen','noble','lanth','act']

// ──────────────────────────────────────────────
// 颜色：按相态（物质状态）
// ──────────────────────────────────────────────
export const PHASE_COLORS: Record<Phase, string> = {
  Gas: '#7fb3ff',        // 浅蓝
  Liquid: '#ff8c9e',     // 浅红
  Solid: '#a0dca0',      // 浅绿
  Unknown: '#d4d4d4',
  '': '#d4d4d4',
}

// ──────────────────────────────────────────────
// 单位换算
// ──────────────────────────────────────────────
export function kelvinToCelsius(k: number | null): number | null {
  return k == null ? null : +(k - 273.15).toFixed(2)
}
export function kelvinToFahrenheit(k: number | null): number | null {
  return k == null ? null : +((k - 273.15) * 9 / 5 + 32).toFixed(2)
}

// kJ/mol ↔ eV：1 eV ≈ 96.485 kJ/mol
const EV_PER_KJMOL = 1 / 96.485
export function kjPerMolToEv(v: number | null): number | null {
  return v == null ? null : +(v * EV_PER_KJMOL).toFixed(4)
}

// 密度：源数据为 kg/m³，固体通常希望 g/cm³（= kg/m³ / 1000）
export function densityToGcm3(v: number | null): number | null {
  // 轻元素（H/He）STP 下的密度本身非常小（kg/m³ ≈ 0.09），除以 1000 后几乎为 0
  // 这里简单处理：kg/m³ → g/cm³，显示时由 UI 决定单位
  return v == null ? null : +(v / 1000).toFixed(6)
}

// ──────────────────────────────────────────────
// 颜色映射（数值字段 → 色阶）
// 输入 value（可为 null），全表 min/max，返回 HSL 色或 null
// ──────────────────────────────────────────────
export function colorScale(
  value: number | null,
  min: number,
  max: number,
  hueStart = 220, // 冷色蓝
  hueEnd = 0,     // 暖色红
  log = false,
): string | null {
  if (value == null || Number.isNaN(value)) return null
  let t: number
  if (log) {
    const mn = Math.log10(Math.max(min, 1e-10))
    const mx = Math.log10(Math.max(max, 1e-10))
    const vv = Math.log10(Math.max(value, 1e-10))
    t = (vv - mn) / (mx - mn)
  } else {
    t = (value - min) / (max - min)
  }
  t = Math.max(0, Math.min(1, t))
  const hue = hueStart + (hueEnd - hueStart) * t
  const lightness = 55 - 15 * t // 高值更深
  return `hsl(${hue}, 70%, ${lightness}%)`
}

/** 取出指定数值字段的全表 min/max（跳过 null/NaN） */
export function fieldRange(
  getter: (e: Element) => number | null,
): { min: number; max: number; values: number[] } {
  const values = ELEMENTS.map(getter).filter((v): v is number => v != null && !Number.isNaN(v))
  return { min: Math.min(...values), max: Math.max(...values), values }
}

// ──────────────────────────────────────────────
// 属性描述表（i18n 字段名，zh/ru/en）
// ptable.com 风格分组：基础、热力学、化学、原子、结构、发现、图片
// ──────────────────────────────────────────────
export type PropKey =
  | 'mass' | 'phase' | 'density' | 'cpk' | 'appearance'
  | 'mpK' | 'bpK' | 'heatFus' | 'heatVap' | 'heatSp' | 'molarHeat'
  | 'eneg' | 'eaff' | 'ox'
  | 'rCalc' | 'rEmp' | 'rCovSingle' | 'rCovTriple' | 'rMetallic' | 'rvdw'
  | 'ie1' | 'ie2'
  | 'block' | 'group' | 'period' | 'eConf' | 'eConfSem' | 'shells' | 'valE'
  | 'discYear' | 'discoveredBy' | 'namedBy'
  | 'abUniv' | 'abSolar' | 'abCrust' | 'abOcean' | 'abHuman'
  | 'crystalStructure' | 'latticeConstants' | 'latticeAngles' | 'spaceGroupName'
  | 'conductThermal' | 'halfLife'
  | 'summary' | 'appearanceImgUrl' | 'wiki'

export interface PropDef {
  key: PropKey
  ru: string
  zh: string
  en: string
  units?: { ru: string; zh: string; en: string }
  section?: 'base' | 'thermo' | 'chem' | 'radius' | 'ie' | 'struct' | 'disc' | 'abund' | 'crystal' | 'image'
}

export const PROP_DEFS: PropDef[] = [
  // === 基础 ===
  { key: 'mass',      ru: 'Атомная масса',   zh: '原子量',     en: 'Atomic mass',         units: { ru: 'u', zh: 'u', en: 'u' }, section: 'base' },
  { key: 'phase',     ru: 'Агрегатное сост.', zh: '物质状态',   en: 'State at STP', section: 'base' },
  { key: 'density',   ru: 'Плотность (STP)', zh: '密度（标况）', en: 'Density (STP)', units: { ru: 'g/cm³', zh: 'g/cm³', en: 'g/cm³' }, section: 'base' },
  { key: 'cpk',       ru: 'CPK цвет', zh: 'CPK 颜色', en: 'CPK color', section: 'base' },
  { key: 'appearance',ru: 'Внешний вид', zh: '外观描述', en: 'Appearance', section: 'base' },
  // === 热力学 ===
  { key: 'mpK',       ru: 'Температура плавления', zh: '熔点',   en: 'Melting point', section: 'thermo' },
  { key: 'bpK',       ru: 'Температура кипения', zh: '沸点',       en: 'Boiling point', section: 'thermo' },
  { key: 'heatFus',   ru: 'Энтальпия плавления', zh: '熔化焓',     en: 'Enthalpy of fusion', units: { ru: 'kJ/mol', zh: 'kJ/mol', en: 'kJ/mol' }, section: 'thermo' },
  { key: 'heatVap',   ru: 'Энтальпия испарения', zh: '汽化焓',   en: 'Enthalpy of vaporization', units: { ru: 'kJ/mol', zh: 'kJ/mol', en: 'kJ/mol' }, section: 'thermo' },
  { key: 'heatSp',    ru: 'Удельная теплоёмкость', zh: '比热容',  en: 'Specific heat capacity', units: { ru: 'J/kg·K', zh: 'J/kg·K', en: 'J/kg·K' }, section: 'thermo' },
  { key: 'molarHeat', ru: 'Молярная теплоёмкость', zh: '摩尔热容', en: 'Molar heat capacity', units: { ru: 'J/(mol·K)', zh: 'J/(mol·K)', en: 'J/(mol·K)' }, section: 'thermo' },
  // === 化学 ===
  { key: 'eneg',      ru: 'Электроотрицательность', zh: '电负性', en: 'Electronegativity (Pauling)', section: 'chem' },
  { key: 'eaff',      ru: 'Сродство к электрону', zh: '电子亲合能', en: 'Electron affinity', units: { ru: 'kJ/mol', zh: 'kJ/mol', en: 'kJ/mol' }, section: 'chem' },
  { key: 'ox',        ru: 'Степени окисления', zh: '氧化态',     en: 'Oxidation states', section: 'chem' },
  // === 半径 ===
  { key: 'rCalc',     ru: 'Радиус (расчётный)', zh: '半径（计算）', en: 'Calculated radius', units: { ru: 'pm', zh: 'pm', en: 'pm' }, section: 'radius' },
  { key: 'rEmp',      ru: 'Радиус (эмпирический)', zh: '半径（经验）', en: 'Empirical radius', units: { ru: 'pm', zh: 'pm', en: 'pm' }, section: 'radius' },
  { key: 'rCovSingle',ru: 'Ковалентный (одинарный)', zh: '共价（单键）', en: 'Covalent (single bond)', units: { ru: 'pm', zh: 'pm', en: 'pm' }, section: 'radius' },
  { key: 'rCovTriple',ru: 'Ковалентный (тройной)', zh: '共价（三键）', en: 'Covalent (triple bond)', units: { ru: 'pm', zh: 'pm', en: 'pm' }, section: 'radius' },
  { key: 'rMetallic', ru: 'Металлический радиус', zh: '金属半径',   en: 'Metallic radius', units: { ru: 'pm', zh: 'pm', en: 'pm' }, section: 'radius' },
  { key: 'rvdw',      ru: 'Радиус ван дер Ваальса', zh: '范德华半径', en: 'Van der Waals radius', units: { ru: 'pm', zh: 'pm', en: 'pm' }, section: 'radius' },
  // === 电离能 ===
  { key: 'ie1',       ru: 'Энергия ионизации, 1', zh: '第一电离能', en: '1st ionization energy', units: { ru: 'kJ/mol', zh: 'kJ/mol', en: 'kJ/mol' }, section: 'ie' },
  { key: 'ie2',       ru: 'Энергия ионизации, 2', zh: '第二电离能', en: '2nd ionization energy', units: { ru: 'kJ/mol', zh: 'kJ/mol', en: 'kJ/mol' }, section: 'ie' },
  // === 电子结构 ===
  { key: 'block',     ru: 'Блок', zh: '区', en: 'Block', section: 'struct' },
  { key: 'group',     ru: 'Группа', zh: '族', en: 'Group', section: 'struct' },
  { key: 'period',    ru: 'Период', zh: '周期', en: 'Period', section: 'struct' },
  { key: 'eConf',     ru: 'Конфигурация', zh: '电子构型', en: 'Electron configuration', section: 'struct' },
  { key: 'eConfSem',  ru: 'Конфигурация (сем.)', zh: '简写构型', en: 'Semantic configuration', section: 'struct' },
  { key: 'shells',    ru: 'Электронов по слоям', zh: '每层电子数', en: 'Electrons per shell', section: 'struct' },
  { key: 'valE',      ru: 'Валентных электронов', zh: '价电子数', en: 'Valence electrons', section: 'struct' },
  // === 发现 ===
  { key: 'discYear',  ru: 'Год открытия', zh: '发现年份', en: 'Discovered (year)', section: 'disc' },
  { key: 'discoveredBy', ru: 'Кто открыл', zh: '发现者', en: 'Discovered by', section: 'disc' },
  { key: 'namedBy',   ru: 'Кто назвал', zh: '命名者', en: 'Named by', section: 'disc' },
  { key: 'halfLife',  ru: 'Период полураспада', zh: '半衰期', en: 'Half-life', section: 'disc' },
  // === 丰度 ===
  { key: 'abUniv',    ru: 'Космос', zh: '宇宙', en: 'Universe abundance', units: { ru: '%', zh: '%', en: '%' }, section: 'abund' },
  { key: 'abSolar',   ru: 'Солнечная система', zh: '太阳系', en: 'Solar system', units: { ru: '%', zh: '%', en: '%' }, section: 'abund' },
  { key: 'abCrust',   ru: 'Земная кора', zh: '地壳', en: 'Crust', units: { ru: '%', zh: '%', en: '%' }, section: 'abund' },
  { key: 'abOcean',   ru: 'Океан', zh: '海洋', en: 'Ocean', units: { ru: '%', zh: '%', en: '%' }, section: 'abund' },
  { key: 'abHuman',   ru: 'Человеческое тело', zh: '人体', en: 'Human body', units: { ru: '%', zh: '%', en: '%' }, section: 'abund' },
  // === 晶体结构 ===
  { key: 'crystalStructure', ru: 'Кристалл. решётка', zh: '晶体结构', en: 'Crystal structure', section: 'crystal' },
  { key: 'latticeConstants', ru: 'Константы решётки', zh: '晶格常数', en: 'Lattice constants', section: 'crystal' },
  { key: 'latticeAngles', ru: 'Углы решётки', zh: '晶格角度', en: 'Lattice angles', section: 'crystal' },
  { key: 'spaceGroupName', ru: 'Пространственная группа', zh: '空间群', en: 'Space group', section: 'crystal' },
  { key: 'conductThermal', ru: 'Теплопроводность', zh: '导热系数', en: 'Thermal conductivity', units: { ru: 'W/(m·K)', zh: 'W/(m·K)', en: 'W/(m·K)' }, section: 'crystal' },
]

// ──────────────────────────────────────────────
// 衰变方式三语标签。
// 常规模式（A/B-/B+/EC/SF/2B-/2B+…）直接查表；
// 簇衰变（如 14C、22Ne、28Mg）为「数字+元素符号」，走 fallback：
//   zh: 簇衰变 ¹⁴C / en: cluster ¹⁴C / ru: кластерный ¹⁴C
// ──────────────────────────────────────────────
const DECAY_MODE_LABELS: Record<string, { zh: string; en: string; ru: string }> = {
  A:   { zh: 'α',        en: 'α',       ru: 'α' },
  'B-':  { zh: 'β⁻',      en: 'β⁻',     ru: 'β⁻' },
  'B+':  { zh: 'β⁺',      en: 'β⁺',     ru: 'β⁺' },
  EC:  { zh: '电子俘获', en: 'EC',      ru: 'ЭЗ' },
  SF:  { zh: '自发裂变', en: 'SF',      ru: 'СД' },
  IT:  { zh: '同质异能跃迁', en: 'IT',  ru: 'ИП' },
  n:   { zh: '中子发射', en: 'n',       ru: 'n' },
  p:   { zh: '质子发射', en: 'p',       ru: 'p' },
  '2n':  { zh: '双中子', en: '2n',      ru: '2n' },
  '2p':  { zh: '双质子', en: '2p',      ru: '2p' },
  '2B-': { zh: '双β⁻',   en: '2β⁻',     ru: '2β⁻' },
  '2B+': { zh: '双β⁺',   en: '2β⁺',     ru: '2β⁺' },
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
}
function toSup(s: string): string {
  return s.split('').map((c) => SUPERSCRIPT[c] ?? c).join('')
}

/** 将单个衰变方式代码（含强度）翻译为三语标签，例如 "A(100%)" → "α(100%)" */
export function decayModeLabel(code: string, lang: 'zh' | 'en' | 'ru'): string {
  const m = code.match(/^([^(]+)(\([^)]*\))?$/)
  if (!m) return code
  const base = m[1].trim()
  const intensity = m[2] ?? ''
  const label = DECAY_MODE_LABELS[base]
  if (label) return `${label[lang]}${intensity}`
  // 簇衰变：数字开头 + 元素符号
  const cluster = base.match(/^(\d+)([A-Z][a-z]?)$/)
  if (cluster) {
    const sup = toSup(cluster[1])
    const el = cluster[2]
    if (lang === 'zh') return `簇衰变 ${sup}${el}${intensity}`
    if (lang === 'en') return `cluster ${sup}${el}${intensity}`
    return `кластерный ${sup}${el}${intensity}`
  }
  return code
}

// ──────────────────────────────────────────────
// 半衰期单位三语映射（含 SI 前缀年）。
// 源数据单位：nsec, usec, msec, sec, minute, hour, day,
//   year, kyear, Myear, Gyear, Tyear, Pyear, Eyear, Zyear, Yyear
// ──────────────────────────────────────────────
const HALF_LIFE_UNITS: Record<string, { zh: string; en: string; ru: string }> = {
  nsec:    { zh: '纳秒', en: 'ns',  ru: 'нс' },
  usec:    { zh: '微秒', en: 'μs',  ru: 'мкс' },
  msec:    { zh: '毫秒', en: 'ms',  ru: 'мс' },
  sec:     { zh: '秒',   en: 's',   ru: 'с' },
  minute:  { zh: '分',   en: 'min', ru: 'мин' },
  hour:    { zh: '时',   en: 'h',   ru: 'ч' },
  day:     { zh: '天',   en: 'd',   ru: 'сут' },
  year:    { zh: '年',   en: 'a',   ru: 'лет' },
  kyear:   { zh: '千年', en: 'ka',  ru: 'тыс. лет' },
  Myear:   { zh: '百万年', en: 'Ma', ru: 'млн лет' },
  Gyear:   { zh: '十亿年', en: 'Ga', ru: 'млрд лет' },
  Tyear:   { zh: '万亿年', en: 'Ta', ru: 'трлн лет' },
  Pyear:   { zh: '千万亿年', en: 'Pa', ru: 'квадр. лет' },
  Eyear:   { zh: '百亿亿年', en: 'Ea', ru: 'квинт. лет' },
  Zyear:   { zh: '泽它年', en: 'Za', ru: 'зетталет' },
  Yyear:   { zh: '尧它年', en: 'Ya', ru: 'иотталет' },
}

/** 格式化半衰期：数值 + 本地化单位，例如 4.463, 'Gyear' → "4.46 Ga" */
export function fmtHalfLifeUnit(v: number | null, unit: string, lang: 'zh' | 'en' | 'ru'): string {
  if (v == null || !unit) return '—'
  const u = HALF_LIFE_UNITS[unit]
  const label = u ? u[lang] : unit
  return `${v} ${label}`
}

