/**
 * 爬虫 userhash 读取：从 D1 settings 表（与主站共享同一 D1）。
 * 主站 api.xdnmb.ts setcookie 动作双写 Neon + D1 settings 表。
 */
import { settingsGetUserhashD1, type D1Database } from '../../db/d1.js'

export async function getUserhash(db: D1Database): Promise<string> {
  return settingsGetUserhashD1(db)
}
