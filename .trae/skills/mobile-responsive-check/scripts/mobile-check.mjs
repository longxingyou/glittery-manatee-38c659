#!/usr/bin/env node
/**
 * 真机模拟移动检查（Playwright）
 *
 * 用法：
 *   node mobile-check.mjs --config ./check.json
 *
 * 依赖 playwright-core，从【当前工作目录】解析（建议在临时目录中
 * `npm i playwright-core` 后从该目录调用，避免污染项目依赖）。
 * Chromium 查找顺序：环境变量 PLAYWRIGHT_EXECUTABLE_PATH →
 *   %LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win64\chrome.exe（取最新）
 *
 * 配置 schema 见 assets/config.example.json。
 * 任一断言失败时进程以退出码 1 结束。
 */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const cwdRequire = createRequire(join(process.cwd(), 'x'));
let chromium;
try {
  ({ chromium } = cwdRequire('playwright-core'));
} catch {
  console.error('当前目录找不到 playwright-core。请先在临时目录执行：npm i playwright-core');
  process.exit(2);
}

const configArg = process.argv.find((a) => a.startsWith('--config=')) ??
  process.argv[process.argv.indexOf('--config') + 1];
if (!configArg) {
  console.error('缺少 --config <path>');
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(configArg, 'utf8'));

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DEFAULT_SIZES = [
  { w: 390, h: 844, name: 'iphone-390' },
  { w: 360, h: 780, name: 'android-360' },
  { w: 320, h: 568, name: 'small-320' },
];

function findChromium() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  const builds = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse();
  for (const b of builds) {
    const p = join(base, b, 'chrome-win64', 'chrome.exe');
    if (existsSync(p)) return p;
  }
  return undefined;
}

const executablePath = findChromium();
if (!executablePath) {
  console.error('找不到 Chromium。设置 PLAYWRIGHT_EXECUTABLE_PATH 或运行 npx playwright install chromium');
  process.exit(2);
}

/** 在页面内求值一组期望，返回 {pass, actual} */
async function evalExpect(page, expect) {
  return page.evaluate((ex) => {
    const actual = {};
    if (ex.dataFont !== undefined) actual.dataFont = document.documentElement.getAttribute('data-font');
    if (ex.fontReady !== undefined) {
      try { actual.fontReady = document.fonts.check(`16px "${ex.fontReady}"`); } catch { actual.fontReady = false; }
    }
    if (ex.storage !== undefined) {
      const [k] = ex.storage;
      actual.storage = localStorage.getItem(k);
    }
    if (ex.attr !== undefined) {
      const [sel, attr] = ex.attr;
      actual.attr = document.querySelector(sel)?.getAttribute(attr) ?? null;
    }
    if (ex.text !== undefined) {
      const [sel] = ex.text;
      actual.text = document.querySelector(sel)?.textContent?.trim()?.slice(0, 120) ?? null;
    }
    return actual;
  }, expect).then((actual) => {
    let pass = true;
    if (expect.dataFont !== undefined && actual.dataFont !== expect.dataFont) pass = false;
    if (expect.fontReady !== undefined && actual.fontReady !== true) pass = false;
    if (expect.storage !== undefined && actual.storage !== expect.storage[1]) pass = false;
    if (expect.attr !== undefined && actual.attr !== expect.attr[2]) pass = false;
    if (expect.text !== undefined && actual.text !== expect.text[1]) pass = false;
    return { pass, actual };
  });
}

async function measureOverflow(page, targets) {
  return page.evaluate((sels) => {
    const out = { doc: document.documentElement.scrollWidth - window.innerWidth };
    for (const s of sels) {
      const el = document.querySelector(s);
      out[s] = el ? el.scrollWidth - el.clientWidth : null;
    }
    return out;
  }, targets ?? []);
}

/** null = 目标元素当前不存在，不计为溢出失败 */
const overflowOk = (over) => Object.values(over).every((v) => v === 0 || v === null);

const browser = await chromium.launch({ headless: true, executablePath });
const sizes = cfg.sizes ?? DEFAULT_SIZES;
const report = {};
let failed = false;

for (const size of sizes) {
  const r = { console: [], pageErrors: [], checks: [], screenshots: [] };
  report[size.name] = r;

  const ctx = await browser.newContext({
    viewport: { width: size.w, height: size.h },
    deviceScaleFactor: cfg.deviceScaleFactor ?? 3,
    isMobile: true,
    hasTouch: true,
    userAgent: size.ua ?? cfg.ua ?? DEFAULT_UA,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (!/beacon|cloudflareinsights/.test(t)) r.console.push(`[${m.type()}] ${t.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => r.pageErrors.push(String(e).slice(0, 200)));

  await page.goto(cfg.url, { waitUntil: 'networkidle' });

  // 首屏溢出
  const home = await measureOverflow(page, cfg.targets ?? []);
  r.checks.push({ name: 'homeOverflow', pass: home.doc === 0, actual: home.doc });
  if (home.doc !== 0) failed = true;

  // 打开入口（如弹窗按钮）
  if (cfg.entry) {
    await page.click(cfg.entry);
    if (cfg.modal) await page.waitForSelector(cfg.modal, { timeout: 10000 });
    await page.waitForTimeout(cfg.entryWait ?? 600);
    const over = await measureOverflow(page, cfg.targets ?? []);
    r.checks.push({ name: 'entryOverflow', pass: overflowOk(over), actual: over });
    if (!overflowOk(over)) failed = true;
    if (cfg.modal) {
      r.modal = await page.evaluate((s) => {
        const b = document.querySelector(s).getBoundingClientRect();
        return {
          left: Math.round(b.left), right: Math.round(b.right),
          top: Math.round(b.top), w: Math.round(b.width),
        };
      }, cfg.modal);
    }
  }

  // 特征相关的步骤序列
  for (const step of cfg.steps ?? []) {
    if (step.click) {
      await page.click(step.click);
      if (step.wait) await page.waitForTimeout(step.wait);
    }
    if (step.reload) {
      await page.reload({ waitUntil: 'networkidle' });
      if (step.wait) await page.waitForTimeout(step.wait);
    }
    if (step.scroll) await page.mouse.wheel(0, step.scroll);
    if (step.shot) {
      const dir = resolve(cfg.outDir ?? '.');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${size.name}-${step.shot}.png`);
      await page.screenshot({ path: file });
      r.screenshots.push(file);
    }
    if (step.expect) {
      const res = await evalExpect(page, step.expect);
      r.checks.push({ name: step.label ?? 'expect', pass: res.pass, actual: res.actual });
      if (!res.pass) failed = true;
    }
    if (step.overflow) {
      const over = await measureOverflow(page, cfg.targets ?? []);
      const ok = overflowOk(over);
      r.checks.push({ name: step.label ?? 'overflow', pass: ok, actual: over });
      if (!ok) failed = true;
    }
  }

  if (r.console.some((c) => c.startsWith('[error]')) || r.pageErrors.length > 0) failed = true;
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 1));
process.exit(failed ? 1 : 0);
