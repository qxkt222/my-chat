// 吸顶头验证器：真读产物（PanelHeader 与三个面板源码）并断言行为型特征。
// 为什么不用 vitest 当判据：负对照证明「跑一个无关测试文件」会被字面壳满足（判据空转）。
// 这里断言的是**本步产物的真实内容**：吸顶类名、返回按钮、三个面板都接入。
import { readFileSync, existsSync } from "node:fs";
const R = "D:/1233344/my-chat/src/components/";
const red = [];

const ph = R + "settings/PanelHeader.tsx";
if (!existsSync(ph)) {
  red.push("PanelHeader.tsx 不存在");
} else {
  const t = readFileSync(ph, "utf8");
  if (!/sticky\s+top-0/.test(t)) red.push("PanelHeader 缺少 sticky top-0（吸顶未实现）");
  if (!/bg-card/.test(t)) red.push("PanelHeader 缺少不透明底色（滚动会透出内容）");
  if (!/z-10/.test(t)) red.push("PanelHeader 缺少 z-10（不能压在内容之上）");
  if (!/-mx-4/.test(t)) red.push("PanelHeader 缺少负外边距（吸顶后两侧留白不一致）");
  if (!/preset\.back/.test(t)) red.push("PanelHeader 没有返回按钮");
}

// 三个面板必须都接入共用头（避免三处各写一份 sticky 而漂移）
const panels = [
  ["settings/PresetManager.tsx", "预设"],
  ["characters/LorebookManager.tsx", "世界书"],
  ["settings/RegexManager.tsx", "样式"],
];
for (const [f, name] of panels) {
  const p = R + f;
  if (!existsSync(p)) { red.push(name + " 面板文件不存在: " + f); continue; }
  const t = readFileSync(p, "utf8");
  if (!/PanelHeader/.test(t)) red.push(name + " 面板未接入 PanelHeader");
  if (!/onBack/.test(t)) red.push(name + " 面板未提供 onBack（返回不可用）");
}

// SettingsDialog 必须把 onBack 传给这两个新面板，且语义是切 tab 而不是关窗
const sd = readFileSync(R + "settings/SettingsDialog.tsx", "utf8");
if (!/LorebookManager\s+onBack=/.test(sd)) red.push("SettingsDialog 未给 LorebookManager 传 onBack");
if (!/RegexManager\s+onBack=/.test(sd)) red.push("SettingsDialog 未给 RegexManager 传 onBack");
if (!/setTab\(homeTab\)/.test(sd)) red.push("返回未接到 setTab(homeTab)（可能又变成关弹窗）");

// 弹窗尺寸不许动（开发者明确要求「不改动」）
if (!/max-h-\[80vh\]/.test(sd)) red.push("SettingsDialog 的 max-h 被改动了（要求尺寸不变）");

if (red.length) { console.log("STICKY_VERDICT=RED"); red.forEach((r) => console.log("  · " + r)); process.exit(1); }
console.log("STICKY_VERDICT=GREEN 吸顶头与三面板返回均已接入，弹窗尺寸未动");