import { useState } from "react";
import { Plus, Folder, FileText, Trash2, Save, Search, Upload, BadgeCheck, Sparkles } from "lucide-react";
import { useKnowledgeStore } from "@/stores/useKnowledgeStore";
import { useT } from "@/lib/i18n";
import {
  ragSearch,
  ragIndexDocument,
  ragIndexWithOpenai,
  ragDeleteKb,
  pickFile,
  extractDocumentText,
  ocrImage,
  logDiag,
} from "@/lib/tauri";
import { showToast } from "@/components/ui/Toast";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { askConfirm } from "@/components/ui/ConfirmDialog";

const DOC_EXT = ["pdf", "docx", "txt", "md"];
const IMG_EXT = ["png", "jpg", "jpeg", "webp", "bmp"];

export function KnowledgeManager() {
  const t = useT();
  const kb = useKnowledgeStore();
  const [newBase, setNewBase] = useState("");
  const [newFile, setNewFile] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [indexing, setIndexing] = useState(false);
  const [indexed, setIndexed] = useState<Record<string, number>>({});
  // Retrieval test panel
  const [testQuery, setTestQuery] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);

  const createBase = async () => {
    if (!newBase.trim()) return;
    await kb.createBase(newBase.trim(), "");
    setNewBase("");
  };
  const selectBase = (id: string) => {
    kb.setActive(id);
    kb.loadFiles(id);
    setEditing(null);
  };

  const indexFile = async (name: string) => {
    const f = kb.files.find((x) => x.name === name);
    if (!f || !kb.activeBaseId) return;
    setIndexing(true);
    try {
      const count = await ragIndexDocument(kb.activeBaseId, name, f.content);
      setIndexed((s) => ({ ...s, [name]: count }));
    } catch {
      /* ignore */
    }
    setIndexing(false);
  };

  const createFile = async () => {
    if (!kb.activeBaseId || !newFile.trim()) return;
    await kb.saveFile(kb.activeBaseId, newFile.trim(), "");
    setNewFile("");
    kb.loadFiles(kb.activeBaseId);
    indexFile(newFile.trim());
  };

  // 导入真实文档：原生文件选择 → 文本提取（pdf/docx）或 OCR（图片）→ 存库并索引
  const importDocument = async () => {
    if (!kb.activeBaseId) {
      showToast("info", t("kb.needSelect"));
      return;
    }
    const path = await pickFile("文档/图片", [...DOC_EXT, ...IMG_EXT]);
    if (!path) return;
    const name = path.split(/[\\/]/).pop() || "imported";
    const ext = name.split(".").pop()?.toLowerCase() || "";
    setIndexing(true);
    try {
      let text = "";
      try {
        text = await extractDocumentText(path);
      } catch (e) {
        // 文本提取失败且是图片 → 尝试 OCR；否则报错
        if (IMG_EXT.includes(ext)) {
          text = await ocrImage(path);
        } else {
          setIndexing(false);
          showToast("error", String(e));
          return;
        }
      }
      if (!text.trim()) {
        setIndexing(false);
        showToast("error", t("kb.noText"));
        return;
      }
      await kb.saveFile(kb.activeBaseId, name, text);
      await kb.loadFiles(kb.activeBaseId);
      const count = await ragIndexDocument(kb.activeBaseId, name, text);
      setIndexed((s) => ({ ...s, [name]: count }));
      showToast("success", t("kb.imported", { name, count }));
    } catch (e) {
      showToast("error", `${t("kb.importFail")}${e}`);
    }
    setIndexing(false);
  };

  const editFile = (name: string) => {
    const f = kb.files.find((x) => x.name === name);
    if (f) {
      setEditing(name);
      setContent(f.content);
    }
  };

  const saveEdit = async () => {
    if (!kb.activeBaseId || !editing) return;
    await kb.saveFile(kb.activeBaseId, editing, content);
    setEditing(null);
    kb.loadFiles(kb.activeBaseId);
    indexFile(editing);
  };

  const runTest = async () => {
    if (!kb.activeBaseId || !testQuery.trim() || testing) return;
    setTesting(true);
    try {
      // 结构化检索:返回候选片段数组(来源卡可查原文)
      const results = await ragSearch(testQuery, { kbId: kb.activeBaseId, topK: 3 });
      setTestResult(
        results.length === 0
          ? t("kb.noHit")
          : results
              .map(
                (r, i) =>
                  `[${i + 1}] ${r.file_name} (relevance ${Math.round(r.score * 100)}%)\n${r.content}`
              )
              .join("\n\n---\n\n")
      );
    } catch (e) {
      setTestResult(String(e));
    }
    setTesting(false);
  };

  // OpenAI 嵌入重建索引:把当前库全部文件用 OpenAI 嵌入重新索引(接线闲置的
  // rag_index_with_openai;本地 keyword 嵌入检索不到的语义可借此提升)
  const reindexWithOpenai = async () => {
    if (!kb.activeBaseId || indexing) return;
    if (!(await askConfirm("用 OpenAI 嵌入重建当前知识库索引?会覆盖本地嵌入,需消耗 API 额度。")))
      return;
    const settings = useSettingsStore.getState();
    const model = settings.models.find((m) => m.name === settings.activeModel);
    if (!model) {
      showToast("error", "请先在设置 → 模型 中激活一个模型(用于提供嵌入 API Key)");
      return;
    }
    setIndexing(true);
    const bid = kb.activeBaseId;
    let ok = 0;
    try {
      for (const f of kb.files) {
        try {
          await ragIndexWithOpenai(bid, f.name, f.content, model.api_key);
          ok++;
        } catch {
          /* 单文件失败跳过 */
        }
      }
      if (ok > 0) showToast("success", `已用 OpenAI 嵌入重建 ${ok} 个文件`);
      else showToast("error", "重建失败:请检查模型 API Key 与网络");
    } finally {
      setIndexing(false);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-4 h-full">
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase">{t("kb.title")}</h3>
        <div className="flex gap-1">
          <input
            placeholder={t("kb.new")}
            value={newBase}
            onChange={(e) => setNewBase(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createBase()}
            className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded"
          />
          <button
            onClick={createBase}
            className="p-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        {kb.bases.map((b) => (
          <div
            key={b.id}
            onClick={() => selectBase(b.id)}
            className={`flex items-center justify-between px-2 py-1.5 rounded text-xs cursor-pointer ${kb.activeBaseId === b.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <Folder className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{b.name}</span>
              {/* 知识源认证/新鲜度徽标:已验证的来源在答案引用中优先 */}
              {b.meta?.verified && (
                <span
                  className="text-[9px] px-1 py-px rounded-full bg-emerald-500/15 text-emerald-500 shrink-0"
                  title={t("kb.verifiedHint")}
                >
                  ✓ {t("kb.verified")}
                </span>
              )}
              {b.meta?.source_type && !b.meta.verified && (
                <span className="text-[9px] px-1 py-px rounded-full bg-primary/10 text-primary shrink-0">
                  {b.meta.source_type}
                </span>
              )}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                // 点击切换「已验证」标记(信任信号:答案引用优先带徽标来源)
                kb.setKbMeta(b.id, {
                  ...(b.meta || {}),
                  verified: !b.meta?.verified,
                  source_type: b.meta?.source_type || "文档",
                });
              }}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-emerald-500"
              title={t("kb.toggleVerified")}
            >
              <BadgeCheck className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                kb.removeBase(b.id);
                ragDeleteKb(b.id).catch((e: unknown) => {
                  // 删除失败却把界面刷新成「已删除」= 骗用户。这里给可见反馈 + 留痕。
                  showToast("error", `删除知识库失败：${String(e)}`);
                  logDiag(`ragDeleteKb failed: ${String(e)} kb=${b.id}`);
                });
              }}
              className="p-0.5 rounded hover:bg-destructive/20 text-destructive"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        {kb.activeBaseId ? (
          <>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase">
              {t("kb.files")}
            </h3>
            <div className="flex gap-1">
              <input
                placeholder="file.txt"
                value={newFile}
                onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createFile()}
                className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded"
              />
              <button
                onClick={createFile}
                className="p-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={importDocument}
                disabled={indexing}
                className="px-2 py-1 text-xs rounded border border-input text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1 disabled:opacity-40"
                title={t("kb.importTitle")}
              >
                <Upload className="w-3 h-3" /> {indexing ? t("kb.importing") : t("kb.import")}
              </button>
              <button
                onClick={reindexWithOpenai}
                disabled={indexing}
                className="px-2 py-1 text-xs rounded border border-input text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1 disabled:opacity-40"
                title="用 OpenAI 嵌入重建索引(语义检索,需 API Key)"
              >
                <Sparkles className="w-3 h-3" /> {indexing ? t("kb.importing") : "OpenAI 嵌入"}
              </button>
            </div>
            {kb.files.map((f) => (
              <div
                key={f.name}
                className="flex items-center justify-between px-2 py-1.5 rounded text-xs hover:bg-muted cursor-pointer"
              >
                <span onClick={() => editFile(f.name)} className="flex items-center gap-1.5 flex-1">
                  <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                  {f.name}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0 mr-1">
                  {indexed[f.name] != null
                    ? t("kb.chunks", { n: indexed[f.name] ?? 0 })
                    : indexing
                      ? t("kb.indexing")
                      : t("kb.notIndexed")}
                </span>
                <button
                  onClick={() => {
                    const bid = kb.activeBaseId;
                    if (!bid) return;
                    kb.deleteFile(bid, f.name);
                    kb.loadFiles(bid);
                  }}
                  className="p-0.5 rounded hover:bg-destructive/20 text-destructive"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            {editing && (
              <div className="mt-2 space-y-2">
                <label className="text-xs text-muted-foreground">
                  {t("kb.editing")}: {editing}
                </label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={6}
                  className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded resize-none font-mono"
                />
                <div className="flex gap-1">
                  <button
                    onClick={saveEdit}
                    className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1"
                  >
                    <Save className="w-3 h-3" /> {t("settings.save")}
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="px-3 py-1 text-xs border border-input rounded hover:bg-muted"
                  >
                    {t("settings.cancel")}
                  </button>
                </div>
              </div>
            )}

            {/* Retrieval test panel (Cherry Studio style) */}
            <div className="mt-3 pt-3 border-t border-border">
              <div className="flex items-center gap-1 mb-1.5">
                <Search className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-semibold">{t("kb.retrievalTest")}</span>
              </div>
              <div className="flex gap-1">
                <input
                  placeholder={t("kb.testPlaceholder")}
                  value={testQuery}
                  onChange={(e) => setTestQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runTest()}
                  className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded"
                />
                <button
                  onClick={runTest}
                  disabled={testing}
                  className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                >
                  {testing ? t("kb.testing") : t("kb.test")}
                </button>
              </div>
              {testResult && (
                <pre className="mt-2 p-2 text-[11px] bg-muted rounded overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {testResult || t("kb.noHit")}
                </pre>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground py-8 text-center">{t("kb.select")}</p>
        )}
      </div>
    </div>
  );
}
