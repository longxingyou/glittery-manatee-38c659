-- ============================================================================
-- X岛本地搜索索引 — D1 schema（Cloudflare D1 / SQLite）
--
-- 从 Neon Postgres 迁移而来：BIGINT → INTEGER（X岛 ID 都 < 2^53，JS 安全），
-- TIMESTAMPTZ DEFAULT NOW() → INTEGER DEFAULT (unixepoch())。
-- pg_trgm GIN 全文索引 → FTS5 unicode61 分词器（中文按字分词，子串搜索走倒排，
-- 比 ILIKE 快且不占 Worker 子请求配额）。
-- 新增列 deleted_at（软删/删帖 diff）与 crawled_at（回扫调度依据）。
-- ============================================================================

-- 1) 串主楼索引
CREATE TABLE IF NOT EXISTS xdnmb_index_threads (
  id INTEGER PRIMARY KEY,                          -- 串 ID
  fid INTEGER,                                     -- 所属版面 ID
  title TEXT NOT NULL DEFAULT '',                  -- 标题（纯文本，无标题存首行摘要）
  content TEXT NOT NULL DEFAULT '',                -- 主楼正文（纯文本，去 HTML，便于搜索）
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_id INTEGER NOT NULL DEFAULT 0,        -- 已索引的末楼 ID（增量判断）
  sage INTEGER NOT NULL DEFAULT 0,
  admin INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  crawled_at INTEGER NOT NULL DEFAULT (unixepoch()), -- 最近一次回扫 diff 的时间
  deleted_at INTEGER                                -- 软删时间戳；NULL = 未删
);
CREATE INDEX IF NOT EXISTS xdnmb_index_threads_fid_idx ON xdnmb_index_threads (fid);
CREATE INDEX IF NOT EXISTS xdnmb_index_threads_deleted_idx ON xdnmb_index_threads (deleted_at);

-- 2) 楼层索引（主楼 + 回复）；id 是回帖号，thread_id 反查父串（>>No.xxx 直跳核心）
CREATE TABLE IF NOT EXISTS xdnmb_index_posts (
  id INTEGER PRIMARY KEY,                          -- 楼层 ID（回帖号）
  thread_id INTEGER NOT NULL,                       -- 父串 ID
  content TEXT NOT NULL DEFAULT '',                 -- 纯文本（去 HTML），用于全文搜索
  user_hash TEXT NOT NULL DEFAULT '',
  now TEXT NOT NULL DEFAULT '',                      -- X 岛原始时间字符串
  sage INTEGER NOT NULL DEFAULT 0,
  admin INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER                                -- 软删时间戳；NULL = 未删
);
CREATE INDEX IF NOT EXISTS xdnmb_index_posts_thread_idx ON xdnmb_index_posts (thread_id);
CREATE INDEX IF NOT EXISTS xdnmb_index_posts_now_idx ON xdnmb_index_posts (now);
CREATE INDEX IF NOT EXISTS xdnmb_index_posts_deleted_idx ON xdnmb_index_posts (deleted_at);

-- 3) 爬虫游标（每条 timeline/forum 的爬取进度；kind + target_id 联合主键）
--    catalog 全量扫描进度也存这里：kind='catalog', target_id='all',
--    page=forum 索引, round=该 forum 内的页码
CREATE TABLE IF NOT EXISTS xdnmb_index_cursors (
  kind TEXT NOT NULL,                               -- 'timeline' | 'forum' | 'catalog'
  target_id TEXT NOT NULL,                          -- 时间线 ID / 版面 ID / 'all'
  page INTEGER NOT NULL DEFAULT 1,
  round INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (kind, target_id)
);

-- 4) 回扫队列（删帖 diff）：每个串被爬成功后入队 7 天后回扫
CREATE TABLE IF NOT EXISTS xdnmb_index_recrawl_queue (
  thread_id INTEGER PRIMARY KEY,                    -- 串 ID
  due_at INTEGER NOT NULL,                           -- 到期时间戳（unixepoch）；<= now 即待处理
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS xdnmb_recrawl_due_idx ON xdnmb_index_recrawl_queue (due_at, status);

-- 5) 设置单例（仅 crawler 用的 userhash；主站 setcookie 动作双写 D1 + Neon）
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  xdnmb_userhash TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO settings (id, xdnmb_userhash) VALUES (1, '')
  ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- FTS5 全文索引（external content table，与主表 rowid 同步）
-- trigram tokenizer：3 字符滑动窗口，对中文等 CJK 文本实现真正的子串搜索
-- （等价于原 Neon 的 ILIKE %q%，但走倒排索引，远快于全表扫描）。
-- 注意：trigram 对 < 3 字符的查询回退为内部 LIKE 扫描，仍可用但稍慢。
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
  title, content,
  content='xdnmb_index_threads', content_rowid='id',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  content,
  content='xdnmb_index_posts', content_rowid='id',
  tokenize='trigram'
);

-- 同步触发器（INSERT / UPDATE / DELETE 各一，threads 与 posts 两套共 6 个）
CREATE TRIGGER IF NOT EXISTS xdnmb_threads_ai AFTER INSERT ON xdnmb_index_threads BEGIN
  INSERT INTO threads_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS xdnmb_threads_ad AFTER DELETE ON xdnmb_index_threads BEGIN
  INSERT INTO threads_fts(threads_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS xdnmb_threads_au AFTER UPDATE ON xdnmb_index_threads BEGIN
  INSERT INTO threads_fts(threads_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO threads_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS xdnmb_posts_ai AFTER INSERT ON xdnmb_index_posts BEGIN
  INSERT INTO posts_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS xdnmb_posts_ad AFTER DELETE ON xdnmb_index_posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS xdnmb_posts_au AFTER UPDATE ON xdnmb_index_posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO posts_fts(rowid, content) VALUES (new.id, new.content);
END;
