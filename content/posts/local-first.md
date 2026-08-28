---
title: "Local-first：让数据先属于用户"
summary: "离线优先不只是缓存策略，而是一种把所有权、延迟与可靠性重新交还给用户的产品哲学。"
categories: ["工程", "产品"]
slug: "local-first"
date: "2026-08-24"
---
## 网络不应该是单点故障

我们曾把「在线」当作软件的默认前提。但真正可靠的工具，应该允许用户在地铁、飞机和信号边缘继续思考。

Local-first 的核心不是简单地写一句 `localStorage.setItem()`，而是建立一个清晰的数据协议：本地副本负责即时反馈，远端副本负责协作与恢复，冲突则由可理解的规则合并。

> 当延迟趋近于零，软件才重新像一件工具，而不是一个等待中的网页。

## 一个简单的延迟模型

如果一次操作依赖网络往返，那么体验成本可以写成：

$$T_{interaction} = T_{local} + T_{network} + T_{server}$$

Local-first 尝试把关键路径缩短为 $T_{interaction} \approx T_{local}$，其余工作在后台同步。

```ts
const saveDraft = async (draft: Draft) => {
  await localStore.put(draft)
  syncQueue.enqueue(draft.id)
}
```

真正困难的部分，是让同步状态可见、冲突可解释、失败可恢复。技术只是入口，信任才是产品。
