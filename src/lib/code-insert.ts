// lib/code-insert.ts — 代码块「插入到输入框」模块级 handler
//
// 从 MessageRenderer 拆出的轻量模块:ChatInput 需要注册回调,而 MessageRenderer
// 是懒加载 chunk(react-markdown + highlight ~600KB)。此前 ChatInput 静态
// import 它导致动态导入失效、主 bundle 膨胀到 ~1000KB。拆出后 MessageRenderer
// 恢复纯动态导入,主 bundle 回到 ~390KB。

let insertCodeHandler: ((code: string) => void) | null = null;

/** 由 ChatInput 注册;渲染器内 CodeBlock 通过模块导入调用 */
export function setCodeInsertHandler(fn: ((code: string) => void) | null): void {
  insertCodeHandler = fn;
}

/** 由 MessageRenderer 的 CodeBlock 调用 */
export function fireCodeInsert(code: string): void {
  insertCodeHandler?.(code);
}
