/**
 * 用户字体偏好（客户端）
 * - 偏好存 localStorage（sg-font-pref），登录用户另由 saveFontPrefFn 持久化到 profiles
 * - 字体 CSS 通过动态 import() 按需加载（Vite 自动分包，不拖慢首屏）
 * - 应用方式：<html data-font="…">，styles.css 中按属性覆盖 --font-ui / --font-prose
 * - 空字符串 = 默认字体（取消字体）
 * 所有字体均为 OFL-1.1 开源许可，可自由商用与分发。
 */

export type FontId =
  | 'zh-sans' | 'zh-serif' | 'zh-wenkai'
  | 'zh-smiley' | 'zh-kuaile' | 'zh-mashan' | 'zh-lisu'
  | 'en-inter' | 'en-lora'
  | 'en-playfair' | 'en-syne' | 'en-caveat'
  | 'ru-inter' | 'ru-manrope' | 'ru-ptserif'
  | 'ru-yeseva' | 'ru-marck';

export type FontGroupLang = 'zh' | 'en' | 'ru';
export type FontKind = 'normal' | 'art';

/** 供 UI 分组渲染（显示名走 i18n key：font.opt.<id>） */
export const FONT_GROUPS: Record<FontGroupLang, Record<FontKind, FontId[]>> = {
  zh: {
    normal: ['zh-sans', 'zh-serif', 'zh-wenkai'],
    art: ['zh-smiley', 'zh-kuaile', 'zh-mashan', 'zh-lisu'],
  },
  en: {
    normal: ['en-inter', 'en-lora'],
    art: ['en-playfair', 'en-syne', 'en-caveat'],
  },
  ru: {
    normal: ['ru-inter', 'ru-manrope', 'ru-ptserif'],
    art: ['ru-yeseva', 'ru-marck'],
  },
};

export const ALL_FONT_IDS: FontId[] = [
  ...FONT_GROUPS.zh.normal, ...FONT_GROUPS.zh.art,
  ...FONT_GROUPS.en.normal, ...FONT_GROUPS.en.art,
  ...FONT_GROUPS.ru.normal, ...FONT_GROUPS.ru.art,
];

const STORAGE_KEY = 'sg-font-pref';

/** 每套偏好需要注入的字体 CSS（动态 import → 独立 chunk，按需下载） */
const loaders: Record<FontId, () => Promise<unknown>> = {
  'zh-sans': () => Promise.all([
    import('@fontsource/noto-sans-sc/400.css'),
    import('@fontsource/noto-sans-sc/500.css'),
    import('@fontsource/noto-sans-sc/700.css'),
  ]),
  'zh-serif': () => Promise.all([
    import('@fontsource/noto-serif-sc/400.css'),
    import('@fontsource/noto-serif-sc/600.css'),
    import('@fontsource/noto-serif-sc/700.css'),
  ]),
  'zh-wenkai': () => Promise.all([
    import('lxgw-wenkai-webfont/lxgwwenkai-regular.css'),
    import('lxgw-wenkai-webfont/lxgwwenkai-bold.css'),
  ]),
  'zh-smiley': () => Promise.all([
    import('./fonts/smiley-sans.css'),
    import('@fontsource/noto-sans-sc/400.css'),
  ]),
  'zh-kuaile': () => Promise.all([
    import('@fontsource/zcool-kuaile/400.css'),
    import('@fontsource/noto-sans-sc/400.css'),
  ]),
  'zh-mashan': () => Promise.all([
    import('@fontsource/ma-shan-zheng/400.css'),
    import('@fontsource/noto-serif-sc/400.css'),
  ]),
  // 隶书使用 Windows/macOS 系统自带的 LiSu / STLiti，无需下载
  'zh-lisu': () => Promise.resolve(),
  'en-inter': () => import('@fontsource-variable/inter/index.css'),
  'en-lora': () => import('@fontsource-variable/lora/index.css'),
  'en-playfair': () => Promise.all([
    import('@fontsource/playfair-display/400.css'),
    import('@fontsource/playfair-display/600.css'),
    import('@fontsource/playfair-display/700.css'),
  ]),
  'en-syne': () => Promise.all([
    import('@fontsource/syne/400.css'),
    import('@fontsource/syne/700.css'),
  ]),
  'en-caveat': () => Promise.all([
    import('@fontsource/caveat/400.css'),
    import('@fontsource/caveat/700.css'),
  ]),
  'ru-inter': () => import('@fontsource-variable/inter/index.css'),
  'ru-manrope': () => import('@fontsource-variable/manrope/index.css'),
  'ru-ptserif': () => Promise.all([
    import('@fontsource/pt-serif/400.css'),
    import('@fontsource/pt-serif/700.css'),
  ]),
  'ru-yeseva': () => import('@fontsource/yeseva-one/400.css'),
  'ru-marck': () => import('@fontsource/marck-script/400.css'),
};

/**
 * 各字体的完整 font-family 栈（供选择器卡片内联预览用，与 styles.css 中
 * :root[data-font] 的变量值保持一致：主字体 + 中文回退 + 系统回退）。
 */
export const FONT_STACKS: Record<FontId, string> = {
  'zh-sans': '"Noto Sans SC", "IBM Plex Sans", ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
  'zh-serif': '"Noto Serif SC", ui-serif, Georgia, "Songti SC", "SimSun", serif',
  'zh-wenkai': '"LXGW WenKai", "Noto Serif SC", ui-serif, Georgia, "KaiTi", serif',
  'zh-smiley': '"Smiley Sans", "Noto Sans SC", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  'zh-kuaile': '"ZCOOL KuaiLe", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
  'zh-mashan': '"Ma Shan Zheng", "Noto Serif SC", ui-serif, "KaiTi", "STKaiti", serif',
  'zh-lisu': '"LiSu", "STLiti", "Noto Serif SC", ui-serif, "KaiTi", serif',
  'en-inter': '"Inter Variable", "Noto Sans SC", system-ui, sans-serif',
  'en-lora': '"Lora Variable", "Noto Serif SC", Georgia, ui-serif, serif',
  'en-playfair': '"Playfair Display", "Noto Serif SC", Georgia, ui-serif, serif',
  'en-syne': '"Syne", "Noto Sans SC", system-ui, sans-serif',
  'en-caveat': '"Caveat", "Noto Sans SC", "Comic Sans MS", cursive',
  'ru-inter': '"Inter Variable", "Noto Sans SC", system-ui, sans-serif',
  'ru-manrope': '"Manrope Variable", "Noto Sans SC", system-ui, sans-serif',
  'ru-ptserif': '"PT Serif", "Noto Serif SC", Georgia, ui-serif, serif',
  'ru-yeseva': '"Yeseva One", "Noto Serif SC", Georgia, ui-serif, serif',
  'ru-marck': '"Marck Script", "Noto Sans SC", "Segoe Script", cursive',
};

const inflight = new Map<FontId, Promise<unknown>>();

function isFontId(v: string | null): v is FontId {
  return !!v && (ALL_FONT_IDS as string[]).includes(v);
}

/** 读取当前偏好（'' = 默认）；SSR 环境返回 '' */
export function getFontPref(): FontId | '' {
  if (typeof localStorage === 'undefined') return '';
  const v = localStorage.getItem(STORAGE_KEY);
  return isFontId(v) ? v : '';
}

/** 立即把偏好挂到 <html>（同步执行，避免属性晚于首帧） */
export function applyFontPref(id: FontId | ''): void {
  if (typeof document === 'undefined') return;
  if (id) document.documentElement.setAttribute('data-font', id);
  else document.documentElement.removeAttribute('data-font');
}

/** 按需加载某套字体的 CSS（去重） */
export function loadFontPref(id: FontId): Promise<unknown> {
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = loaders[id]().catch((err) => {
    inflight.delete(id);
    throw err;
  });
  inflight.set(id, p);
  return p;
}

/** 启动时调用：先挂属性，再异步拉字体 */
export function initFontPrefs(): void {
  const id = getFontPref();
  applyFontPref(id);
  if (id) void loadFontPref(id);
}

/** 选择字体：挂属性 + 存 localStorage + 拉 CSS */
export async function setFontPref(id: FontId): Promise<void> {
  applyFontPref(id);
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, id);
  await loadFontPref(id);
}

/** 取消字体：恢复网站默认栈 */
export function clearFontPref(): void {
  applyFontPref('');
  if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
}

/**
 * 后台预加载全部字体 CSS（仅在字体选择器打开时调用）：
 * 去重缓存保证不重复下载；不阻塞选择器渲染，CSS 到达后预览卡自动换字。
 */
export function preloadAllFonts(): Promise<unknown[]> {
  return Promise.all(ALL_FONT_IDS.map((id) => loadFontPref(id).catch(() => undefined)))
}
