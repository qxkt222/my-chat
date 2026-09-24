import { useState } from "react";
import { X, Plus, Upload, Download } from "lucide-react";
import { useAdapterStore } from "@/stores/useAdapterStore";
import { BUILTIN_PRESETS } from "@/adapters/registry";
import { AdapterForm } from "./AdapterForm";
import { useT } from "@/lib/i18n";
import { askPrompt } from "@/components/ui/ConfirmDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 嵌入模式（Q3）：作为设置页的 tab 内嵌渲染，去掉 fixed 遮罩，避免黑幕叠黑幕 */
  embedded?: boolean;
}

export function AdapterConfigDialog({ open, onClose, embedded }: Props) {
  const t = useT();
  const { templates, create, remove, exportTemplate, importTemplate } = useAdapterStore();
  const [showForm, setShowForm] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  if (!open) return null;

  if (showForm)
    return (
      <AdapterForm
        onSave={async (data) => {
          await create({
            name: data.name || "Custom",
            mode: data.mode || "simple",
            api_url: data.api_url || "",
            request_method: data.request_method || "POST",
            request_headers: data.request_headers || {},
            request_body_template: data.request_body_template || "",
            sse_enabled: data.sse_enabled ?? true,
            sse_data_prefix: data.sse_data_prefix || "data: ",
            sse_done_marker: data.sse_done_marker || "[DONE]",
            sse_content_path: data.sse_content_path || "",
            response_content_path: data.response_content_path || "",
            category: "",
            is_preset: false,
          });
          setShowForm(false);
        }}
        onCancel={() => setShowForm(false)}
      />
    );

  const presetList = (
    <div>
      <button
        onClick={() => setShowPresets(!showPresets)}
        className="text-xs text-primary hover:underline"
      >
        {showPresets ? "Hide" : "Show"} {t("adapter.presets")} ({BUILTIN_PRESETS.length})
      </button>
      {showPresets && (
        <div className="grid gap-2 mt-2">
          {BUILTIN_PRESETS.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between px-3 py-2 border border-border rounded-md bg-muted/30"
            >
              <span className="text-xs font-medium">{p.name}</span>
              <button
                onClick={async () => {
                  await create({
                    name: p.name,
                    mode: p.mode,
                    api_url: p.api_url,
                    request_method: p.request_method,
                    request_headers: p.request_headers,
                    request_body_template: p.request_body_template,
                    sse_enabled: p.sse_enabled,
                    sse_data_prefix: p.sse_data_prefix,
                    sse_done_marker: p.sse_done_marker,
                    sse_content_path: p.sse_content_path,
                    response_content_path: p.response_content_path,
                    category: p.category,
                    is_preset: false,
                  });
                }}
                className="px-2 py-0.5 text-[10px] bg-primary/20 text-primary rounded hover:bg-primary/30"
              >
                Add
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const templateList = (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
        {t("adapter.templates")} ({templates.length})
      </h3>
      {templates.map((tpl) => (
        <div
          key={tpl.id}
          className="flex items-center justify-between px-3 py-2 border border-border rounded-md text-xs mb-1"
        >
          <span className="font-medium">{tpl.name}</span>
          <div className="flex gap-1">
            <button
              onClick={() => {
                const j = exportTemplate(tpl.id);
                if (j) navigator.clipboard.writeText(j);
              }}
              className="px-2 py-0.5 rounded hover:bg-muted text-muted-foreground"
            >
              <Download className="w-3 h-3" />
            </button>
            <button
              onClick={() => remove(tpl.id)}
              className="px-2 py-0.5 rounded hover:bg-destructive/20 text-destructive"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  // 内嵌模式（Q3）：只渲染内容区，外层 SettingsDialog 提供滚动容器
  if (embedded) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowForm(true)}
            className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> {t("adapter.create")}
          </button>
          <button
            onClick={() =>
              void (async () => {
                const raw = await askPrompt("Paste JSON:");
                if (raw !== null) importTemplate(raw);
              })()
            }
            className="px-3 py-1 text-xs border border-input rounded hover:bg-muted flex items-center gap-1"
          >
            <Upload className="w-3 h-3" /> {t("adapter.import")}
          </button>
        </div>
        {presetList}
        {templateList}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg w-[650px] max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold">{t("adapter.title")}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowForm(true)}
              className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> {t("adapter.create")}
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-muted">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <button
            onClick={() =>
              void (async () => {
                const raw = await askPrompt("Paste JSON:");
                if (raw !== null) importTemplate(raw);
              })()
            }
            className="px-3 py-1 text-xs border border-input rounded hover:bg-muted flex items-center gap-1"
          >
            <Upload className="w-3 h-3" /> {t("adapter.import")}
          </button>
          {presetList}
          {templateList}
        </div>
      </div>
    </div>
  );
}
