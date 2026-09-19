import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { X, ImagePlus, UserRound, BookOpen, Smile } from "lucide-react";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useT } from "@/lib/i18n";
import { pickFile, readFileBytes, getAppDir, writeFileBytes } from "@/lib/tauri";
import { showToast } from "@/components/ui/Toast";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { emotionKeys, emotionImagePath } from "@/lib/emotion";
import type { CharacterCard, LoreEntry } from "@/types";

interface Props {
  card: CharacterCard;
  /** null = 新建 */
  isNew?: boolean;
  onClose: () => void;
}

/** 角色卡编辑器:全字段 + 头像 + 内嵌世界书(行格式"关键词:内容")+ 预设下拉 + 转换人设 */
export function CharacterEditor({ card, isNew, onClose }: Props) {
  const t = useT();
  const store = useCharacterStore();
  // Escape 关闭(此前只有右上角 X)
  useEscapeClose(onClose);
  const [form, setForm] = useState<CharacterCard>({ ...card });
  const [loreText, setLoreText] = useState(
    (card.character_book?.entries || []).map((e) => `${e.keys.join(",")}:${e.content}`).join("\n")
  );
  const [avatarB64, setAvatarB64] = useState<string | null>(null);

  const patch = (p: Partial<CharacterCard>) => setForm((f) => ({ ...f, ...p }));

  const uploadAvatar = async () => {
    const path = await pickFile("图片", ["png", "jpg", "jpeg", "webp"]);
    if (!path) return;
    const b64 = await readFileBytes(path);
    setAvatarB64(b64);
  };

  /** 上传某个情绪的表情图(存 avatars/emotions/{cardId}/{key}.png) */
  const uploadEmotion = async (emotionKey: string) => {
    const path = await pickFile("图片", ["png", "jpg", "jpeg", "webp"]);
    if (!path) return;
    const b64 = await readFileBytes(path);
    const appDir = await getAppDir();
    const dest = `${appDir}/characters/avatars/emotions/${form.id}/${emotionKey}.png`;
    await writeFileBytes(dest, b64);
    showToast("success", t("char.emotionSaved", { key: emotionKey }));
  };

  /** 行格式"key1,key2:内容"解析为内嵌世界书条目 */
  const parseLore = (): LoreEntry[] => {
    const entries: LoreEntry[] = [];
    for (const line of loreText.split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const keys = line
        .slice(0, idx)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const content = line.slice(idx + 1).trim();
      if (keys.length > 0 && content)
        entries.push({ keys, content, insertion_order: entries.length, enabled: true });
    }
    return entries;
  };

  const save = async () => {
    const lore = parseLore();
    // isNew 时沿用 emptyCard 的 id,保证头像路径与卡 id 一致
    const finalCard: CharacterCard = {
      ...form,
      name: form.name.trim() || "Unnamed",
      character_book: lore.length > 0 ? { name: `${form.name} 世界观`, entries: lore } : undefined,
    };
    if (avatarB64) {
      const appDir = await getAppDir();
      finalCard.avatarPath = `${appDir}/characters/avatars/${finalCard.id}.png`;
      await writeFileBytes(finalCard.avatarPath, avatarB64);
    }
    if (isNew) {
      await store.createCharacter(finalCard);
    } else {
      await store.saveCharacter({ ...finalCard, updated_at: new Date().toISOString() });
    }
    showToast("success", t("char.saved"));
    onClose();
  };

  /** 转换为人设:取 name + description(酒馆惯例,{{user}}/{{char}} 需按需调整) */
  const convertToPersona = async () => {
    if (!form.name.trim()) return;
    await store.createPersona(form.name.trim(), form.description.trim());
    showToast("success", t("char.convertPersonaDone"));
  };

  const inputCls = "w-full px-2 py-1.5 text-xs bg-background border border-input rounded";
  const labelCls = "text-[10px] text-muted-foreground block mb-0.5";

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg w-[720px] max-h-[88vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold">{isNew ? t("char.new") : t("char.edit")}</h3>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* 头像 + 名称 */}
          <div className="flex items-start gap-3">
            <button
              onClick={uploadAvatar}
              title={t("char.avatar")}
              className="w-16 h-16 rounded-lg overflow-hidden bg-muted border border-border flex items-center justify-center shrink-0 hover:opacity-80"
            >
              {avatarB64 ? (
                <img
                  src={`data:image/png;base64,${avatarB64}`}
                  alt="avatar"
                  className="w-full h-full object-cover"
                />
              ) : form.avatarPath ? (
                <img
                  src={convertFileSrc(form.avatarPath)}
                  alt="avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <ImagePlus className="w-5 h-5 text-muted-foreground" />
              )}
            </button>
            <div className="flex-1 space-y-1.5">
              <div>
                <label className={labelCls}>{t("char.name")} *</label>
                <input
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  className={inputCls}
                />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className={labelCls}>{t("char.tags")}</label>
                  <input
                    value={form.tags.join(", ")}
                    onChange={(e) =>
                      patch({
                        tags: e.target.value
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>{t("char.preset")}</label>
                  <select
                    value={form.presetId || ""}
                    onChange={(e) => patch({ presetId: e.target.value || undefined })}
                    className={inputCls}
                  >
                    <option value="">{t("char.presetNone")}</option>
                    {store.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {/* 绑定独立世界书(角色级,多选;与全局/内嵌/Persona/会话合并注入) */}
              <div>
                <label className={labelCls}>{t("char.lorebookBind")}</label>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(store.lorebooks).length === 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {t("char.lorebookBindNone")}
                    </span>
                  )}
                  {Object.entries(store.lorebooks).map(([id, b]) => {
                    const on = form.lorebookIds?.includes(id) ?? false;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() =>
                          patch({
                            lorebookIds: on
                              ? (form.lorebookIds || []).filter((x) => x !== id)
                              : [...(form.lorebookIds || []), id],
                          })
                        }
                        className={`px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
                          on
                            ? "bg-primary/20 border-primary text-primary"
                            : "border-input text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {b.name || id}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div>
            <label className={labelCls}>{t("char.description")}</label>
            <textarea
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className={labelCls}>{t("char.personality")}</label>
              <textarea
                value={form.personality}
                onChange={(e) => patch({ personality: e.target.value })}
                rows={2}
                className={`${inputCls} resize-none`}
              />
            </div>
            <div>
              <label className={labelCls}>{t("char.scenario")}</label>
              <textarea
                value={form.scenario}
                onChange={(e) => patch({ scenario: e.target.value })}
                rows={2}
                className={`${inputCls} resize-none`}
              />
            </div>
          </div>

          <div>
            <label className={labelCls}>{t("char.firstMes")}</label>
            <textarea
              value={form.first_mes}
              onChange={(e) => patch({ first_mes: e.target.value })}
              rows={3}
              placeholder="支持 {{user}} / {{char}} 宏"
              className={`${inputCls} resize-none`}
            />
          </div>
          <div>
            <label className={labelCls}>{t("char.alternateGreetings")}</label>
            <textarea
              value={form.alternate_greetings.join("\n---\n")}
              onChange={(e) =>
                patch({
                  alternate_greetings: e.target.value
                    .split(/^---$/m)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              rows={2}
              placeholder="多个开场备用,用 --- 分隔"
              className={`${inputCls} resize-none`}
            />
          </div>
          <div>
            <label className={labelCls}>{t("char.mesExample")}</label>
            <textarea
              value={form.mes_example}
              onChange={(e) => patch({ mes_example: e.target.value })}
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </div>

          <div>
            <label className={labelCls}>{t("char.systemPrompt")}</label>
            <textarea
              value={form.system_prompt}
              onChange={(e) => patch({ system_prompt: e.target.value })}
              rows={3}
              placeholder={`可留空用预设模板。支持 ${"{{char}} / {{user}} / {{description}} / {{lorebook}}"} 等宏`}
              className={`${inputCls} resize-none`}
            />
          </div>
          <div>
            <label className={labelCls}>{t("char.postHistory")}</label>
            <textarea
              value={form.post_history_instructions}
              onChange={(e) => patch({ post_history_instructions: e.target.value })}
              rows={2}
              className={`${inputCls} resize-none`}
            />
          </div>

          {/* V3 扩展:深度提示词(酒馆 Depth Prompt)——对话到第 N 条消息时注入 */}
          <div className="grid grid-cols-[80px_1fr] gap-1.5">
            <div>
              <label className={labelCls}>{t("char.depthPromptDepth")}</label>
              <input
                type="number"
                min={0}
                value={form.depth_prompt?.depth ?? 0}
                onChange={(e) =>
                  patch({
                    depth_prompt: {
                      depth: Math.max(0, Math.floor(+e.target.value || 0)),
                      prompt: form.depth_prompt?.prompt || "",
                    },
                  })
                }
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t("char.depthPrompt")}</label>
              <textarea
                value={form.depth_prompt?.prompt || ""}
                onChange={(e) =>
                  patch({
                    depth_prompt: {
                      depth: form.depth_prompt?.depth ?? 0,
                      prompt: e.target.value,
                    },
                  })
                }
                rows={2}
                placeholder={t("char.depthPromptPlaceholder")}
                className={`${inputCls} resize-none`}
              />
            </div>
          </div>

          {/* 内嵌世界书(行格式:关键词:内容) */}
          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <BookOpen className="w-3 h-3 text-primary" />
              <label className="text-[10px] text-muted-foreground">{t("char.loreEmbedded")}</label>
            </div>
            <textarea
              value={loreText}
              onChange={(e) => setLoreText(e.target.value)}
              rows={4}
              placeholder="每行一条:关键词1,关键词2:条目内容(对话中出现关键词时自动注入)"
              className={`${inputCls} resize-none font-mono`}
            />
          </div>

          {/* 表情管理(酒馆 Character Expressions):卡带 extensions.emotions 时显示 */}
          <div>
            <div className="flex items-center gap-1 mb-1">
              <Smile className="w-3 h-3 text-primary" />
              <label className="text-[10px] text-muted-foreground">{t("char.emotions")}</label>
            </div>
            {emotionKeys(form).length === 0 ? (
              <p className="text-[10px] text-muted-foreground">{t("char.noEmotions")}</p>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {emotionKeys(form).map((key) => {
                  const path = emotionImagePath(form, key);
                  return (
                    <div key={key} className="flex flex-col items-center gap-1">
                      <button
                        onClick={() => uploadEmotion(key)}
                        title={t("char.emotionUpload", { key })}
                        className="w-10 h-10 rounded-lg overflow-hidden bg-muted border border-border flex items-center justify-center hover:opacity-80"
                      >
                        {path && (
                          <img
                            src={convertFileSrc(path)}
                            alt={key}
                            className="w-full h-full object-cover"
                          />
                        )}
                        {!path && <ImagePlus className="w-4 h-4 text-muted-foreground" />}
                      </button>
                      <span className="text-[10px] text-muted-foreground">{key}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={convertToPersona}
            className="px-3 py-1.5 text-xs rounded border border-input hover:bg-muted flex items-center gap-1"
            title={t("char.convertPersona")}
          >
            <UserRound className="w-3 h-3" /> {t("char.convertPersona")}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs rounded border border-input hover:bg-muted"
          >
            {t("settings.cancel")}
          </button>
          <button
            onClick={save}
            className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
