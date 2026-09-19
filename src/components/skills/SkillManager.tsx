import { useState, useEffect } from "react";
import { Plus, Edit3, Trash2, Search, Puzzle, Brain } from "lucide-react";
import { useSkillStore } from "@/stores/useSkillStore";
import { useMemoryStore } from "@/stores/useMemoryStore";
import { useT } from "@/lib/i18n";
import { mcpListServers, mcpListTools } from "@/lib/tauri";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { Skill } from "@/types";

interface EditState extends Partial<Skill> {
  tools: string[];
  memoryTags: string[];
}

export function SkillManager() {
  const t = useT();
  const skills = useSkillStore((s) => s.skills);
  const create = useSkillStore((s) => s.create);
  const remove = useSkillStore((s) => s.remove);
  const save = useSkillStore((s) => s.save);
  const memory = useMemoryStore();
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<EditState | null>(null);
  // Escape 关闭技能编辑弹层(此前只有底部取消按钮)
  useEscapeClose(edit ? () => setEdit(null) : undefined);
  // MCP 工具树：服务器名 → 工具名列表
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [serverTools, setServerTools] = useState<Record<string, string[]>>({});

  const filtered = search
    ? skills.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
    : skills;

  // 加载 MCP 服务器 + 工具（Agent 绑定用）
  useEffect(() => {
    (async () => {
      try {
        const list = await mcpListServers();
        setServers(list.map((s) => ({ id: s.id, name: s.name })));
        for (const s of list) {
          try {
            const tools = await mcpListTools(s.id);
            setServerTools((p) => ({ ...p, [s.name]: tools.map((tool) => tool.name) }));
          } catch {
            /* 服务器不可用时忽略 */
          }
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const handleSave = async () => {
    if (!edit) return;
    const toolsJson = JSON.stringify(edit.tools || []);
    const memoryTags = JSON.stringify(edit.memoryTags || []);
    if (edit.id) await save({ ...(edit as Skill), tools_json: toolsJson, memory_tags: memoryTags });
    else
      await create({
        name: edit.name || "New",
        description: edit.description || "",
        systemPrompt: edit.systemPrompt || "",
        model: edit.model || "",
        temperature: edit.temperature ?? null,
        category: edit.category || "",
        tags: edit.tags || [],
        tools_json: toolsJson,
        memory_tags: memoryTags,
      });
    setEdit(null);
  };

  const openEdit = (skill?: Skill) => {
    if (!skill) {
      setEdit({
        name: "",
        description: "",
        systemPrompt: "",
        model: "",
        temperature: null,
        category: "",
        tags: [],
        tools: [],
        memoryTags: [],
      });
      return;
    }
    setEdit({
      ...skill,
      tools: JSON.parse(skill.tools_json || "[]"),
      memoryTags: JSON.parse(skill.memory_tags || "[]"),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder={t("skills.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-background border border-border rounded"
          />
        </div>
        <button
          onClick={() => openEdit()}
          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> {t("skills.new")}
        </button>
      </div>
      <div className="grid gap-2">
        {filtered.map((skill) => (
          <div
            key={skill.id}
            className="flex items-center justify-between p-3 border border-border rounded-md bg-card"
          >
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium">{skill.name}</span>
              <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
              <div className="flex gap-2 mt-0.5 text-[10px] text-muted-foreground">
                {skill.model && <span>{skill.model}</span>}
                {JSON.parse(skill.tools_json || "[]").length > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Puzzle className="w-2.5 h-2.5" />{" "}
                    {t("skills.toolsCount", { n: JSON.parse(skill.tools_json || "[]").length })}
                  </span>
                )}
                {JSON.parse(skill.memory_tags || "[]").length > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Brain className="w-2.5 h-2.5" />{" "}
                    {JSON.parse(skill.memory_tags || "[]").join("、")}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-1 ml-2">
              <button onClick={() => openEdit(skill)} className="p-1 rounded hover:bg-muted">
                <Edit3 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => remove(skill.id)}
                className="p-1 rounded hover:bg-destructive/20 text-destructive"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {edit && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
          onClick={() => setEdit(null)}
        >
          <div
            className="bg-card border border-border rounded-lg w-[520px] max-h-[85vh] flex flex-col shadow-xl p-4 gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold">
              {edit.id ? t("skills.edit") : t("skills.new")}
            </h3>
            <div className="flex gap-2">
              <input
                placeholder={t("skills.name")}
                value={edit.name || ""}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
              <input
                placeholder={t("skills.desc")}
                value={edit.description || ""}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <textarea
              placeholder={t("skills.prompt")}
              value={edit.systemPrompt || ""}
              onChange={(e) => setEdit({ ...edit, systemPrompt: e.target.value })}
              rows={5}
              className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
            />
            <input
              placeholder={t("skills.bindModel")}
              value={edit.model || ""}
              onChange={(e) => setEdit({ ...edit, model: e.target.value })}
              className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
            />

            {/* Agent 能力：绑定 MCP 工具 */}
            <div className="border border-border rounded-md p-2">
              <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1.5">
                <Puzzle className="w-3 h-3" /> {t("skills.bindTools")}
              </div>
              <div className="max-h-32 overflow-y-auto space-y-0.5">
                {servers.length === 0 && (
                  <p className="text-[10px] text-muted-foreground">{t("skills.noMcp")}</p>
                )}
                {servers.map((s) => (
                  <div key={s.id}>
                    <div className="text-[10px] text-muted-foreground font-medium mt-1">
                      {s.name}
                    </div>
                    {(serverTools[s.name] || []).map((tool) => {
                      const key = `${s.name}/${tool}`;
                      const on = (edit.tools || []).includes(key);
                      return (
                        <label
                          key={tool}
                          className="flex items-center gap-1.5 pl-2 py-0.5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => {
                              const cur = edit.tools || [];
                              setEdit({
                                ...edit,
                                tools: e.target.checked
                                  ? [...cur, key]
                                  : cur.filter((x) => x !== key),
                              });
                            }}
                          />
                          <span className="text-[11px]">{tool}</span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Agent 记忆：绑定记忆标签 */}
            <div className="border border-border rounded-md p-2">
              <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1.5">
                <Brain className="w-3 h-3" /> {t("skills.bindMemory")}
              </div>
              <div className="flex flex-wrap gap-1">
                {memory.allTags().length === 0 && (
                  <p className="text-[10px] text-muted-foreground">{t("skills.noMemory")}</p>
                )}
                {memory.allTags().map((tag) => {
                  const on = (edit.memoryTags || []).includes(tag);
                  return (
                    <button
                      key={tag}
                      onClick={() => {
                        const cur = edit.memoryTags || [];
                        setEdit({
                          ...edit,
                          memoryTags: on ? cur.filter((x) => x !== tag) : [...cur, tag],
                        });
                      }}
                      className={`px-2 py-0.5 text-[11px] rounded border ${on ? "bg-primary/15 border-primary text-primary" : "border-input text-muted-foreground hover:text-foreground"}`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEdit(null)}
                className="px-4 py-1.5 text-xs rounded border border-input hover:bg-muted"
              >
                {t("settings.cancel")}
              </button>
              <button
                onClick={handleSave}
                className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t("settings.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
