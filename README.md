# my-chat

桌面 AI 聊天客户端 —— Tauri 2 + React 19 + TypeScript,本地优先,支持多模型适配器、
知识库检索(RAG)、MCP 客户端,以及一套 SillyTavern 兼容的角色扮演(酒馆)子系统。

---

## 技术栈(2026-09 现代化后实测版本)

### 前端

| 类别 | 包 | 版本 |
|---|---|---|
| UI 框架 | react / react-dom | 19.3.0 |
| 类型 | @types/react / @types/react-dom | 19.3.0 |
| 语言 | typescript | 5.9.3(见下方「为什么没升 TS 7」)|
| 构建 | vite | 8.3.0(底层 rolldown) |
| 构建 | @vitejs/plugin-react | 6.1.1 |
| 样式 | tailwindcss | 4.3.3 |
| 测试 | vitest | 5.0.1 |
| Lint | eslint | 10.11.0 |
| 状态 | zustand | 5.0.15 |
| 渲染 | marked / react-markdown | 18.0.13 / 10.1.0 |

### 后端(Rust)

`tauri 2.11.5` · `tokio 1.53.0` · `reqwest 0.12.28` · `sled 0.34.7` ·
`pdf-extract 0.7` · `zip 2` · Windows 下用 DPAPI 加密 API key

---

## 开发命令

```bash
npm run dev        # 仅前端(vite,端口 1420)
npm run tauri dev  # 完整应用(需 Rust 工具链,首次编译较久)
npm run build      # 生产构建 = tsc && vite build
npm test           # vitest run
npm run lint       # eslint
```

Windows 上也可直接双击 `启动.bat`。

### 闸门脚本(审查期新增)

`scripts/gate.mjs` 是统一的验证入口,并附带一组**行为型断言闸门**:

```bash
node scripts/gate.mjs build          # = npm run build
node scripts/gate.mjs assert-git     # 版本控制基线(local HEAD == remote main、无巨物入库)
node scripts/gate.mjs assert-tests   # 0 失败且通过数不低于基线
node scripts/gate.mjs assert-lint    # 0 错误且告警不超基线
node scripts/gate.mjs assert-build   # 构建产物真实可用(被引用 assets 均存在)
```

**为什么需要它**:本机执行环境里的 `npm` / `npx` 被解析到一个损坏的 shim
(该 Node runtime 的 `node_modules/` 只有 `pnpm`,根本没有 `npm` 包,那几条 shim 是残留物),
导致 `npm run ...` 全部无法执行。`gate.mjs` 因此直接以 `node` 调本地二进制绕开。
**在 npm 正常的机器上继续用 `npm run build` / `npm test` 即可,两者语义等价。**

---

## 数据目录

| 内容 | 位置 |
|---|---|
| 错误日志 | `%APPDATA%\com.my-chat\chat_errors.log` |
| 启动标记 | `%APPDATA%\com.my-chat\startup.marker` |
| 角色卡 | `%APPDATA%\com.my-chat\characters\`(含 `avatars\`) |
| 酒馆会话 | `%APPDATA%\com.my-chat\tavern\{id}.json` |
| 推演会话 | `%APPDATA%\com.my-chat\simulation\{id}.json` |
| 工作模式会话 | sled 库(与酒馆/推演目录完全隔离) |

API key 经 Windows DPAPI 加密存储,密文带 `ENC:` 前缀,明文旧数据启动时自动迁移。

---

## 排障要点

1. **Tauri 2 的 ACL 坑**:`src-tauri/capabilities/default.json` 缺失会导致事件监听**静默失败**
   —— 表现为「请求成功但没有输出」。
2. **确认跑的是新版本**:看 `startup.marker` 的时间戳;release exe 才是独立可运行版。
3. **Rust 依赖拉取慢**:本机访问 `static.crates.io` 实测被限速到约 65 KB/s
   (同一包对比 rsproxy.cn 快约 17 倍)。已在 `~/.cargo/config.toml` 配 rsproxy 镜像;
   删除该文件即可还原默认源。
4. **坏记录自愈**:`db::settings::sanitize_models()` 在启动 setup 中执行。

---

## 为什么没升 TypeScript 7

`latest` 已是 7.0.2,但**实测证据否决了升级**:

```
$ npm view @typescript-eslint/parser@8.70.0 peerDependencies
{ eslint: '^8.57.0 || ^9.0.0 || ^10.0.0',
  typescript: '>=4.8.4 <6.1.0' }        # ← 不含 7.x
```

且 TS 没有稳定版 6 —— `dist-tags` 里 `beta: 6.0.0-beta`,而 `latest` 从 5.9 直跳 7.0.2。

升到 7.x 会让 `@typescript-eslint` 超出 peer 范围,**静默废掉本项目刻意建立的
`strict-type-checked` lint 闸** —— 那套规则正是靠 type-aware 解析工作的。
故本项目在 TS 5.9.3 上等待 typescript-eslint 支持 TS 7 后再评估。

---

## 已实现的子系统

- **多模型适配器**:16 个预设(OpenAI / Claude / Gemini / DeepSeek / Groq / Moonshot /
  智谱 / 通义 / 文心 / MiniMax / 零一 / Mistral / Cohere / OpenRouter / SiliconFlow / Ollama),
  支持自定义模板、SSE 规则、非流式
- **知识库 / RAG**:文档导入(PDF / docx)、BM25 + 向量混合检索
- **MCP 客户端**:stdio + JSON-RPC
- **缓存优化**:针对 DeepSeek prompt cache 的前缀稳定设计
- **Token 预算系统**:P0 稳定前缀 → … → P5 尾部注入 的优先级收缩,历史超限整段替换为摘要
- **酒馆(SillyTavern 兼容)**:角色卡 V1/V2/V3、PNG 卡导入、Persona、世界书、
  群聊、swipe 备用开场白、深度提示词
- **推演模式**:三段式提示词、骰子数据化、时间线分层
- **备份 / 导出 / WebDAV 同步**

---

## 相关文档

- [`PROGRESS.md`](./PROGRESS.md) —— 完整开发进展归档与排障经验
