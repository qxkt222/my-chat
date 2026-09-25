// 吸顶探针：在真浏览器里挂载 SettingsDialog（样式页/世界书页），造长列表并滚到底，
// 量标题行与「返回」按钮相对视口的位置 —— 判断吸顶是否真的生效。
//
// 为什么必须真浏览器：jsdom 元素高度恒为 0、不做排版，`position: sticky` 完全不生效，
// 它永远量不出「被挤走」这种问题。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useCharacterStore } from "@/stores/useCharacterStore";
import type { RegexRule } from "@/lib/regex-format";
import "/styles/globals.css";

const params = new URLSearchParams(location.search);
const N = Number(params.get("n") || 60);

// 造 N 条正则规则（模拟导入 25 条 + 手建一堆之后的「挤走」场景）
const rules: RegexRule[] = Array.from({ length: N }, (_, i) => ({
  id: `r-${i}`,
  name: `规则${i}`,
  pattern: `pat${i}`,
  replacement: "",
  enabled: true,
  flags: "g",
  placement: [1],
}));
useSettingsStore.setState({ regexRules: rules });

// 世界书也造厚一点
useCharacterStore.setState({
  globalLorebook: {
    name: "主世界书",
    entries: Array.from({ length: 40 }, (_, i) => ({
      keys: [`k${i}`],
      content: `条目内容 ${i} `.repeat(6),
      enabled: true,
    })),
  },
});

useAppModeStore.setState({ mode: "tavern", tavernSubMode: "rp" });

const root = document.getElementById("probe-root");
if (!root) throw new Error("探针缺少 #probe-root");
createRoot(root).render(
  <StrictMode>
    <SettingsDialog open onClose={() => {}} />
  </StrictMode>
);

function out(s: string) {
  const el = document.getElementById("probe-out");
  if (el) el.textContent = s;
}

function findBtn(text: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll("button"));
  return (all.find((b) => (b.textContent || "").trim() === text) as HTMLElement) ?? null;
}

function report(stage: string): string[] {
  const lines: string[] = [];
  const scroller = document.querySelector(".overflow-y-auto") as HTMLElement | null;
  const back = findBtn("返回");
  const title = Array.from(document.querySelectorAll("span")).find((s) =>
    ["样式", "世界书", "提示词预设"].includes((s.textContent || "").trim())
  ) as HTMLElement | undefined;

  lines.push(`=== ${stage} ===`);
  if (scroller) {
    lines.push(
      `滚动容器 top=${Math.round(scroller.getBoundingClientRect().top)} clientH=${scroller.clientHeight} ` +
        `scrollTop=${Math.round(scroller.scrollTop)} scrollH=${scroller.scrollHeight}`
    );
    scroller.scrollTop = scroller.scrollHeight; // 滚到底
    lines.push(`  → 已滚到底 scrollTop=${Math.round(scroller.scrollTop)}`);
  } else {
    lines.push("滚动容器: NOT_FOUND");
  }

  const mt = (el: HTMLElement | null | undefined, label: string) => {
    if (!el) return `${label}: NOT_FOUND`;
    const r = el.getBoundingClientRect();
    return `${label}: top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} 可见=${r.bottom > 0 && r.top < window.innerHeight}`;
  };
  lines.push(mt(back, "「返回」按钮"));
  lines.push(mt(title, "面板标题"));
  return lines;
}

setTimeout(() => {
  // 进设置 → 样式页
  const tabBtn = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === "样式"
  ) as HTMLElement | undefined;
  tabBtn?.click();

  setTimeout(() => {
    const l1 = report("样式页 · 滚到底之后");
    const l2 = ["", "（对照：吸顶头若失效，上面 top 会是负值、可见=false）"];
    const scroller = document.querySelector(".overflow-y-auto") as HTMLElement | null;
    if (scroller) scroller.scrollTop = 0;
    setTimeout(() => {
      const l3 = report("样式页 · 回到顶部之后");
      out([...l1, ...l2, "", ...l3, "", "STICKY_PROBE_READY=true"].join("\n"));
    }, 300);
  }, 700);
}, 800);
