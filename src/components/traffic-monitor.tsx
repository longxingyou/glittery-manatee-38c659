import * as React from 'react'
import { Activity, ArrowDown, ArrowUp, RefreshCw } from 'lucide-react'

import { useT } from '@/lib/i18n'

const QUOTA_BYTES = 100 * 1024 ** 3 // Azure 学生订阅约 100 GB/月出站
const POLL_MS = 5_000
const HISTORY = 60

interface Snapshot {
  ok: true
  now: number
  uptimeSec: number
  rxBytes: number
  txBytes: number
  vnstat: null | {
    month: { label: string; rx: number; tx: number }
    day: { label: string; rx: number; tx: number }
  }
  load: number[]
  mem: { total: number; available: number }
  services: { singbox: string }
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

function fmtRate(n: number): string {
  return `${fmtBytes(n)}/s`
}

function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <svg className="traffic-spark" viewBox="0 0 300 60" preserveAspectRatio="none" />
  const max = Math.max(1, ...values)
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 300},${58 - (v / max) * 54}`)
    .join(' ')
  return (
    <svg className="traffic-spark" viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

export function TrafficMonitor() {
  const t = useT()
  const [snap, setSnap] = React.useState<Snapshot | null>(null)
  const [down, setDown] = React.useState(0)
  const [up, setUp] = React.useState(0)
  const [history, setHistory] = React.useState<Array<{ down: number; up: number }>>([])
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [auto, setAuto] = React.useState(true)
  const [updatedAt, setUpdatedAt] = React.useState(0)
  const prevRef = React.useRef<Snapshot | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/traffic', { credentials: 'same-origin', cache: 'no-store' })
      const data = (await res.json()) as Snapshot & { error?: string }
      if (res.status === 401) throw new Error(t('admin.traffic.auth'))
      if (!res.ok || data.ok !== true) throw new Error(data.error || t('admin.traffic.fail'))

      const prev = prevRef.current
      if (prev && data.now > prev.now) {
        const dt = (data.now - prev.now) / 1000
        if (dt >= 0.5) {
          const nextDown = Math.max(0, data.rxBytes - prev.rxBytes) / dt
          const nextUp = Math.max(0, data.txBytes - prev.txBytes) / dt
          setDown(nextDown)
          setUp(nextUp)
          setHistory((h) => [...h.slice(-(HISTORY - 1)), { down: nextDown, up: nextUp }])
        }
      }
      prevRef.current = data
      setSnap(data)
      setUpdatedAt(Date.now())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.traffic.fail'))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!auto) return
    const id = window.setInterval(() => {
      if (!document.hidden) void load()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [auto, load])

  const monthTx = snap?.vnstat?.month.tx ?? 0
  const monthRx = snap?.vnstat?.month.rx ?? 0
  const pct = Math.min(100, (monthTx / QUOTA_BYTES) * 100)
  const online = snap?.services.singbox === 'active'
  const memUsed = snap ? Math.max(0, snap.mem.total - snap.mem.available) : 0

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <div>
          <h1>{t('admin.traffic.title')}</h1>
          <p>{t('admin.traffic.sub')}</p>
        </div>
        <div className="header-actions">
          <label className="traffic-auto">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {t('admin.traffic.auto')}
          </label>
          <button className="ghost-button" onClick={() => void load()}>
            <RefreshCw size={14} />
            {t('admin.traffic.refresh')}
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && !snap ? (
        <div className="skeleton-list" />
      ) : snap ? (
        <>
          <div className="stat-grid">
            <div className="stat-card tone-1">
              <span>{t('admin.traffic.down')}</span>
              <b>{fmtRate(down)}</b>
            </div>
            <div className="stat-card tone-2">
              <span>{t('admin.traffic.up')}</span>
              <b>{fmtRate(up)}</b>
            </div>
            <div className="stat-card tone-3">
              <span>{t('admin.traffic.monthOut')}</span>
              <b>{fmtBytes(monthTx)}</b>
            </div>
            <div className="stat-card tone-4">
              <span>{t('admin.traffic.node')}</span>
              <b className="traffic-status">
                <i className={`traffic-dot${online ? '' : ' off'}`} />
                {online ? t('admin.traffic.online') : t('admin.traffic.offline')}
              </b>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head between">
              <h3>
                <Activity size={15} /> {t('admin.traffic.quota')}
              </h3>
              <small>{snap.vnstat ? snap.vnstat.month.label : t('admin.traffic.init')}</small>
            </div>
            <div className="traffic-bar">
              <i style={{ width: `${pct}%` }} />
            </div>
            <div className="traffic-row">
              <span>
                {t('admin.traffic.used')} {fmtBytes(monthTx)} · {pct.toFixed(1)}%
              </span>
              <span>
                {t('admin.traffic.remaining')} {fmtBytes(Math.max(0, QUOTA_BYTES - monthTx))}
              </span>
            </div>
            <div className="traffic-row">
              <span>
                {t('admin.traffic.in')} {fmtBytes(monthRx)}
              </span>
              <span>
                {t('admin.traffic.out')} {fmtBytes(monthTx)}
              </span>
              <span>
                {t('admin.traffic.today')} {snap.vnstat ? fmtBytes(snap.vnstat.day.rx + snap.vnstat.day.tx) : '—'}
              </span>
            </div>
          </div>

          <div className="traffic-grid">
            <div className="panel">
              <div className="panel-head">
                <ArrowDown size={15} /> {t('admin.traffic.down')}
                <small>{t('admin.traffic.series')}</small>
              </div>
              <Spark values={history.map((h) => h.down)} color="var(--accent)" />
            </div>
            <div className="panel">
              <div className="panel-head">
                <ArrowUp size={15} /> {t('admin.traffic.up')}
                <small>{t('admin.traffic.series')}</small>
              </div>
              <Spark values={history.map((h) => h.up)} color="var(--accent-2)" />
            </div>
          </div>

          <div className="panel">
            <div className="traffic-row">
              <span>
                {t('admin.traffic.mem')} {fmtBytes(memUsed)} / {fmtBytes(snap.mem.total)}
              </span>
              <span>
                {t('admin.traffic.load')} {snap.load[0]?.toFixed(2) ?? '—'}
              </span>
              <span>
                {t('admin.traffic.uptime')} {fmtDuration(snap.uptimeSec)}
              </span>
              <span>
                {t('admin.traffic.updated')}{' '}
                {updatedAt ? new Date(updatedAt).toLocaleTimeString() : '—'}
              </span>
            </div>
            <p className="traffic-note">{t('admin.traffic.note')}</p>
          </div>
        </>
      ) : null}
    </div>
  )
}
