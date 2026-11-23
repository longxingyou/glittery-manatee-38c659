// 元素数据集提取脚本。
// 主源：Bowser/Periodic-Table-JSON（CC BY 3.0 许可）— 提供 summary、image、网格坐标、共价半径等新字段
// 补全源：periodic-table-data-complete（MIT 许可）— 提供丰度、同位素、氧化态、热学、晶体结构等字段
// 运行：node scripts/extract-elements.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BOWSER = path.join(ROOT, '.cache', 'bowser-pt.json')
const MIT = path.join(ROOT, '.cache', 'pTable.json')
const OUT = path.join(ROOT, 'src', 'lib', 'elements.json')

for (const [label, p] of [['Bowser 主源', BOWSER], ['MIT 补全源', MIT]]) {
  if (!fs.existsSync(p)) { console.error(`找不到${label}：${p}`); process.exit(1) }
}

// 站内硬编码的三语名字
const NAMES = {
  1:  { ru: 'Водород', zh: '氢', en: 'Hydrogen' },
  2:  { ru: 'Гелий', zh: '氦', en: 'Helium' },
  3:  { ru: 'Литий', zh: '锂', en: 'Lithium' },
  4:  { ru: 'Бериллий', zh: '铍', en: 'Beryllium' },
  5:  { ru: 'Бор', zh: '硼', en: 'Boron' },
  6:  { ru: 'Углерод', zh: '碳', en: 'Carbon' },
  7:  { ru: 'Азот', zh: '氮', en: 'Nitrogen' },
  8:  { ru: 'Кислород', zh: '氧', en: 'Oxygen' },
  9:  { ru: 'Фтор', zh: '氟', en: 'Fluorine' },
  10: { ru: 'Неон', zh: '氖', en: 'Neon' },
  11: { ru: 'Натрий', zh: '钠', en: 'Sodium' },
  12: { ru: 'Магний', zh: '镁', en: 'Magnesium' },
  13: { ru: 'Алюминий', zh: '铝', en: 'Aluminium' },
  14: { ru: 'Кремний', zh: '硅', en: 'Silicon' },
  15: { ru: 'Фосфор', zh: '磷', en: 'Phosphorus' },
  16: { ru: 'Сера', zh: '硫', en: 'Sulfur' },
  17: { ru: 'Хлор', zh: '氯', en: 'Chlorine' },
  18: { ru: 'Аргон', zh: '氩', en: 'Argon' },
  19: { ru: 'Калий', zh: '钾', en: 'Potassium' },
  20: { ru: 'Кальций', zh: '钙', en: 'Calcium' },
  21: { ru: 'Скандий', zh: '钪', en: 'Scandium' },
  22: { ru: 'Титан', zh: '钛', en: 'Titanium' },
  23: { ru: 'Ванадий', zh: '钒', en: 'Vanadium' },
  24: { ru: 'Хром', zh: '铬', en: 'Chromium' },
  25: { ru: 'Марганец', zh: '锰', en: 'Manganese' },
  26: { ru: 'Железо', zh: '铁', en: 'Iron' },
  27: { ru: 'Кобальт', zh: '钴', en: 'Cobalt' },
  28: { ru: 'Никель', zh: '镍', en: 'Nickel' },
  29: { ru: 'Медь', zh: '铜', en: 'Copper' },
  30: { ru: 'Цинк', zh: '锌', en: 'Zinc' },
  31: { ru: 'Галлий', zh: '镓', en: 'Gallium' },
  32: { ru: 'Германий', zh: '锗', en: 'Germanium' },
  33: { ru: 'Мышьяк', zh: '砷', en: 'Arsenic' },
  34: { ru: 'Селен', zh: '硒', en: 'Selenium' },
  35: { ru: 'Бром', zh: '溴', en: 'Bromine' },
  36: { ru: 'Криптон', zh: '氪', en: 'Krypton' },
  37: { ru: 'Рубидий', zh: '铷', en: 'Rubidium' },
  38: { ru: 'Стронций', zh: '锶', en: 'Strontium' },
  39: { ru: 'Иттрий', zh: '钇', en: 'Yttrium' },
  40: { ru: 'Цирконий', zh: '锆', en: 'Zirconium' },
  41: { ru: 'Ниобий', zh: '铌', en: 'Niobium' },
  42: { ru: 'Молибден', zh: '钼', en: 'Molybdenum' },
  43: { ru: 'Технеций', zh: '锝', en: 'Technetium' },
  44: { ru: 'Рутений', zh: '钌', en: 'Ruthenium' },
  45: { ru: 'Родий', zh: '铑', en: 'Rhodium' },
  46: { ru: 'Палладий', zh: '钯', en: 'Palladium' },
  47: { ru: 'Серебро', zh: '银', en: 'Silver' },
  48: { ru: 'Кадмий', zh: '镉', en: 'Cadmium' },
  49: { ru: 'Индий', zh: '铟', en: 'Indium' },
  50: { ru: 'Олово', zh: '锡', en: 'Tin' },
  51: { ru: 'Сурьма', zh: '锑', en: 'Antimony' },
  52: { ru: 'Теллур', zh: '碲', en: 'Tellurium' },
  53: { ru: 'Иод', zh: '碘', en: 'Iodine' },
  54: { ru: 'Ксенон', zh: '氙', en: 'Xenon' },
  55: { ru: 'Цезий', zh: '铯', en: 'Caesium' },
  56: { ru: 'Барий', zh: '钡', en: 'Barium' },
  57: { ru: 'Лантан', zh: '镧', en: 'Lanthanum' },
  58: { ru: 'Церий', zh: '铈', en: 'Cerium' },
  59: { ru: 'Празеодим', zh: '镨', en: 'Praseodymium' },
  60: { ru: 'Неодим', zh: '钕', en: 'Neodymium' },
  61: { ru: 'Прометий', zh: '钷', en: 'Promethium' },
  62: { ru: 'Самарий', zh: '钐', en: 'Samarium' },
  63: { ru: 'Европий', zh: '铕', en: 'Europium' },
  64: { ru: 'Гадолиний', zh: '钆', en: 'Gadolinium' },
  65: { ru: 'Тербий', zh: '铽', en: 'Terbium' },
  66: { ru: 'Диспрозий', zh: '镝', en: 'Dysprosium' },
  67: { ru: 'Гольмий', zh: '钬', en: 'Holmium' },
  68: { ru: 'Эрбий', zh: '铒', en: 'Erbium' },
  69: { ru: 'Тулий', zh: '铥', en: 'Thulium' },
  70: { ru: 'Иттербий', zh: '镱', en: 'Ytterbium' },
  71: { ru: 'Лютеций', zh: '镥', en: 'Lutetium' },
  72: { ru: 'Гафний', zh: '铪', en: 'Hafnium' },
  73: { ru: 'Тантал', zh: '钽', en: 'Tantalum' },
  74: { ru: 'Вольфрам', zh: '钨', en: 'Tungsten' },
  75: { ru: 'Рений', zh: '铼', en: 'Rhenium' },
  76: { ru: 'Осмий', zh: '锇', en: 'Osmium' },
  77: { ru: 'Иридий', zh: '铱', en: 'Iridium' },
  78: { ru: 'Платина', zh: '铂', en: 'Platinum' },
  79: { ru: 'Золото', zh: '金', en: 'Gold' },
  80: { ru: 'Ртуть', zh: '汞', en: 'Mercury' },
  81: { ru: 'Таллий', zh: '铊', en: 'Thallium' },
  82: { ru: 'Свинец', zh: '铅', en: 'Lead' },
  83: { ru: 'Висмут', zh: '铋', en: 'Bismuth' },
  84: { ru: 'Полоний', zh: '钋', en: 'Polonium' },
  85: { ru: 'Астат', zh: '砹', en: 'Astatine' },
  86: { ru: 'Радон', zh: '氡', en: 'Radon' },
  87: { ru: 'Франций', zh: '钫', en: 'Francium' },
  88: { ru: 'Радий', zh: '镭', en: 'Radium' },
  89: { ru: 'Актиний', zh: '锕', en: 'Actinium' },
  90: { ru: 'Торий', zh: '钍', en: 'Thorium' },
  91: { ru: 'Протактиний', zh: '镤', en: 'Protactinium' },
  92: { ru: 'Уран', zh: '铀', en: 'Uranium' },
  93: { ru: 'Нептуний', zh: '镎', en: 'Neptunium' },
  94: { ru: 'Плутоний', zh: '钚', en: 'Plutonium' },
  95: { ru: 'Америций', zh: '镅', en: 'Americium' },
  96: { ru: 'Кюрий', zh: '锔', en: 'Curium' },
  97: { ru: 'Берклий', zh: '锫', en: 'Berkelium' },
  98: { ru: 'Калифорний', zh: '锎', en: 'Californium' },
  99: { ru: 'Эйнштейний', zh: '锿', en: 'Einsteinium' },
  100: { ru: 'Фермий', zh: '镄', en: 'Fermium' },
  101: { ru: 'Менделевий', zh: '钔', en: 'Mendelevium' },
  102: { ru: 'Нобелий', zh: '锘', en: 'Nobelium' },
  103: { ru: 'Лоуренсий', zh: '铹', en: 'Lawrencium' },
  104: { ru: 'Резерфордий', zh: '𬬻', en: 'Rutherfordium' },
  105: { ru: 'Дубний', zh: '𬭊', en: 'Dubnium' },
  106: { ru: 'Сиборгий', zh: '𬭳', en: 'Seaborgium' },
  107: { ru: 'Борий', zh: '𬭛', en: 'Bohrium' },
  108: { ru: 'Хассий', zh: '𬭶', en: 'Hassium' },
  109: { ru: 'Мейтнерий', zh: '鿏', en: 'Meitnerium' },
  110: { ru: 'Дармштадтий', zh: '𫟼', en: 'Darmstadtium' },
  111: { ru: 'Рентгений', zh: '𬬭', en: 'Roentgenium' },
  112: { ru: 'Коперниций', zh: '鎶', en: 'Copernicium' },
  113: { ru: 'Нихоний', zh: '鉨', en: 'Nihonium' },
  114: { ru: 'Флеровий', zh: '𫓧', en: 'Flerovium' },
  115: { ru: 'Московий', zh: '镆', en: 'Moscovium' },
  116: { ru: 'Ливерморий', zh: '鉝', en: 'Livermorium' },
  117: { ru: 'Теннессин', zh: '鿬', en: 'Tennessine' },
  118: { ru: 'Оганесон', zh: '鿫', en: 'Oganesson' },
}

const bowser = JSON.parse(fs.readFileSync(BOWSER, 'utf8')).elements
const mit = JSON.parse(fs.readFileSync(MIT, 'utf8'))
const mitByZ = new Map(mit.map((e) => [e.atomic_number, e]))

const out = bowser
  .filter((e) => e.number <= 118)
  .map((b) => {
    const m = mitByZ.get(b.number) ?? {}
    const names = NAMES[b.number] ?? { ru: '', zh: '', en: b.name }
    const r = b.atomic_radii ?? {}
    const c1 = Array.isArray(r.covalent_single) ? r.covalent_single[0] : r.covalent_single
    const c3 = Array.isArray(r.covalent_triple) ? r.covalent_triple[0] : r.covalent_triple
    const met = Array.isArray(r.metallic) ? r.metallic[0] : r.metallic
    // empirical/calculated/van_der_waals 取数组第一个值（Bowser里这些是数组，因为有些元素有多个测量值）
    const emp = Array.isArray(r.empirical) ? r.empirical[0] : r.empirical
    const calc = Array.isArray(r.calculated) ? r.calculated[0] : r.calculated
    const vdw = Array.isArray(r.van_der_waals) ? r.van_der_waals[0] : r.van_der_waals
    return {
      // === 基础布局（Bowser 主源） ===
      z: b.number,
      sym: b.symbol,
      en: names.en,
      ru: names.ru,
      zh: names.zh,
      group: b.group ?? 0,
      period: b.period ?? 0,
      block: b.block ?? '',
      phase: b.phase ?? 'Unknown',
      cat: classify(b.number),
      // 网格坐标（Bowser 提供，无需自行计算）
      xpos: b.xpos,
      ypos: b.ypos,
      // === 物理属性 ===
      mass: b.atomic_mass,
      cpk: (b['cpk-hex'] ?? '').replace('#', ''),
      appearance: b.appearance ?? '',
      // === 热力学（Bowser 用 Kelvin） ===
      mpK: b.melt ?? null,
      bpK: b.boil ?? null,
      // 密度：Bowser 同时提供 g/L 和 g/cm³，直接用 g/cm³ 作为标准字段，附带单位
      density: b.density_g_cm3 ?? (b.density_unit === 'g/cm³' ? b.density : b.density * 0.001) ?? null,
      densityUnit: b.density_unit ?? '',
      // === 化学属性 ===
      eneg: b.electronegativity_pauling ?? null,
      eaff: b.electron_affinity ?? null,
      ox: (m.oxidation_states ?? '').toString(), // 来自 MIT 补全
      // === 半径（Bowser 主源，更全） ===
      rEmp: emp ?? null,
      rCalc: calc ?? null,
      rvdw: vdw ?? null,
      rCovSingle: c1 ?? null,
      rCovTriple: c3 ?? null,
      rMetallic: met ?? null,
      // === 电离能（两者都有，Bowser 更准） ===
      ie: Array.isArray(b.ionization_energies) ? b.ionization_energies : [],
      // === 热学（MIT 补全，Bowser 只有 molar_heat） ===
      heatSp: m.heat?.specific ?? null, // J/kgK
      heatFus: m.heat?.fusion ?? null, // kJ/mol
      heatVap: m.heat?.vaporization ?? null, // kJ/mol
      molarHeat: b.molar_heat ?? null, // J/(mol·K) — Bowser 主源
      // === 丰度（MIT 补全） ===
      abUniv: m.abundance?.universe ?? null,
      abSolar: m.abundance?.solar ?? null,
      abCrust: m.abundance?.crust ?? null,
      abOcean: m.abundance?.ocean ?? null,
      abHuman: m.abundance?.human ?? null,
      // === 电子结构 ===
      eConf: b.electron_configuration ?? '',
      eConfSem: b.electron_configuration_semantic ?? '',
      shells: Array.isArray(b.shells) ? b.shells.join(',') : '',
      valE: m.valence_electrons ?? null, // MIT 补全
      // === 同位素概览（MIT 补全） ===
      isoKnown: m.isotopes_known ?? '',
      isoStable: m.isotopes_stable ?? '',
      isoAbund: m.isotopic_abundances
        ? (Array.isArray(m.isotopic_abundances) ? m.isotopic_abundances.join(',') : String(m.isotopic_abundances))
        : '',
      halfLife: m.half_life ?? null, // 半衰期（放射性元素），MIT 补全
      lifetime: m.lifetime ?? null, // 寿命，MIT 补全
      // === 发现 ===
      discYear: m.discovered?.year ?? null, // 发现年份，MIT 补全
      discoveredBy: b.discovered_by ?? '', // 发现者，Bowser 主源
      namedBy: b.named_by ?? '', // 命名者，Bowser 主源
      // === 简介 & 图片（Bowser 主源，CC BY 3.0 署名） ===
      summary: b.summary ?? '',
      appearanceImgUrl: b.image?.url ?? '',
      appearanceImgAttribution: b.image?.attribution ?? '',
      appearanceImgTitle: b.image?.title ?? '',
      bohrImgUrl: b.bohr_model_image ?? '',
      bohr3dUrl: b.bohr_model_3d ?? '',
      spectralImgUrl: b.spectral_img ?? '',
      // === 晶体结构（MIT 补全） ===
      crystalStructure: m.crystal_structure ?? '',
      latticeConstants: m.lattice_constants ?? '',
      latticeAngles: m.lattice_angles ?? '',
      spaceGroupName: m.space_group_name ?? '',
      spaceGroupNumber: m.space_group_number ?? null,
      // === 导电/导热（MIT 补全） ===
      conductThermal: m.conductivity?.thermal ?? null,
      // === 链接 ===
      wiki: b.source ?? m.source ?? '',
    }
  })

fs.mkdirSync(path.dirname(OUT), { recursive: true })
// elements.json 采用紧凑的行数组格式（字段顺序只写一次），与 src/lib/elements.ts 的 FIELDS 对应
const fields = Object.keys(out[0])
const rows = out.map((el) => fields.map((k) => el[k]))
fs.writeFileSync(OUT, '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n')
console.log(`✓ 写入 ${OUT}，共 ${out.length} 个元素`)
console.log(`  - 文件大小：${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`)
console.log(`  - 主源：Bowser/Periodic-Table-JSON（CC BY 3.0）`)
console.log(`  - 补全源：periodic-table-data-complete（MIT）`)

// 沿用站内既有分类
function classify(z) {
  if (z >= 57 && z <= 71) return 'lanth'
  if (z >= 89 && z <= 103) return 'act'
  if ([2, 10, 18, 36, 54, 86, 118].includes(z)) return 'noble'
  if ([3, 11, 19, 37, 55, 87].includes(z)) return 'alkali'
  if ([4, 12, 20, 38, 56, 88].includes(z)) return 'alkaline'
  if ([9, 17, 35, 53, 85, 117].includes(z)) return 'halogen'
  if ([5, 14, 32, 33, 51, 52].includes(z)) return 'metalloid'
  if ([1, 6, 7, 8, 15, 16, 34].includes(z)) return 'nonmetal'
  if ([13, 31, 49, 50, 81, 82, 83, 84, 113, 114, 115, 116].includes(z)) return 'post'
  return 'transition'
}
