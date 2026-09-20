import { useState } from "react";
import { Save } from "lucide-react";
import { TemplateEditor } from "./TemplateEditor";
import { SseRuleBuilder } from "./SseRuleBuilder";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { ApiTemplate, AdapterMode } from "@/types";

interface Props {
  initial?: Partial<ApiTemplate>;
  onSave: (template: Partial<ApiTemplate>) => void;
  onCancel: () => void;
}

export function AdapterForm({ initial, onSave, onCancel }: Props) {
  // Escape 关闭(此前只有底部取消按钮)
  useEscapeClose(onCancel);
  const [mode, setMode] = useState<AdapterMode>(initial?.mode || "simple");
  const [name, setName] = useState(initial?.name || "");
  const [apiUrl, setApiUrl] = useState(initial?.api_url || "");
  const [apiKey, setApiKey] = useState(initial?.api_key_encrypted || "");
  const [model, setModel] = useState("");

  const [bodyTemplate, setBodyTemplate] = useState(
    initial?.request_body_template ||
      '{\n  "model": "{{model}}",\n  "messages": {{messages}},\n  "temperature": {{temperature}},\n  "stream": true\n}'
  );
  const [headersJson, setHeadersJson] = useState(
    JSON.stringify(initial?.request_headers || { "Content-Type": "application/json" }, null, 2)
  );
  const [ssePrefix, setSsePrefix] = useState(initial?.sse_data_prefix || "data: ");
  const [sseDone, setSseDone] = useState(initial?.sse_done_marker || "[DONE]");
  const [ssePath, setSsePath] = useState(initial?.sse_content_path || "$.choices[0].delta.content");

  const handleSave = () => {
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(headersJson);
    } catch {
      headers = { "Content-Type": "application/json" };
    }
    onSave({
      name,
      mode,
      api_url: apiUrl,
      api_key_encrypted: apiKey,
      request_method: "POST",
      request_headers: headers,
      request_body_template: bodyTemplate,
      sse_enabled: true,
      sse_data_prefix: ssePrefix,
      sse_done_marker: sseDone,
      sse_content_path: ssePath,
      response_content_path: "",
      category: "",
      is_preset: false,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-lg w-[720px] max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold">
            API Adapter - {mode === "simple" ? "Simple" : mode === "medium" ? "Advanced" : "Script"}
          </h2>
          <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
            {(["simple", "medium", "advanced"] as AdapterMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 text-xs rounded ${mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My API"
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">API Base URL</label>
              <input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="https://api.openai.com"
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">Model</label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4"
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
          </div>
          <hr className="border-border" />

          {mode === "simple" && (
            <p className="text-xs text-muted-foreground p-4 bg-primary/5 border border-primary/20 rounded-md">
              Automatically constructs OpenAI-compatible requests via{" "}
              <code className="px-1 bg-muted rounded">/v1/chat/completions</code>.
            </p>
          )}

          {mode === "medium" && (
            <>
              <label className="text-xs font-medium block mb-1">Request Body Template</label>
              <TemplateEditor template={bodyTemplate} onChange={setBodyTemplate} />
              <label className="text-xs font-medium block mb-1">Custom Headers (JSON)</label>
              <textarea
                value={headersJson}
                onChange={(e) => setHeadersJson(e.target.value)}
                rows={4}
                spellCheck={false}
                className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-md resize-none"
              />
              <label className="text-xs font-medium block mb-1">SSE Parsing Rules</label>
              <SseRuleBuilder
                dataPrefix={ssePrefix}
                doneMarker={sseDone}
                contentPath={ssePath}
                onPrefixChange={setSsePrefix}
                onDoneChange={setSseDone}
                onPathChange={setSsePath}
              />
            </>
          )}

          {mode === "advanced" && (
            <>
              <label className="text-xs font-medium block mb-1">SSE Rules (fallback)</label>
              <SseRuleBuilder
                dataPrefix={ssePrefix}
                doneMarker={sseDone}
                contentPath={ssePath}
                onPrefixChange={setSsePrefix}
                onDoneChange={setSseDone}
                onPathChange={setSsePath}
              />
            </>
          )}
        </div>

        <div className="flex justify-between px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-xs rounded border border-input hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1"
          >
            <Save className="w-3 h-3" /> Save Template
          </button>
        </div>
      </div>
    </div>
  );
}
