export function formatRelative(ms: number, now: number = Date.now()): string {
  const diff = now - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 24 * 3600_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 48 * 3600_000) return '昨天'
  if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}
