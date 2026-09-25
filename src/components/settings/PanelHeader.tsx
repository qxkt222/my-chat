import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useT } from "@/lib/i18n";

/** 设置面板的统一**吸顶**头（2026-09-25）
 *
 *  开发者反馈（原话）：「就单单样式这个功能我用后就发现由于导入了很多东西导致
 *  上面那些排序被一起挤走了……就想在不改动（弹窗大小）情况下加入返回功能，
 *  就像预设那样处理」。
 *
 *  问题本质：SettingsDialog 的内容区是**唯一的滚动容器**（`flex-1 overflow-y-auto`），
 *  面板标题行与「返回/新建/导入」按钮都在它里面 —— 条目一多就随内容滚出视口，
 *  用户既找不到返回键，也看不到列表顶部的按钮。
 *
 *  解法：把标题行做成 `sticky top-0` + 不透明底色 + 负外边距对齐。
 *  **弹窗尺寸一点不改**，只是把这一行钉在滚动区顶部。
 *
 *  三个容易踩的点（都在这里一次性处理掉）：
 *    · 必须给**不透明**底色，否则滚动时内容会从标题底下透出来
 *    · 需要负外边距抵消父级的 p-4，否则吸顶后两侧留白与内容不一致
 *    · z-10 保证压在内容之上 */
export function PanelHeader({
  icon,
  title,
  subtitle,
  right,
  onBack,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string | undefined;
  right?: ReactNode | undefined;
  onBack?: (() => void) | undefined;
}) {
  const t = useT();
  return (
    <div className="sticky top-0 z-10 -mx-4 -mt-4 px-4 pt-4 pb-2 bg-card border-b border-border flex items-center gap-1.5 flex-wrap">
      {/* 返回：常驻在吸顶行里，长列表滚动时不会被挤走 */}
      {onBack && (
        <button
          onClick={onBack}
          className="px-2 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1 whitespace-nowrap"
          title={t("preset.back")}
        >
          <ArrowLeft className="w-3 h-3" /> {t("preset.back")}
        </button>
      )}
      {icon}
      <span className="text-sm font-semibold whitespace-nowrap">{title}</span>
      {subtitle && (
        <span className="text-[10px] text-muted-foreground truncate hidden sm:inline">
          {subtitle}
        </span>
      )}
      <div className="flex-1 min-w-0" />
      {right}
    </div>
  );
}
