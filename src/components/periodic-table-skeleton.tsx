/**
 * 周期表骨架屏。
 *
 * 首屏（SSR）与组件 chunk 下载期间显示：形状贴近真实版面，加载完成后
 * 不发生大幅跳动；纯静态标记，**不引入元素数据**，否则骨架屏本身就成了负担。
 */
import { useLang } from '../lib/i18n'

export function PeriodicTableSkeleton() {
  const lang = useLang()
  const label = lang === 'zh' ? '正在加载元素周期表' : lang === 'en' ? 'Loading the periodic table' : 'Загружается периодическая таблица'
  return (
    <section className="panel ru-pt-skel" aria-busy="true" aria-label={label} lang={lang === 'zh' ? 'zh-CN' : lang}>
      <div className="ru-pt-skel-head">
        <span className="ru-pt-skel-bar" style={{ width: 190, height: 18 }} />
        <span className="ru-pt-skel-bar" style={{ width: 74, height: 24 }} />
      </div>
      <div className="ru-pt-skel-controls">
        {[96, 78, 120, 88, 66].map((w, i) => (
          <span key={i} className="ru-pt-skel-bar" style={{ width: w, height: 24 }} />
        ))}
      </div>
      <div className="ru-pt-skel-body">
        <div className="ru-pt-skel-grid">
          {Array.from({ length: 126 }, (_, i) => (
            <span key={i} className="ru-pt-skel-cell" />
          ))}
        </div>
        <aside className="ru-pt-skel-side">
          <span className="ru-pt-skel-bar" style={{ height: 40 }} />
          <span className="ru-pt-skel-bar" style={{ height: 128 }} />
          <span className="ru-pt-skel-bar" style={{ height: 72 }} />
        </aside>
      </div>
    </section>
  )
}
