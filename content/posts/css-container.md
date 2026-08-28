---
title: "容器查询改变了组件的思考方式"
summary: "响应式设计终于可以由组件所处空间决定，而不是猜测整个浏览器窗口的尺寸。"
categories: ["前端", "CSS"]
slug: "css-container"
date: "2026-07-12"
---
## 组件应该理解自己的空间

媒体查询回答「视口有多宽」，容器查询回答「我现在有多少空间」。后者更接近组件真正关心的问题。

```css
.card-grid { container-type: inline-size; }

@container (min-width: 42rem) {
  .card { grid-template-columns: 12rem 1fr; }
}
```

这让同一个卡片可以安全地出现在侧栏、弹窗和主内容区，而不依赖页面级类名。布局知识回到组件边界内，复用也因此更可信。
