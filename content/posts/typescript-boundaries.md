---
title: "TypeScript 的价值发生在边界"
summary: "类型最有价值的地方，不是函数内部，而是网络、数据库与用户输入跨越系统边界的瞬间。"
categories: ["工程", "TypeScript"]
slug: "typescript-boundaries"
date: "2026-08-05"
---
## 类型不能验证现实

`as User` 只会让编译器安静，并不会让 API 返回的数据突然正确。系统边界需要运行时验证。

```ts
const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
})

const user = User.parse(await response.json())
```

内部代码可以依赖推断，外部数据必须经过验证。这样做形成一条简单规则：**边界严格，内部轻盈**。

### 错误也需要类型

不要只抛出 `new Error('failed')`。可恢复错误、权限错误和系统错误需要不同的用户界面。类型系统最终服务的不是代码，而是更诚实的交互。
