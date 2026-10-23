// lib/regex-cache.ts — 正则编译缓存（显示 / 出站 / 世界书 / 设置预览共用）
//
// ═══════════════════════════════════════════════════════════════════════════
// 一、为什么存在（2026-10-23 体检 SRC-14）
// ═══════════════════════════════════════════════════════════════════════════
// 四个调用点在每次调用时都 `new RegExp(pattern, flags)`：
//   · lib/regex-format.ts   —— 渲染期规则（MessageBubble 每个流式 token 都跑）
//   · lib/outgoing-regex.ts —— 出站规则（每条消息 × 每条规则）
//   · lib/rp-prompt.ts      —— 世界书正则关键词（每条条目 × 每个关键词）
//   · components/settings/RegexManager.tsx —— 设置页预览/命中计数
// 正则编译是确定性的纯计算：同一 (pattern, flags) 的结果永远相同，编译一次复用即可。
// 流式输出时 N 条规则 × 每 token 重编译，是这个函数存在的唯一理由。
//
// ═══════════════════════════════════════════════════════════════════════════
// 二、lastIndex 方案（必须看，容易踩）
// ═══════════════════════════════════════════════════════════════════════════
// 带 `g` / `y` 标志的 RegExp 是**有状态对象**：exec()/test() 会读写 lastIndex。
// 直接跨调用共享同一实例，会把「上一次匹配停在哪」泄漏给下一次调用。
//
// 本模块的方案：**每次取用（含缓存命中）返回前把 lastIndex 重置为 0**。
//   · 对本项目的四种用途（String.replace / String.match / 一次性 test）安全 ——
//     它们要么内部自己归零（replace/match 的 g 分支），要么从 0 开始。
//   · 约束：不要在多轮 exec 循环中途重新调用 compileRegex 取实例 ——
//     那会把你正在迭代的 lastIndex 清掉。需要跨轮持有状态时，请在本轮开始前
//     把实例存到局部变量里，循环中不要再次调用 compileRegex。
//
// 为什么不是「命中时返回副本」：
//   返回副本要么 `new RegExp(source, flags)`（等于重新编译，缓存失去意义），
//   要么手写克隆（JS 没有廉价的 RegExp 复制 API）。归零 lastIndex 是成本最低、
//   且对当前全部调用点都正确的折中。
//
// ═══════════════════════════════════════════════════════════════════════════
// 三、ReDoS（灾难性回溯）—— 当前只做最小缓解，风险由用户自担
// ═══════════════════════════════════════════════════════════════════════════
// `(a+)+$` 这类 pattern 可以把 webview 主线程冻住：本仓库目前**没有 Worker、
// 也没有匹配超时**（2026-10-23 全仓确认），JS 正则一旦开始回溯无法从外部打断。
//
// 这里只加一道**长度闸门**：pattern.length > MAX_PATTERN_LENGTH 直接拒绝（返回 null），
// 并 console.warn 一次（进程内只报一次，避免每帧刷屏）。
//   · 能挡住：粘贴/自动生成的超长 pattern（常见事故形态），成本为零；
//   · 挡不住：**短的**恶意 pattern —— 100 个字符的 `(a+)+$` 照样能炸。
// 因此正确表述是「缩小暴露面」，不是「已防御」。彻底方案（后续可做）：
//   把匹配移进 Web Worker + 超时（超时后 terminate worker 重建），
//   调用方拿到 null/原文即可 —— 属于行为级改动，需单独一批做。
// **用户自定义正则的 ReDoS 风险目前由用户自担。**
//
// ═══════════════════════════════════════════════════════════════════════════
// 四、缓存容量
// ═══════════════════════════════════════════════════════════════════════════
// 设置页预览是**每次按键**都编译，恶意/失控输入会让 Map 无限增长，故每个
// flags 桶设上限 MAX_CACHE_ENTRIES，超出按插入顺序淘汰最旧一条（FIFO，够用且
// 无额外记账）。实际 flags 组合只有 g / gi / i 等个位数，总条目因此有界。
// 无效 pattern 的 null 结果也入缓存：坏规则在流式渲染里同样会被反复请求。

/** pattern 长度上限：超过即拒绝编译（ReDoS 最小长度闸门，见文件头说明） */
export const MAX_PATTERN_LENGTH = 1000;

/** 每个 flags 桶的条目上限：超出按 FIFO 淘汰（防设置页逐键预览把 Map 撑爆） */
const MAX_CACHE_ENTRIES = 500;

/**
 * 逻辑 key = (pattern, flags)，等价于 `pattern + "\u0000" + flags`。
 *
 * 物理上拆成两级 Map（flags → pattern），而不是拼一条长字符串：
 *  · 实测（Node 24，25 条规则 × 5 万轮 = 125 万次）：拼接 key + 单层 Map 要
 *    331ms，比**不缓存**直接 new RegExp 的 111ms 还慢（V8 内置了正则编译缓存，
 *    new RegExp 本身很便宜；瓶颈是每次新建长字符串 key 并重新哈希）；
 *    本模块的两级 Map 实测 23.4ms，约为直接编译的 1/4.8。
 *  · flags 里不含 \u0000，flags / pattern 的拆分无歧义，key 空间与拼接方案一一对应。
 */
const cacheByFlags = new Map<string, Map<string, RegExp | null>>();

/** 「超长已告警」闩锁：整个进程只 warn 一次 */
let warnedTooLong = false;

/**
 * 编译并缓存正则。
 *
 * @returns 命中/新建的 RegExp（**同一 key 返回同一实例**，取用时 lastIndex 已归零）；
 *          空 pattern、无效 pattern、非法 flags、超长 pattern 一律返回 `null`，**不抛**。
 *          调用方按「坏规则跳过」处理即可（与原来的 try/catch 语义一致）。
 */
export function compileRegex(pattern: string, flags?: string): RegExp | null {
  // 类型声明挡不住来自 JSON 的坏数据（SRC-08）：运行时再确认真的是 string
  const rawPattern: unknown = pattern;
  if (typeof rawPattern !== "string" || rawPattern.length === 0) return null;

  if (rawPattern.length > MAX_PATTERN_LENGTH) {
    if (!warnedTooLong) {
      warnedTooLong = true;
      console.warn(
        `[regex-cache] 正则长度 ${rawPattern.length} 超过上限 ${MAX_PATTERN_LENGTH}，已跳过（ReDoS 防护）。前 80 字符：${rawPattern.slice(0, 80)}`
      );
    }
    return null;
  }

  const rawFlags: unknown = flags;
  const f = typeof rawFlags === "string" ? rawFlags : "";

  let bucket = cacheByFlags.get(f);
  if (bucket) {
    const cached = bucket.get(rawPattern);
    if (cached !== undefined) {
      // 带 g/y 的实例有状态：每次取用都从 0 开始（见文件头「lastIndex 方案」）
      if (cached) cached.lastIndex = 0;
      return cached;
    }
  } else {
    bucket = new Map<string, RegExp | null>();
    cacheByFlags.set(f, bucket);
  }

  let compiled: RegExp | null;
  try {
    compiled = new RegExp(rawPattern, f);
  } catch {
    // 无效 pattern / 非法 flags —— 缓存 null，坏规则在热路径上不会被反复尝试
    compiled = null;
  }

  if (bucket.size >= MAX_CACHE_ENTRIES) {
    const oldest = bucket.keys().next();
    if (!oldest.done) bucket.delete(oldest.value);
  }
  bucket.set(rawPattern, compiled);
  return compiled;
}

/**
 * 清空缓存并复位「超长已告警」闩锁。
 * 仅测试用（保证用例之间实例身份可重复）；生产代码无需调用 ——
 * 规则变化时 key 自然不同，旧条目由 FIFO 上限兜底。
 */
export function clearRegexCache(): void {
  cacheByFlags.clear();
  warnedTooLong = false;
}
