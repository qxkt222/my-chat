// 布局探针：在真实浏览器里挂载 SettingsDialog，量「展开预设后逃生按钮还在不在可视区」。
//
// 这是对 jsdom 结构测试的补充 —— jsdom 元素高度恒为 0，量不到像素。
// 探针把几何读数写进 #probe-out（纯文本），再用 web_dom 回读。
//
// 用法：vite dev 起服务后打开 /probe/settings-dialog-probe.html

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useAppModeStore } from "@/stores/useAppModeStore";
import type { PromptPreset } from "@/types";
// vite 的 root 是 src/，所以这里用绝对路径（写成相对路径会解析失败）
import "/styles/globals.css";

const N = Number(new URLSearchParams(location.search).get("n") || 8);

function mkPreset(i: number, big: boolean): PromptPreset {
  return {
    id: `p-${i}`,
    name: `预设${i}`,
    is_preset: true,
    description: `描述${i}`,
    // big = 模拟导入 Freaky 那种超长模板，用来放大展开区高度
    template: big ? "模板内容 ".repeat(4000) : `模板内容 ${i}`,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

const presets: PromptPreset[] = Array.from({ length: N }, (_, i) => mkPreset(i, i === N - 1));
// 造两组导入包 + 两条未分组，用来验证「按包分区」真的分区了（含包内 order 排序：
// 故意把 order 写成 2,0,1，看 UI 是否按 order 而不是按数组顺序渲染）
const groupped: PromptPreset[] = [
  ...["包A", "包B"].flatMap((g) =>
    [2, 0, 1].map((ord, k) => ({
      ...mkPreset(k, false),
      id: `g-${g}-${k}`,
      name: `${g}条目${k}`,
      description: `order=${ord}`,
      group: g,
      order: ord,
    }))
  ),
  ...presets.slice(0, 2), // 这两条没有 group → 应落到「未分组」
];
useCharacterStore.setState({ presets: groupped });
useAppModeStore.setState({ mode: "tavern", tavernSubMode: "rp" });

const root = document.getElementById("probe-root");
if (!root) throw new Error("探针缺少 #probe-root 挂载点");

createRoot(root).render(
  <StrictMode>
    <SettingsDialog open onClose={() => {}} />
  </StrictMode>
);

/** 量一个元素相对视口的可见性 */
function measure(el: Element | null, label: string): string {
  if (!el) return `${label}: NOT_FOUND`;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const visibleTop = Math.max(r.top, 0);
  const visibleBottom = Math.min(r.bottom, vh);
  const visibleH = Math.max(0, visibleBottom - visibleTop);
  const fully = r.top >= 0 && r.bottom <= vh;
  return (
    `${label}: top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} h=${Math.round(r.height)} ` +
    `visibleH=${Math.round(visibleH)} fullyVisible=${fully}`
  );
}

function byText(text: string): Element | null {
  const all = Array.from(document.querySelectorAll("button"));
  return all.find((b) => (b.textContent || "").trim() === text) || null;
}

function report(stage: string) {
  const lines: string[] = [];
  lines.push(`=== ${stage} (viewport ${window.innerWidth}x${window.innerHeight}) ===`);

  // 先把弹窗本体定位出来：后续所有查询都在它内部，避免抓到文档里弹窗外的同名按钮
  const h2 = Array.from(document.querySelectorAll("h2")).find((h) =>
    (h.textContent || "").includes("设置")
  );
  const modal = h2?.parentElement?.parentElement ?? null;
  if (!modal) {
    lines.push("弹窗: NOT_FOUND");
    const out0 = document.getElementById("probe-out");
    if (out0) out0.textContent = lines.join("\n");
    return;
  }
  const inModal = (sel: string) => Array.from(modal.querySelectorAll(sel));
  const btnByText = (text: string) =>
    inModal("button").filter((b) => (b.textContent || "").trim() === text);

  lines.push(
    `弹窗内的「取消」按钮数=${btnByText("取消").length}（>1 说明展开区的收起按钮也渲染了）`
  );
  btnByText("取消").forEach((b, i) => lines.push(measure(b, `  弹窗内取消[${i}]`)));
  btnByText("保存").forEach((b, i) => lines.push(measure(b, `  弹窗内保存[${i}]`)));

  const xBtn = h2?.parentElement?.querySelector("button") ?? null;
  lines.push(measure(xBtn, "右上角X按钮"));

  const scroller = modal.querySelector(".overflow-y-auto");
  if (scroller) {
    const cs = getComputedStyle(scroller as HTMLElement);
    lines.push(
      `滚动容器: clientH=${scroller.clientHeight} scrollH=${scroller.scrollHeight} ` +
        `可滚动=${scroller.scrollHeight > scroller.clientHeight} minH=${cs.minHeight}`
    );
  } else {
    lines.push("滚动容器: NOT_FOUND");
  }

  const ta = modal.querySelector("textarea.font-mono");
  lines.push(ta ? "展开区 textarea: 存在" : "展开区 textarea: 不存在");

  lines.push(
    `当前页: ${document.body.textContent?.includes("提示词预设") ? "预设页" : "非预设页"}`
  );

  const out = document.getElementById("probe-out");
  if (out) out.textContent = lines.join("\n");
}

function clickByText(text: string): boolean {
  const el = byText(text);
  if (el) {
    (el as HTMLElement).click();
    return true;
  }
  return false;
}

setTimeout(() => {
  // 先切到「预设」标签 —— 探针默认落在「角色」页，不切就量错页面
  const switched = clickByText("预设");
  console.log("[probe] 切到预设页:", switched);

  setTimeout(() => {
    report("预设页·未展开");

    const eyes = Array.from(document.querySelectorAll('button[title="查看/编辑条目"]'));
    console.log("[probe] 可见的查看按钮数:", eyes.length);
    const target = eyes[eyes.length - 1];
    if (target) (target as HTMLElement).click();

    setTimeout(() => {
      report("预设页·展开最后一条（超长模板）之后");
      const out = document.getElementById("probe-out");
      if (out) out.textContent += "\n\nPROBE_READY=true";
    }, 500);
  }, 500);
}, 700);
