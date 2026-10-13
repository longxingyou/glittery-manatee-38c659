/**
 * X 岛匿名版 API 类型（前后端共享的纯类型模块，不引入任何服务端运行时，
 * 避免客户端 bundle 被拖入 fetch/cache 等服务端代码）。
 */

export interface XPost {
  id: number
  fid?: number
  ReplyCount?: number
  img: string
  ext: string
  now: string
  user_hash: string
  name: string
  title: string
  /** 经服务端净化的安全 HTML */
  content: string
  sage?: number
  admin?: number
  Hide?: number
  Replies?: XPost[]
  RemainReplies?: number
}

export interface XForum {
  id: string
  name: string
  sort?: string
  showName?: string
  msg?: string
  interval?: string
  thread_count?: string
}

export interface XForumGroup {
  id: string
  name: string
  forums: XForum[]
}

/** 时间线分区（getTimelineList 返回） */
export interface XTimeline {
  id: string
  name: string
  display_name: string
  notice?: string
  max_page?: number
  domain?: string
}
