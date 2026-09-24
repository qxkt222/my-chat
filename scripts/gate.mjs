#!/usr/bin/env node
/**
 * scripts/gate.mjs — 项目闸门统一入口
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一、为什么存在
 * ══════════════════════════════════════════════════════════════════════
 * 实测:本次审查环境的执行层把 `npm` / `npx` 解析到了损坏的 DSH runtime shim
 *   …/Oh-DSH Desktop/resources/node-runtime/npm
 * 而该 runtime 的 node_modules/ 里只有 pnpm、根本没有 npm 包,所以那几个 shim
 * 是残留物,必然报 "Could not determine Node.js install directory"。
 * (真实 npm 在 C:\Program Files\nodejs\npm.cmd,可用绝对路径调用。)
 * `node` 本身可用,node_modules 下的本地二进制也都完好 —— 故此处直接以 node 调用。
 *
 * ⚠️ 这是审查/升级期间的一致验证面,不替代 package.json。npm 正常的机器上继续用
 *    `npm run build` / `npm test` / `npm run lint`,语义等价。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 二、为什么有 assert-* 这一组(重要)
 * ══════════════════════════════════════════════════════════════════════
 * 最初本脚本只有「跑一条命令、看退出码」式闸门,被判为「判据空转」:
 *   `git ls-remote origin main` 无论有没有 push 过都返回 0 ——
 *   它验的是「远端存在」,不是「事做完了」。判据能被字符串本身满足 = 假绿。
 * assert-* 因此改为「真跑 + 读数 + 断言期望值」:命令把产物/报告落盘,
 * 再逐条核对数字,任一条不符即非 0 退出并打印原因。
 * 这类判据能被证伪 —— 把事情做坏它就会红,才算真闸门。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三、沙箱约束
 * ══════════════════════════════════════════════════════════════════════
 * 子进程输出一律重定向到临时文件后读文件,不用管道(stdio:'pipe')。
 * 某些执行档(pwsh 沙箱)下程序无法打开命名管道,管道 stdio 会 EPERM;
 * 重定向到文件在两种环境下都稳。
 *
 * 用法:
 *   node scripts/gate.mjs typecheck | lint | format | rustfmt | test | coverage | build | all
 *   node scripts/gate.mjs rust-check | rust-test | rust-clippy
 *   node scripts/gate.mjs assert-git     版本控制基线是否真的成立
 *   node scripts/gate.mjs assert-tests   0 失败且用例数不低于基线
 *   node scripts/gate.mjs assert-lint    0 错误且告警数不超基线
 *   node scripts/gate.mjs assert-format  prettier 不合格文件数不超基线
 *   node scripts/gate.mjs assert-rustfmt rustfmt 无 diff
 *   node scripts/gate.mjs assert-coverage 覆盖率四项读数不低于地板
 *   node scripts/gate.mjs assert-build   构建产物真实可用
 *
 * ⚠️ 2026-09-25 最严健康度审查补录：format 与 rustfmt 这两道闸门是**新接的**。
 *    在此之前「prettier 全绿 · fmt 0 diff」只写在 PROGRESS.md 的标准行里，
 *    gate 里没有任何对应检查 —— 实测当时 prettier 有 42 个文件不合格、
 *    rustfmt 有 diff，而这两项「全绿」被当成事实用了好几轮。
 *    文档承诺 ≠ 闸门：凡是写进标准行的读数，都必须有一道能变红的闸门兜着。
 *    lint 闸门同理补 --max-warnings 0 —— 否则告警不改退出码，又是假绿（与 clippy 同型）。
 *
 * 退出码:0 通过;1 断言失败;其它非 0 = 子进程退出码;127 = 无法启动。
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根:始终由脚本自身位置推导,与调用时 cwd 无关 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

/** 基线读数(2026-09-19 升级前实测)。断言以此为地板/天花板。 */
const BASELINE = {
  trackedFiles: 234, // git ls-files 实测
  minTests: 34, // vitest numPassedTests 实测
  // 2026-09-25 最严健康度审查：4 → 0。
  // 原值把「升级前的实测值」当成了容忍上限，于是 eslint 报 3 条告警时 lint 闸门照样绿灯 ——
  // 标准写着「0 警告」，闸门却放行 4 条。现清零，并给 lint 闸门加 --max-warnings 0。
  maxLintWarnings: 0,
  lintErrors: 0,
  // 2026-09-25 新增：这两条标准此前只写在文档里，闸门里根本没有对应检查 ——
  // 实测当时 prettier 有 42 个文件不合格、rustfmt 有 diff，全都没人发现。
  maxPrettierUnformatted: 0,
  maxRustfmtDiffFiles: 0,
};

const BIN = {
  tsc: "node_modules/typescript/bin/tsc",
  vite: "node_modules/vite/bin/vite.js",
  vitest: "node_modules/vitest/vitest.mjs",
  eslint: "node_modules/eslint/bin/eslint.js",
  prettier: "node_modules/prettier/bin/prettier.cjs",
};

/** 源码 glob：与 package.json scripts 一致，防两处漂移 */
const SRC_GLOB = "src/**/*.{ts,tsx,css,html}";
const LINT_GLOB = "src/**/*.{ts,tsx}";

const TMP = mkdtempSync(path.join(tmpdir(), "my-chat-gate-"));

/** 解析 cargo:本机 bash 的 PATH 里没有 cargo,故优先 rustup 默认位置 */
function resolveCargo() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [
    process.env.CARGO,
    home ? path.join(home, ".cargo", "bin", "cargo.exe") : null,
    "C:/Users/1/.cargo/bin/cargo.exe",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "cargo";
}
const CARGO = resolveCargo();

/** 直接跑,stdio 全继承(给人看的闸门) */
function step(cmd, args, cwd = ".") {
  console.log(`\n▸ ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: path.resolve(ROOT, cwd),
    stdio: "inherit",
    env: process.env,
  });
  if (r.error) {
    console.error(`✗ 无法启动:${r.error.message}`);
    return 127;
  }
  return r.status ?? 1;
}

/** 跑并把 stdout+stderr 重定向到临时文件后读回(不用管道,规避 EPERM) */
function capture(cmd, args, cwd = ".") {
  const out = path.join(TMP, `cap-${Math.random().toString(36).slice(2)}.txt`);
  const fd = openSync(out, "w");
  try {
    const r = spawnSync(cmd, args, {
      cwd: path.resolve(ROOT, cwd),
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    return { status: r.status ?? 1, text: existsSync(out) ? readFileSync(out, "utf8") : "" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

// ── 断言小工具 ──────────────────────────────────────────────
const failures = [];
function check(ok, label, detail) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}
function finish(title) {
  if (failures.length) {
    console.error(`\n✗ ${title}: ${failures.length} 条断言未过`);
    failures.forEach((f) => console.error(`   · ${f}`));
    return 1;
  }
  console.log(`\n✓ ${title}: 全部断言通过`);
  return 0;
}

// ── 闸门 ────────────────────────────────────────────────────
const GATES = {
  typecheck: {
    desc: "TypeScript 严格类型检查(tsc --noEmit)",
    run: () => step(NODE, [BIN.tsc, "--noEmit"]),
  },
  lint: {
    desc: "ESLint(flat config,与 package.json 同 glob，警告即失败)",
    // ⚠️ 必须带 --max-warnings 0：eslint 默认「有告警仍 exit 0」，
    //    与 clippy 不带 -D warnings 是同一类假绿。实测证据（2026-09-25）：
    //    同一份代码不带该参数 exit 0，带上 exit 1。
    run: () => step(NODE, [BIN.eslint, LINT_GLOB, "--max-warnings", "0"]),
  },
  format: {
    desc: "Prettier 格式检查(只读,不改文件)",
    run: () => step(NODE, [BIN.prettier, "--check", SRC_GLOB]),
  },
  rustfmt: {
    desc: "rustfmt 格式检查(cargo fmt --check,只读)",
    run: () => step(CARGO, ["fmt", "--check"], "src-tauri"),
  },
  test: {
    desc: "vitest run(单元 + 组件冒烟)",
    run: () => step(NODE, [BIN.vitest, "run"]),
  },
  coverage: {
    desc: "vitest run --coverage(覆盖率地板阈值见 vite.config.ts)",
    // 阈值写在 vite.config.ts 的 test.coverage.thresholds ——
    // 覆盖率不足时 vitest 自己 exit 1，闸门无需另算百分比。
    run: () => step(NODE, [BIN.vitest, "run", "--coverage"]),
  },
  build: {
    desc: "生产构建(= npm run build)",
    run: () => {
      const a = step(NODE, [BIN.tsc, "--noEmit"]);
      if (a !== 0) {
        console.error("✗ typecheck 未过,不继续 vite build");
        return a;
      }
      return step(NODE, [BIN.vite, "build"]);
    },
  },
  all: {
    desc: "全套闸门:typecheck → lint → format → rustfmt → test → coverage → build",
    run: () => {
      for (const g of ["typecheck", "lint", "format", "rustfmt", "test", "coverage", "build"]) {
        const code = GATES[g].run();
        if (code !== 0) {
          console.error(`\n✗ 闸门 "${g}" 失败(exit ${code})`);
          return code;
        }
      }
      return 0;
    },
  },

  "rust-check": {
    desc: "cargo check --all-targets",
    run: () => step(CARGO, ["check", "--all-targets"], "src-tauri"),
  },
  "rust-test": { desc: "cargo test", run: () => step(CARGO, ["test"], "src-tauri") },
  "rust-clippy": {
    // ⚠️ 必须带 `-- -D warnings`：cargo clippy 的警告默认**不改退出码**，
    //    只传 --all-targets 时即使有告警也会 exit 0 —— 那是假绿。
    //    实测证据（2026-09-19）：同一份代码无参 exit 0，加 -- -D warnings exit 101。
    //    假绿与假红同样有害，闸门必须读数准。
    desc: "cargo clippy --all-targets（pedantic，警告即失败）",
    run: () => step(CARGO, ["clippy", "--all-targets", "--", "-D", "warnings"], "src-tauri"),
  },

  // ── 行为型断言闸门:真跑 + 读数 + 核对期望值 ──────────────
  "assert-git": {
    desc: "版本控制基线断言(local HEAD == remote main,索引干净且不含巨物)",
    run: () => {
      console.log("\n读真实 git 状态:");
      const head = capture("git", ["rev-parse", "HEAD"]);
      const remote = capture("git", ["ls-remote", "origin", "main"]);
      const files = capture("git", ["ls-files"]);
      const status = capture("git", ["status", "--porcelain"]);

      const localSha = head.text.trim();
      const remoteSha = (remote.text.trim().split(/\s+/)[0] ?? "").trim();
      const tracked = files.text.split("\n").filter(Boolean);
      const targetN = tracked.filter((f) => f.startsWith("src-tauri/target")).length;
      const nmN = tracked.filter((f) => f.includes("node_modules")).length;
      const dirty = status.text.split("\n").filter(Boolean).length;

      console.log(`  local HEAD  = ${localSha || "(空)"}`);
      console.log(`  remote main = ${remoteSha || "(空)"}`);
      console.log(`  tracked     = ${tracked.length}`);
      console.log(`  dirty paths = ${dirty}`);

      check(remote.status === 0, "远端 main 可读取", `exit ${remote.status}`);
      check(
        localSha.length === 40 && localSha === remoteSha,
        "本地 HEAD 与远端 main 完全一致(即已真正推送)",
        `local=${localSha.slice(0, 8)} remote=${remoteSha.slice(0, 8)}`,
      );
      check(
        tracked.length >= BASELINE.trackedFiles,
        `索引文件数 ≥ 基线 ${BASELINE.trackedFiles}`,
        `实测 ${tracked.length}`,
      );
      check(targetN === 0, "src-tauri/target 零文件入索引", `实测 ${targetN}`);
      check(nmN === 0, "node_modules 零文件入索引", `实测 ${nmN}`);
      check(dirty === 0, "工作区干净(无未跟踪/未提交改动)", `实测 ${dirty} 条`);
      return finish("assert-git");
    },
  },

  "assert-tests": {
    desc: "单测断言:0 失败且通过数不低于基线",
    run: () => {
      const report = path.join(TMP, "vitest-report.json");
      console.log("\n跑 vitest 并产出 JSON 报告…");
      const r = spawnSync(
        NODE,
        [BIN.vitest, "run", "--reporter=json", `--outputFile=${report}`],
        { cwd: ROOT, stdio: "inherit", env: process.env },
      );
      if (!existsSync(report)) {
        console.error(`✗ 未能产出测试报告(${r.error?.message ?? "报告文件不存在"})`);
        return 1;
      }
      const j = JSON.parse(readFileSync(report, "utf8"));
      console.log(
        `  total=${j.numTotalTests} passed=${j.numPassedTests} failed=${j.numFailedTests} files=${j.testResults?.length ?? "?"}`,
      );
      check(j.numFailedTests === 0, "失败用例数 == 0", `实测 ${j.numFailedTests}`);
      check(
        j.numPassedTests >= BASELINE.minTests,
        `通过用例数 ≥ 基线 ${BASELINE.minTests}`,
        `实测 ${j.numPassedTests}`,
      );
      check(j.success === true, "vitest success == true", `实测 ${j.success}`);
      return finish("assert-tests");
    },
  },

  "assert-lint": {
    desc: "lint 断言:0 错误且告警数不超基线",
    run: () => {
      const r = capture(NODE, [BIN.eslint, "src/**/*.{ts,tsx}"]);
      // ⚠️ 只认汇总行,不能随便抓「数字 + warning」:
      //    ESLint 每条形如 "  297:5  warning  ...",用 /(\d+)\s+warnings?/ 会
      //    先匹配到行:列里的列号(297:5 → "5  warning"),把 4 条告警误读成 5 条。
      //    此坑已实测踩过:闸门报了假红,而真实读数自始至终是 4。
      //    假红与假绿同样有害 —— 闸门必须读数准。
      let errors = NaN;
      let warnings = NaN;
      const sum = r.text.match(
        /(\d+)\s+problems?\s*\(\s*(\d+)\s+errors?\s*,\s*(\d+)\s+warnings?\s*\)/i,
      );
      if (sum) {
        errors = Number(sum[2]);
        warnings = Number(sum[3]);
      } else {
        // 回退:按「行:列  级别」的行首形态逐行计数
        const lines = r.text.split("\n");
        errors = lines.filter((l) => /^\s*\d+:\d+\s+error\b/.test(l)).length;
        warnings = lines.filter((l) => /^\s*\d+:\d+\s+warning\b/.test(l)).length;
      }
      console.log(`  errors=${errors} warnings=${warnings}`);
      check(errors === BASELINE.lintErrors, `错误数 == ${BASELINE.lintErrors}`, `实测 ${errors}`);
      check(
        Number.isFinite(warnings) && warnings <= BASELINE.maxLintWarnings,
        `告警数 ≤ 基线 ${BASELINE.maxLintWarnings}`,
        `实测 ${warnings}`,
      );
      return finish("assert-lint");
    },
  },

  "assert-format": {
    desc: "格式断言:prettier 不合格文件数 ≤ 基线",
    run: () => {
      const r = capture(NODE, [BIN.prettier, "--check", SRC_GLOB]);
      // 口径：prettier --check 每个不合格文件打一行 "[warn] <路径>"。
      // 不解析汇总行——没有汇总行，只有逐文件 warn + 结尾一句提示。
      const bad = r.text.split("\n").filter((l) => l.startsWith("[warn]")).length;
      console.log(`  prettier 不合格文件 = ${bad}`);
      check(r.status === 0, "prettier --check 退出码 == 0", `实测 ${r.status}`);
      check(
        bad <= BASELINE.maxPrettierUnformatted,
        `不合格文件数 ≤ ${BASELINE.maxPrettierUnformatted}`,
        `实测 ${bad}`,
      );
      return finish("assert-format");
    },
  },

  "assert-rustfmt": {
    desc: "Rust 格式断言:rustfmt 无 diff",
    run: () => {
      const r = capture(CARGO, ["fmt", "--check"], "src-tauri");
      // 口径：--check 只列「Diff in <文件>:<行>」首部，每个文件一段。
      // 按文件去重计数，避免同一文件的多个 diff 段被当成多个文件。
      const files = new Set(
        [...r.text.matchAll(/^Diff in (.+?):\d+/gm)].map((m) => m[1].replace(/^\\\\\?\\/, "")),
      );
      console.log(`  rustfmt 有 diff 的文件 = ${files.size}`);
      check(r.status === 0, "cargo fmt --check 退出码 == 0", `实测 ${r.status}`);
      check(
        files.size <= BASELINE.maxRustfmtDiffFiles,
        `有 diff 的文件数 ≤ ${BASELINE.maxRustfmtDiffFiles}`,
        `实测 ${files.size}`,
      );
      return finish("assert-rustfmt");
    },
  },

  "assert-coverage": {
    desc: "覆盖率断言:真跑 --coverage 且四项读数不低于地板",
    run: () => {
      const code = GATES.coverage.run();
      if (code !== 0) {
        console.error(`✗ 覆盖率闸门本身失败(exit ${code}),无法断言读数`);
        return code;
      }
      const p = path.join(ROOT, "coverage", "coverage-summary.json");
      if (!existsSync(p)) {
        check(false, "coverage/coverage-summary.json 存在");
        return finish("assert-coverage");
      }
      const total = JSON.parse(readFileSync(p, "utf8")).total ?? {};
      // 地板与 vite.config.ts 的 thresholds 同源,但这里独立复核一遍:
      // 只看退出码的话,阈值被谁删掉都不会有人发现。
      //
      // ⚠️ 口径差(已实测,不是 bug):同一份覆盖率有两个读数 ——
      //    · 控制台 "All files" 行:  branches 52.24 (v8 provider 自己的算法)
      //    · coverage-summary.json:  branches 52    (istanbul 经典 covered/total=440/846=52.0046,被 floor)
      //    这里**故意**读结构化 JSON:字段名稳定、可编程读,不依赖表格排版;
      //    代价是比控制台低不到 1 个点。地板取值时已把这点余量算进去。
      const floors = { lines: 58, statements: 56, functions: 47, branches: 50 };
      for (const [k, floor] of Object.entries(floors)) {
        const v = total[k]?.pct ?? NaN;
        console.log(`  ${k} = ${v}% (地板 ${floor}%)`);
        check(Number.isFinite(v) && v >= floor, `${k} ≥ ${floor}%`, `实测 ${v}%`);
      }
      return finish("assert-coverage");
    },
  },

  "assert-build": {
    desc: "构建产物断言:dist 真实可用",

    run: () => {
      const code = GATES.build.run();
      if (code !== 0) {
        console.error(`✗ 构建本身失败(exit ${code}),无法断言产物`);
        return code;
      }
      const dist = path.join(ROOT, "dist");
      const indexPath = path.join(dist, "index.html");
      check(existsSync(indexPath), "dist/index.html 存在");
      if (existsSync(indexPath)) {
        const html = readFileSync(indexPath, "utf8");
        check(/<script/i.test(html) || /<link/i.test(html), "index.html 含 script/link 引用");
        const refs = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
        check(refs.length > 0, "index.html 至少引用一个 assets 资源", `实测 ${refs.length}`);
        const missing = refs.filter((rel) => !existsSync(path.join(dist, rel)));
        check(missing.length === 0, "所有被引用的 assets 均真实存在", `缺失:${missing.join(",")}`);
      }
      const assetsDir = path.join(dist, "assets");
      if (existsSync(assetsDir)) {
        const js = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
        const total = js.reduce((s, f) => s + statSync(path.join(assetsDir, f)).size, 0);
        console.log(`  assets: ${js.length} 个 js,合计 ${(total / 1024).toFixed(1)} kB`);
        check(js.length > 0, "产出至少一个 js chunk");
        check(
          total > 100 * 1024,
          "js 总量 > 100 kB(排除空构建)",
          `实测 ${(total / 1024).toFixed(1)} kB`,
        );
      } else {
        check(false, "dist/assets 目录存在");
      }
      return finish("assert-build");
    },
  },
};

const which = process.argv[2];
if (!which || !GATES[which]) {
  console.log("用法: node scripts/gate.mjs <gate>\n");
  console.log("可用闸门:");
  for (const [name, g] of Object.entries(GATES)) console.log(`  ${name.padEnd(14)} ${g.desc}`);
  console.log(`\n项目根: ${ROOT}`);
  console.log(`cargo:  ${CARGO}`);
  console.log(
    `基线:   文件 ${BASELINE.trackedFiles} · 用例 ${BASELINE.minTests} · 告警 ≤${BASELINE.maxLintWarnings}`,
  );
  process.exit(which ? 2 : 0);
}

console.log(`▸ gate: ${which} — ${GATES[which].desc}`);
const code = GATES[which].run();
if (code === 0 && !which.startsWith("assert-")) console.log(`\n✓ gate "${which}" 通过`);
process.exit(code);
