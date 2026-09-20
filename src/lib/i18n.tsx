import * as React from 'react'
import { useSyncExternalStore } from 'react'
import type { CategoryLabel } from './utils'

// ──────────────────────────────────────────────
// 语言定义
// ──────────────────────────────────────────────
export type Lang = 'zh' | 'en' | 'ru'

export const LANGS: { code: Lang; label: string; short: string }[] = [
  { code: 'zh', label: '中文', short: '中' },
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'ru', label: 'Русский', short: 'RU' },
]

export const LANG_LABEL: Record<Lang, string> = {
  zh: '中文',
  en: 'English',
  ru: 'Русский',
}

const STORAGE_KEY = 'sg_lang'

// ──────────────────────────────────────────────
// 翻译词典（扁平 key，按模块分组）
// ──────────────────────────────────────────────
type Dict = Record<string, string>

// 占位：词典内容在各组件改造时通过 mergeDict 追加
const zh: Dict = {}
const en: Dict = {}
const ru: Dict = {}

const DICTS: Record<Lang, Dict> = { zh, en, ru }

// 循环依赖兼容：ESM 中 `import './i18n-messages'` 会先于本模块体求值，
// messages 顶层立即调用 mergeDict 时 DICTS 尚在 TDZ（workerd 原生 ESM 会抛
// ReferenceError，Vite/Node 打包顺序不同会掩盖此问题）。
// var 声明在模块实例化阶段即完成提升（无 TDZ），早到的注册先入队，初始化后冲刷。
// eslint-disable-next-line no-var
var _liveDicts: Record<Lang, Dict> | null = null
// eslint-disable-next-line no-var
var _earlyDictEntries: Array<{ lang: Lang; entries: Dict }> | undefined

/**
 * 追加词典条目（模块加载时调用）。
 * 由 src/lib/i18n-messages.ts 统一注册全部文案。
 */
export function mergeDict(lang: Lang, entries: Dict) {
  if (_liveDicts) {
    Object.assign(_liveDicts[lang], entries)
  } else {
    ;(_earlyDictEntries ||= []).push({ lang, entries })
  }
}

// DICTS 就绪：冲刷早到的注册并切换为直写
_liveDicts = DICTS
{
  const queued = _earlyDictEntries
  _earlyDictEntries = undefined
  if (queued) for (const { lang, entries } of queued) Object.assign(DICTS[lang], entries)
}

// ──────────────────────────────────────────────
// 翻译函数
// ──────────────────────────────────────────────
export type TFn = (key: string, params?: Record<string, string | number>) => string

function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let value = DICTS[lang][key] ?? DICTS.zh[key] ?? key
  if (params) {
    value = value.replace(/\{(\w+)\}/g, (_, name: string) =>
      params[name] !== undefined ? String(params[name]) : `{${name}}`)
  }
  return value
}

// ──────────────────────────────────────────────
// Context
// ──────────────────────────────────────────────
type I18nContextValue = {
  lang: Lang
  setLang: (lang: Lang) => void
  t: TFn
}

const I18nContext = React.createContext<I18nContextValue | null>(null)

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'zh' || v === 'en' || v === 'ru') return v
  } catch { /* localStorage 不可用 */ }
  return 'zh'
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>('zh')

  // 水合后读取持久化语言（SSR 固定 zh，避免 hydration 文本不匹配）
  React.useEffect(() => {
    setLangState(readStoredLang())
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setLangState(readStoredLang())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setLang = React.useCallback((next: Lang) => {
    setLangState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = next === 'zh' ? 'zh-CN' : next
    // 通知非 React 模块
    try { window.dispatchEvent(new CustomEvent('sg-lang-change', { detail: next })) } catch { /* ignore */ }
  }, [])

  const t = React.useCallback<TFn>(
    (key, params) => translate(lang, key, params),
    [lang],
  )

  const value = React.useMemo<I18nContextValue>(() => ({ lang, setLang, t }), [lang, setLang, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = React.useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}

export function useT(): TFn {
  return useI18n().t
}

export function useLang(): Lang {
  return useI18n().lang
}

// ──────────────────────────────────────────────
// 分类译名注册表
// 分类权威名（中文）是 posts.categories[] 与 /category/:name 的规范键，
// 英/俄译名只影响展示。数据来自 root loader，在渲染子树前同步注入
// （模块级单例对所有访客一致，SSR/CSR 均安全；SSR 固定渲染中文）。
// ──────────────────────────────────────────────
let categoryMap = new Map<string, CategoryLabel>()
let categoryVersion = 0
const categoryListeners = new Set<() => void>()

export function setCategoryLabels(labels: CategoryLabel[]) {
  const next = new Map(labels.map((l) => [l.name, l]))
  // 内容未变（root 在多数导航中都会重渲染）：完全不动，避免无谓的版本自增与重渲染
  let changed = next.size !== categoryMap.size
  if (!changed) {
    for (const [name, label] of next) {
      const old = categoryMap.get(name)
      if (!old || old.nameEn !== label.nameEn || old.nameRu !== label.nameRu) { changed = true; break }
    }
  }
  if (!changed) return
  categoryMap = next
  categoryVersion += 1
  if (categoryListeners.size === 0) return // SSR / 首次客户端渲染：子树尚未订阅，直接读到新值即可
  // root 渲染期注入时，通知延迟到提交后，避免“渲染 A 组件时更新 B 组件”告警
  queueMicrotask(() => { categoryListeners.forEach((fn) => fn()) })
}

/** 同步读取分类当前语言的展示名（非组件环境用；缺失时依次回退 en → 权威名） */
export function categoryNameFor(name: string, lang: Lang): string {
  const label = categoryMap.get(name)
  if (lang === 'en') return label?.nameEn || name
  if (lang === 'ru') return label?.nameRu || label?.nameEn || name
  return name
}

function subscribeCategoryLabels(fn: () => void) {
  categoryListeners.add(fn)
  return () => { categoryListeners.delete(fn) }
}

/** Hook：返回 canonical 名 → 当前语言展示名 的解析函数，语言或译名变更时自动重渲染 */
export function useCatName(): (name: string) => string {
  const { lang } = useI18n()
  useSyncExternalStore(subscribeCategoryLabels, () => categoryVersion, () => categoryVersion)
  return React.useCallback((name: string) => categoryNameFor(name, lang), [lang, categoryVersion])
}

// 注册全部三语文案（副作用导入，须在文件末尾确保 mergeDict 已定义）
import './i18n-messages'
