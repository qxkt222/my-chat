# my-chat

Tauri 2 + React 19 + Rust 的 LLM 聊天客户端，v0.2.0。

## 完成定义（Definition of Done）

任务算完成，必须同时满足：

1. 门禁全绿：`node scripts/gate.mjs` 依次跑
   `typecheck` / `lint` / `format` / `test` / `rustfmt` / `rust-test` / `rust-clippy`
   （不要用系统 npm shim）
2. **主代理亲自跑门禁**。子代理说“测试全过”不算证据，不能据此关任务。
3. 任务改动的行为有测试覆盖，不引入未覆盖分支。
4. 没跑门禁 = 未完成，禁止报“已完成”。

## 边界

- 工作区含大量未提交改动与历史重写，提交前先看 `git status`。
- 基线（v0.2.0）：前端 646 tests / 5 skipped，Rust 298 tests。数字变化要能解释。

## 长任务书

任务描述超过 800 字符时，先落盘到仓库外的临时目录（`<临时目录>/briefs/<任务名>.md`），
会话里只引用路径，不要贴内容。
