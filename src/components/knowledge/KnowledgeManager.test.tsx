// @vitest-environment jsdom
// components/knowledge/KnowledgeManager.test.tsx — T-017 导入契约
//
// 契约：导入 PDF/DOCX/图片时，写入知识库与送索引的名字必须是
// `<原文件名>.txt`（如 report.pdf.txt）。这样 useKnowledgeStore.loadFiles
// 的列表能显示该条目，用户可见并可编辑/删除/重建。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const storeState = vi.hoisted(() => ({
  bases: [] as unknown[],
  activeBaseId: "kb1" as string | null,
  files: [] as { name: string; content: string }[],
  loaded: true,
  saveFile: vi.fn(async () => {}),
  loadFiles: vi.fn(async () => {}),
  createBase: vi.fn(async () => ({})),
  removeBase: vi.fn(async () => {}),
  setActive: vi.fn(),
  setKbMeta: vi.fn(),
  deleteFile: vi.fn(async () => {}),
  getContext: vi.fn(async () => ""),
}));

const ipc = vi.hoisted(() => ({
  pickFile: vi.fn(async () => "C:\\docs\\report.pdf"),
  extractDocumentText: vi.fn(async () => "hello from pdf"),
  ocrImage: vi.fn(async () => ""),
  ragSearch: vi.fn(async () => [] as Record<string, unknown>[]),
  ragIndexDocument: vi.fn(async () => 3),
  ragIndexWithOpenai: vi.fn(async () => 1),
  ragDeleteKb: vi.fn(async () => {}),
  logDiag: vi.fn(),
}));

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@/lib/tauri", () => ipc);
vi.mock("@/stores/useKnowledgeStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/useKnowledgeStore")>();
  return { ...actual, useKnowledgeStore: () => storeState };
});
vi.mock("@/stores/useSettingsStore", () => ({
  useSettingsStore: { getState: () => ({ models: [], activeModel: "" }) },
}));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("@/components/ui/Toast", () => toast);
vi.mock("@/components/ui/ConfirmDialog", () => ({ askConfirm: vi.fn(async () => true) }));

import { formatRagScore, KnowledgeManager } from "./KnowledgeManager";

beforeEach(() => {
  vi.clearAllMocks();
  storeState.activeBaseId = "kb1";
  storeState.files = [];
  ipc.pickFile.mockResolvedValue("C:\\docs\\report.pdf");
  ipc.extractDocumentText.mockResolvedValue("hello from pdf");
  ipc.ragIndexDocument.mockResolvedValue(3);
});

afterEach(() => cleanup());

describe("T-017 导入非文本文件", () => {
  it("PDF 的落盘名和索引名都是 report.pdf.txt", async () => {
    render(<KnowledgeManager />);

    fireEvent.click(screen.getByText("kb.import"));

    await waitFor(() =>
      expect(storeState.saveFile).toHaveBeenCalledWith("kb1", "report.pdf.txt", "hello from pdf")
    );
    expect(ipc.ragIndexDocument).toHaveBeenCalledWith("kb1", "report.pdf.txt", "hello from pdf");
    expect(storeState.saveFile).not.toHaveBeenCalledWith("kb1", "report.pdf", expect.anything());
    expect(toast.showToast).toHaveBeenCalledWith("success", expect.anything());
  });

  it("图片 OCR 结果同样存为 <原名>.txt", async () => {
    ipc.pickFile.mockResolvedValue("C:\\docs\\scan.png");
    ipc.extractDocumentText.mockRejectedValue(new Error("not a document"));
    ipc.ocrImage.mockResolvedValue("ocr text");

    render(<KnowledgeManager />);
    fireEvent.click(screen.getByText("kb.import"));

    await waitFor(() =>
      expect(storeState.saveFile).toHaveBeenCalledWith("kb1", "scan.png.txt", "ocr text")
    );
    expect(ipc.ragIndexDocument).toHaveBeenCalledWith("kb1", "scan.png.txt", "ocr text");
  });
});

describe("T-068 检索分数可解释", () => {
  it("按后端的 score_kind 标注来源，且百分比封顶 100%", () => {
    expect(formatRagScore(1, "rrf")).toBe("relevance 100% (RRF fusion)");
    expect(formatRagScore(1, "bm25")).toBe("relevance 100% (BM25)");
    expect(formatRagScore(1, "cosine")).toBe("relevance 100% (vector)");
    expect(formatRagScore(0.42, "cosine")).toBe("relevance 42% (vector)");
    // 旧后端没有 score_kind 时退回基础文案，不崩
    expect(formatRagScore(0.98)).toBe("relevance 98%");
    // 越界/NaN 不显示成奇怪数字
    expect(formatRagScore(1.7, "cosine")).toBe("relevance 100% (vector)");
    expect(formatRagScore(Number.NaN, "rrf")).toBe("relevance 0% (RRF fusion)");
  });

  it("hybrid 完美命中在检索测试面板显示 100%，不再是 2%", async () => {
    ipc.ragSearch.mockResolvedValue([
      {
        chunk_id: "c1",
        content: "hello",
        score: 1,
        score_kind: "rrf",
        kb_name: "kb",
        file_name: "a.txt",
      },
    ]);
    render(<KnowledgeManager />);
    fireEvent.change(screen.getByPlaceholderText("kb.testPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByText("kb.test"));

    await screen.findByText(/relevance 100% \(RRF fusion\)/);
    expect(ipc.ragSearch).toHaveBeenCalledWith("hello", { kbId: "kb1", topK: 3 });
  });
});
