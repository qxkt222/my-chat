// lib/i18n/knowledge.ts — 由 i18n.ts 按 key 前缀拆出（自动生成，勿手工搬运 key）
// 条目数：23

export const knowledgeMessages: Record<string, Record<string, string>> = {
  // ── Knowledge ──
  "kb.title": { zh: "知识库", en: "Knowledge Bases" },
  "kb.new": { zh: "新建知识库", en: "New KB" },
  "kb.files": { zh: "文件", en: "Files" },
  "kb.select": { zh: "请选择或新建知识库", en: "Select or create a knowledge base" },
  "kb.editing": { zh: "正在编辑", en: "Editing" },
  "kb.import": { zh: "导入", en: "Import" },
  "kb.importing": { zh: "导入中…", en: "Importing…" },
  "kb.importTitle": {
    zh: "导入 PDF/DOCX/TXT/MD 或图片（OCR）",
    en: "Import PDF/DOCX/TXT/MD or images (OCR)",
  },
  "kb.chunks": { zh: "{n} 段", en: "{n} chunks" },
  "kb.indexing": { zh: "索引中…", en: "Indexing…" },
  "kb.notIndexed": { zh: "未索引", en: "Not indexed" },
  "kb.retrievalTest": { zh: "检索测试", en: "Retrieval Test" },
  "kb.testPlaceholder": {
    zh: "输入问题，查看命中的知识片段…",
    en: "Ask a question to see matching chunks…",
  },
  "kb.testing": { zh: "检索中…", en: "Searching…" },
  "kb.test": { zh: "测试", en: "Test" },
  "kb.noHit": { zh: "未命中任何知识片段", en: "No matching chunks" },
  "kb.verified": { zh: "已验证", en: "Verified" },
  "kb.verifiedHint": {
    zh: "已验证来源:答案引用优先带此徽标的知识源",
    en: "Verified source: answers cite this KB first",
  },
  "kb.toggleVerified": { zh: "切换「已验证」标记", en: "Toggle verified badge" },
  "kb.needSelect": { zh: "请先选择知识库", en: "Select a knowledge base first" },
  "kb.noText": { zh: "未提取到文本内容", en: "No text extracted" },
  "kb.imported": { zh: "已导入 {name}（{count} 段）", en: "Imported {name} ({count} chunks)" },
  "kb.importFail": { zh: "导入失败：", en: "Import failed: " },
};
