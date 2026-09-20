import type { UserTag } from '../../db/index.js'
import { useT } from '@/lib/i18n'

/**
 * 身份标签徽章：仅外显装饰，契合博客 VS Code 主题，不过分花哨。
 * effect: solid（实色底）| glow（微光）| gradient（渐变边框）| outline（描边）
 */
export function UserTagBadge({ tag }: { tag: UserTag }) {
  const t = useT()
  const style: React.CSSProperties = {
    '--tag-color': tag.color,
  } as React.CSSProperties
  return (
    <span
      className={`user-tag user-tag-${tag.effect}`}
      style={style}
      title={t('common.usertag.tooltip', { name: tag.name })}
    >
      {tag.name}
    </span>
  )
}

/** 批量渲染标签（按 id 查定义） */
export function UserTagList({ tagIds, tags }: { tagIds: number[]; tags: UserTag[] }) {
  if (!tagIds?.length) return null
  const map = new Map(tags.map((t) => [t.id, t]))
  const items = tagIds.map((id) => map.get(id)).filter(Boolean) as UserTag[]
  if (items.length === 0) return null
  return (
    <span className="user-tag-list">
      {items.map((t) => (
        <UserTagBadge key={t.id} tag={t} />
      ))}
    </span>
  )
}
