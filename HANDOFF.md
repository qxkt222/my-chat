# my-chat 交接文档（2026-10-31）

> 本文记录 2026-10-31 交接时的状态。**该轮改动已于 2026-11-01 提交并合并进 `main`**，
> 第 1 节的状态描述保留作历史快照。

## 1. 当时状态

- 分支：`main`，HEAD `ad47209`（工作区有大量未提交改动）
- 改动规模：约 100 文件，+14000 / −2000 行，含 50+ 个新测试文件
- 最近一次完整门禁：**前端 636 passed / 5 skipped，Rust 298 passed**，七项全绿
  - 之后又做了 3 次小修（自动填模型名、绘图探测文案、记忆图谱关闭），每次只跑了 `test`/`typecheck`/`format`；**收尾前必须再跑一次完整门禁**
- 前端 dev server 可能仍在运行（`my-chat.exe` + Vite 1420），接手前先关掉

## 2. 门禁命令（项目根执行）

```
node scripts/gate.mjs typecheck
node scripts/gate.mjs lint
node scripts/gate.mjs format
node scripts/gate.mjs test
node scripts/gate.mjs rustfmt
node scripts/gate.mjs rust-test
node scripts/gate.mjs rust-clippy
```

阈值在 `scripts/gate.mjs`（minTests、覆盖率地板等）。注意该文件要求 `npm` 走本地 node 调用，不要用系统 npm shim。

## 3. 本轮做了什么

### 全项目审查
13 路只读审查，产出 4×P0 / 31×P1 / 117×P2 / 15×P3。报告全文在本机临时目录下的
审查产物目录（SUMMARY.md + 13 份模块报告 + TASKS.json 工单表），未入库。

### 修复
- **P0 4/4**：预算收缩吞本轮输入、酒馆后台摘要旧快照回写、备份导入失败导致应用永久打不开、并发 streamChat 重复注册监听
- **P1 30/31**：流内错误、超时文案、done 双发、RAG 分词与维度、知识库删 chunks、角色卡字段、摘要丢失、压缩期发送、regenerate 守卫、群聊重试、swipe 真源、停止串、模型参数 scope、api_url 校验、预设排序、插件启动恢复等
- **P2 117/117**：按模块全部落地
- **遗留 1 条 P1**：`useSettingsStore.persistModel()` 里 `m.parameters || defaultParameters` 的同型写法（`save()` 已改，这个入口没改）

### 新功能
- **翻译**：新增 `local` 引擎（OpenAI 兼容端点：Ollama / LM Studio / llama.cpp server），设置页可配置、拉取模型、测试；线上 google/deepl/libre 保留
- **绘图**：新增 `comfyui` / `sdwebui` 引擎 + 独立设置 tab（模型下载链接与搭建指引）、工作区参数表单、多图结果；保留 `openai` / `chat-model`
- **内置 llama.cpp 运行时**：用户自备 `llama-server.exe` + `.gguf`，应用负责启动/停止/健康检查/退出清理；启动成功后自动填 Base URL 与模型名

## 4. 真机验证结果

已验证：
- 翻译本地引擎（内置运行时启动 → 翻译测试成功）
- 内置 llama.cpp 的 start / health 200 / `/v1/models` 200 / stop（代理用本机 llama-server 验过）
- 聊天：发送、中途终止、重试，回复不丢
- 酒馆：切版本正常
- 设置 scope：对话/工作来回切，不串值
- 备份：创建、列表、恢复各一次

未验证：
- **绘图真出图**（机器上没有 ComfyUI / SD WebUI，只验了「服务未连接」的错误提示）
- 备份恢复后的数据完整性（只确认恢复流程走完，未逐项核对会话/角色/知识库）
- 非 Windows 平台

## 5. 需要你知道的设计变化

1. **新增依赖 `encoding_rs`**：GBK/GB18030 文本解码用（用户已批准保留）。
2. **MCP `ui_html` 去掉 `allow-same-origin`**：富 UI 失去同源 fetch/localStorage，依赖同源的 MCP 面板会受影响。
3. **取消生成有 500ms 宽限**：停止后迟到事件可能仍在 500ms 内到达。
4. **停止串改为 blur/保存才落盘**：点取消会丢弃未提交的编辑。
5. **内置运行时不做应用内下载**：二进制和模型由用户自备，这是明确的产品决策。

## 6. 已知风险 / 未做

- 绘图三引擎只做了单测契约，没有对真实 ComfyUI/SD WebUI 联调
- RAG 的「按库维度自动选 embedder」未做：跨维 chunk 会被过滤（不再污染 RRF），但 OpenAI 索引的块在 keyword 检索下只走 BM25
- P3 15 条（推断/设计选择）未处理，清单在 TASKS.json 里 `severity=P3`
- 真机只覆盖 Windows

## 7. 收尾建议

1. 跑完整七项门禁，确认数字与上面一致（小修后可能略高：最新单跑 vitest 是 646）
2. 建分支提交，不要直接提 `main`
3. 提交信息里说明：审查 + 全量修复 + 翻译/绘图/内置 llama.cpp
4. 可选：装一个 ComfyUI 或 SD WebUI 做绘图真出图验证
5. 可选：补 `persistModel()` 的同型写法（P1 遗留）

## 8. 关键文件索引

| 内容 | 位置 |
|---|---|
| 审查汇总 | 本机审查产物目录 `SUMMARY.md`（未入库） |
| 修复工单（167 条） | 同上 `TASKS.json` |
| 13 份模块报告 | 同目录 `RUST-*.md` / `FE-*.md` |
| 翻译/绘图侦察与契约 | 同目录 `TRANS-DRAW-RECON.md` |
| 修复完成汇总 | 同目录 `FINAL-SUMMARY.md` |
| 新增：llama 运行时 | `src-tauri/src/commands/llama.rs` |
| 新增：翻译本地引擎 | `src-tauri/src/commands/translate.rs` |
| 新增：绘图三引擎 | `src-tauri/src/commands/draw.rs` |
| 新增：llama 设置 UI | `src/components/settings/TranslateManager.tsx` + `src/stores/useLlamaStore.ts` |
| 新增：绘图设置 UI | `src/components/settings/SettingsDialog.tsx`（drawing tab） |

## 9. 临时文件

- 项目内 `.audit-tasks/` 已删除
- 本机临时目录下的审查产物可保留给下一位，不需要提交
