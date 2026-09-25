import { readFileSync, readdirSync, existsSync } from "node:fs";
const DIR = `${process.env.APPDATA}/com.my-chat/presets`;
const which = process.argv[2] ?? "all";
if (!existsSync(DIR)) {
  console.log("VERDICT=RED 原因=预设目录不存在:" + DIR);
  process.exit(1);
}
const imported = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
  try {
    const o = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
    if (typeof o.id === "string" && o.id.startsWith("imp-")) imported.push(o);
  } catch {}
}
const withGroup = imported.filter((o) => typeof o.group === "string" && o.group.length > 0);
const withOrder = imported.filter((o) => Number.isFinite(o.order));
const withEnabledKey = imported.filter((o) => typeof o.enabled === "boolean");
const enabledTrue = imported.filter((o) => o.enabled === true);
const combo = imported.find((o) => o.name.includes("默认组合"));
const rosters = readdirSync(DIR).filter((x) => x.startsWith("roster-"));
const fresh = imported.filter(
  (o) =>
    typeof o.description === "string" &&
    o.description.includes("（") &&
    o.description.includes("）")
);
// 排序是否真的生效：同一包内 order 必须互不相同（否则拼装顺序不确定）
const orders = withOrder.map((o) => o.order);
const uniqueOrders = new Set(orders).size === orders.length;
console.log("IMPORTED=" + imported.length);
console.log("WITH_GROUP=" + withGroup.length);
console.log("WITH_ORDER=" + withOrder.length);
console.log("WITH_ENABLED_KEY=" + withEnabledKey.length);
console.log("ENABLED_TRUE=" + enabledTrue.length);
console.log("FRESH_IMPORTED=" + fresh.length);
console.log("ORDERS_UNIQUE=" + uniqueOrders);
console.log(
  "COMBO_ROW=" +
    (combo
      ? combo.name + " enabled=" + String(combo.enabled) + " order=" + String(combo.order)
      : "(未找到)")
);
console.log("ROSTER_STATE_FILES=" + rosters.length);
const red = [];
if (which === "roster" || which === "all") {
  if (withGroup.length !== imported.length)
    red.push("group 未全覆盖：" + withGroup.length + "/" + imported.length);
  if (withOrder.length !== imported.length)
    red.push("order 未全覆盖：" + withOrder.length + "/" + imported.length);
  if (!uniqueOrders) red.push("order 有重复 —— 拼装顺序不确定，会破坏缓存前缀稳定性");
  if (rosters.length === 0) red.push("没有 roster 全局状态文件（排序/开关还没落盘）");
}
if (which === "import" || which === "all") {
  if (withEnabledKey.length !== imported.length)
    red.push("enabled 键未全覆盖：" + withEnabledKey.length + "/" + imported.length);
  if (combo && combo.enabled !== false)
    red.push("「默认组合」必须是 false，实测 " + String(combo.enabled));
  // 以下两条只对**新导入**成立：旧数据当年导入时丢了启用标记，且 order 是按 created_at 补的
  if (fresh.length > 0) {
    if (enabledTrue.length === 0)
      red.push("有新导入条目却仍无 enabled=true —— 没读到酒馆自带的启用标记");
    if (combo && !(Number.isFinite(combo.order) && combo.order < 0))
      red.push("新导入时「默认组合」应排在包首(order<0)，实测 " + String(combo.order));
  }
}
if (red.length) {
  console.log("VERDICT=RED");
  red.forEach((r) => console.log("  · " + r));
  process.exit(1);
}
console.log("VERDICT=GREEN");
