import { useState } from "react";
import { Variable, Eye, Code } from "lucide-react";

interface Props {
  template: string;
  onChange: (template: string) => void;
}

const BUILTIN_VARIABLES = [
  { key: "{{model}}", desc: "Model name" },
  { key: "{{messages}}", desc: "Chat messages array" },
  { key: "{{temperature}}", desc: "Temperature value" },
  { key: "{{api_key}}", desc: "API Key" },
  { key: "{{system_prompt}}", desc: "System prompt text" },
  { key: "{{knowledge_context}}", desc: "Knowledge base content" },
  { key: "{{max_tokens}}", desc: "Max tokens" },
];

export function TemplateEditor({ template, onChange }: Props) {
  const [preview, setPreview] = useState(false);

  const insertVariable = (v: string) => {
    const ta = document.getElementById("template-editor") as HTMLTextAreaElement;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const newVal = template.slice(0, start) + v + template.slice(end);
    onChange(newVal);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + v.length, start + v.length);
    }, 0);
  };

  const formatJson = () => {
    try {
      const obj = JSON.parse(template);
      onChange(JSON.stringify(obj, null, 2));
    } catch {
      // Not valid JSON, ignore
    }
  };

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Variables:</span>
        {BUILTIN_VARIABLES.map((v) => (
          <button
            key={v.key}
            onClick={() => insertVariable(v.key)}
            title={v.desc}
            className="px-2 py-0.5 text-[10px] bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors flex items-center gap-1"
          >
            <Variable className="w-3 h-3" />
            {v.key}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={formatJson}
          className="px-2 py-0.5 text-[10px] border border-border rounded hover:bg-muted text-muted-foreground flex items-center gap-1"
        >
          <Code className="w-3 h-3" /> Format JSON
        </button>
        <button
          onClick={() => setPreview(!preview)}
          className={`px-2 py-0.5 text-[10px] rounded flex items-center gap-1 ${
            preview
              ? "bg-primary/10 text-primary"
              : "border border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          <Eye className="w-3 h-3" /> {preview ? "Edit" : "Preview"}
        </button>
      </div>

      {/* Editor */}
      {preview ? (
        <pre className="p-3 bg-muted/50 border border-border rounded-md text-xs font-mono overflow-auto max-h-64 whitespace-pre-wrap">
          {renderPreview(template)}
        </pre>
      ) : (
        <textarea
          id="template-editor"
          value={template}
          onChange={(e) => onChange(e.target.value)}
          rows={12}
          spellCheck={false}
          className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder='{"model": "{{model}}", "messages": {{messages}}, "stream": true}'
        />
      )}

      {/* Preview with highlights */}
      <div className="text-[10px] text-muted-foreground">
        Tip: Use <code className="px-1 bg-muted rounded">&#123;&#123;variable&#125;&#125;</code> for
        dynamic values.
        <code className="px-1 bg-muted rounded ml-1">&#123;&#123;messages&#125;&#125;</code> inserts
        the full message array.
      </div>
    </div>
  );
}

function renderPreview(template: string): string {
  // Replace variables with example values for preview
  return template
    .replace(/\{\{model\}\}/g, '"gpt-4"')
    .replace(/\{\{temperature\}\}/g, "0.7")
    .replace(/\{\{api_key\}\}/g, '"sk-..."')
    .replace(/\{\{system_prompt\}\}/g, '"You are helpful."')
    .replace(/\{\{knowledge_context\}\}/g, '"...docs..."')
    .replace(/\{\{max_tokens\}\}/g, "2048")
    .replace(/\{\{messages\}\}/g, '[{"role":"user","content":"Hello"}]');
}
