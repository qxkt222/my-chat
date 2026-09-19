#!/usr/bin/env node
/**
 * scripts/gate.mjs — 项目闸门统一入口
 *
 * 存在的理由(实测,非推测):
 *   本次审查环境的执行层把 `npm` / `npx` 解析到了损坏的 DSH runtime shim:
 *     …/Oh-DSH Desktop/resources/node-runtime/npm  →  缺 node_modules/npm/bin/npm-prefix.js
 *   导致 `npm run build` / `npm test` / `npm run lint` 全部报
 *     "Could not determine Node.js install directory" 而无法执行。
 *   而 `node` 本身可用(v26.0.0),node_modules 下的本地二进制也都完好 ——
 *   因此这里直接以 node 调用本地二进制,绕开 npm。
 *   (真实 npm 位于 C:\Program Files\nodejs\npm.cmd,可用绝对路径调用,但包装脚本更稳定。)
 *
 * ⚠️ 这是审查/升级期间的一致验证面,不替代 package.json。
 *    在 npm 正常的机器上继续用 `npm run build` / `npm test` / `npm run lint`,语义等价:
 *      build     ≡ npm run build   (tsc && vite build)
 *      test      ≡ npm test        (vitest run)
 *      lint      ≡ npm run lint    (eslint src/**\/*.{ts,tsx})
 *
 * 沙箱约束:spawn 一律 stdio:"inherit"。
 *   本环境下 child_process 默认的管道 stdio('pipe')会因无法打开命名管道而 EPERM 失败。
 *
 * 用法:
 *   node scripts/gate.mjs typecheck     tsc --noEmit(严格档全开)
 *   node scripts/gate.mjs lint          eslint
 *   node scripts/gate.mjs test          vitest run
 *   node scripts/gate.mjs build         tsc && vite build
 *   node scripts/gate.mjs all           typecheck → lint → test → build,首个失败即停
 *   node scripts/gate.mjs rust-check    cargo check --all-targets
 *   node scripts/gate.mjs rust-test     cargo test
 *   node scripts/gate.mjs rust-clippy   cargo clippy --all-targets
 *
 * 退出码:0 通过;非 0 = 子进程退出码(127 = 无法启动)。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根:始终由脚本自身位置推导,与调用时的 cwd 无关 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

/** node_modules 下的本地二进制(相对项目根) */
const BIN = {
  tsc: "node_modules/typescript/bin/tsc",
  vite: "node_modules/vite/bin/vite.js",
  vitest: "node_modules/vitest/vitest.mjs",
  eslint: "node_modules/eslint/bin/eslint.js",
};

/** 解析 cargo:本机 bash 的 PATH 里没有 cargo,故优先用 rustup 默认安装位置 */
function resolveCargo() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [
    process.env.CARGO,
    home ? path.join(home, ".cargo", "bin", "cargo.exe") : null,
    "C:/Users/1/.cargo/bin/cargo.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "cargo"; // 交给 PATH
}

const CARGO = resolveCargo();

/** 跑一个子进程,继承 stdio,返回退出码 */
function step(cmd, args, cwd = ".") {
  const shown = [cmd, ...args].join(" ");
  console.log(`\n▸ ${shown}   (cwd=${cwd})`);
  const r = spawnSync(cmd, args, {
    cwd: path.resolve(ROOT, cwd),
    stdio: "inherit",
    env: process.env,
  });
  if (r.error) {
    console.error(`✗ 无法启动:${r.error.message}`);
    return 127;
  }
  if (r.signal) {
    console.error(`✗ 被信号终止:${r.signal}`);
    return 1;
  }
  return r.status ?? 1;
}

const GATES = {
  typecheck: {
    desc: "TypeScript 严格类型检查(tsc --noEmit)",
    run: () => step(NODE, [BIN.tsc, "--noEmit"]),
  },
  lint: {
    desc: "ESLint(flat config,与 package.json 同 glob)",
    run: () => step(NODE, [BIN.eslint, "src/**/*.{ts,tsx}"]),
  },
  test: {
    desc: "vitest run(单元 + 组件冒烟)",
    run: () => step(NODE, [BIN.vitest, "run"]),
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
    desc: "全套闸门:typecheck → lint → test → build",
    run: () => {
      for (const g of ["typecheck", "lint", "test", "build"]) {
        const code = GATES[g].run();
        if (code !== 0) {
          console.error(`\n✗ 闸门 "${g}" 失败(exit ${code}),后续闸门不再执行。`);
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
  "rust-test": {
    desc: "cargo test",
    run: () => step(CARGO, ["test"], "src-tauri"),
  },
  "rust-clippy": {
    desc: "cargo clippy --all-targets(按 Cargo.toml [lints.clippy] pedantic)",
    run: () => step(CARGO, ["clippy", "--all-targets"], "src-tauri"),
  },
};

const which = process.argv[2];

if (!which || !GATES[which]) {
  console.log("用法: node scripts/gate.mjs <gate>\n");
  console.log("可用闸门:");
  for (const [name, g] of Object.entries(GATES)) {
    console.log(`  ${name.padEnd(12)} ${g.desc}`);
  }
  console.log(`\n项目根: ${ROOT}`);
  console.log(`cargo:  ${CARGO}`);
  process.exit(which ? 2 : 0);
}

console.log(`▸ gate: ${which} — ${GATES[which].desc}`);
const code = GATES[which].run();
console.log(
  code === 0 ? `\n✓ gate "${which}" 通过` : `\n✗ gate "${which}" 失败 (exit ${code})`,
);
process.exit(code);
