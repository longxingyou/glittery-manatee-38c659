// foliate-js 未随包提供类型声明；这里只声明我们用到的入口。
// 运行时通过 `<foliate-view>` 自定义元素工作，具体实例类型在 preview.$id.tsx 内定义。
declare module 'foliate-js/view.js' {
  export const makeBook: (input: Blob | string) => Promise<unknown>
}
