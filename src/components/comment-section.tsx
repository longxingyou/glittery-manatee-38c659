import { getUser, onAuthChange, type User } from '@netlify/identity'
import { CheckCircle2, Eye, MessageSquareText, Send, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { renderMarkdown } from '@/lib/markdown'

type Comment = { id: number; userName: string; body: string; createdAt: string; likes: number }

export function CommentSection({ postSlug }: { postSlug: string }) {
  const [comments, setComments] = useState<Comment[]>([])
  const [user, setUser] = useState<User | null>(null)
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState(false)
  const [status, setStatus] = useState('正在读取讨论…')
  const [sending, setSending] = useState(false)

  const load = async () => {
    try {
      const response = await fetch(`/api/comments?post=${encodeURIComponent(postSlug)}`)
      const data = await response.json()
      setComments(data.comments || [])
      setStatus(data.comments?.length ? '' : '还没有评论，写下第一条可验证的想法。')
    } catch { setStatus('评论暂时无法载入。') }
  }

  useEffect(() => {
    load()
    getUser().then(setUser)
    return onAuthChange((_, nextUser) => setUser(nextUser ?? null))
  }, [postSlug])

  const submit = async () => {
    if (!user) { window.dispatchEvent(new Event('open-auth')); return }
    if (body.trim().length < 2) return
    setSending(true); setStatus('正在提交…')
    try {
      const response = await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postSlug, body }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '提交失败')
      setComments((current) => [...current, data.comment]); setBody(''); setPreview(false); setStatus('评论已发布。')
    } catch (error) { setStatus(error instanceof Error ? error.message : '提交失败。') }
    finally { setSending(false) }
  }

  return (
    <section className="comments-section">
      <div className="comments-heading"><div><MessageSquareText size={19} /><h2>讨论线程</h2><span>{comments.length}</span></div><p><ShieldCheck size={14} /> 邮箱验证访客专属</p></div>
      <div className="comment-list">
        {comments.map((comment) => (
          <article className="comment" key={comment.id}>
            <div className="comment-avatar">{comment.userName.slice(0, 2).toUpperCase()}</div>
            <div className="comment-body"><header><strong>{comment.userName}</strong><CheckCircle2 size={13} /><time>{new Date(comment.createdAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</time></header><div className="markdown-body compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.body) }} /></div>
          </article>
        ))}
        {status && <div className="comment-status">{status}</div>}
      </div>
      <div className="comment-editor">
        <div className="comment-editor-head"><span>{user ? `${user.name || user.email} · verified` : 'guest · verification required'}</span><button onClick={() => setPreview(!preview)}><Eye size={14} />{preview ? '编辑' : '预览'}</button></div>
        {preview ? <div className="comment-preview markdown-body compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(body || '*预览将在这里出现…*') }} /> : <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={'支持 Markdown 与 LaTeX：\n**清晰表达**，也可以写 $E = mc^2$'} rows={6} />}
        <div className="comment-editor-foot"><span>Markdown · LaTeX · 最多 4000 字</span><button onClick={submit} disabled={sending || body.trim().length < 2}>{user ? <><Send size={14} />{sending ? '发布中' : '发布评论'}</> : '验证邮箱后评论'}</button></div>
      </div>
    </section>
  )
}
