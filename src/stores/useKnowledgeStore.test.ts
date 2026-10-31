// @vitest-environment jsdom
// stores/useKnowledgeStore.test.ts — T-016/T-017 回归
//
// 契约：
//   T-017：导入的非文本文件统一落盘为 `<原名>.txt`；列表不再只认
//          txt/md/json，旧的原扩展名文件（含读不出内容的历史文件）也要可见、
//          可删除，而不是从 UI 里静默消失。
//   T-016：删除文件必须先删 sled 里的 chunks，再删磁盘文件；chunks 删除
//          失败时不得删磁盘（否则已删内容仍会被检索召回）。

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipc = vi.hoisted(() => ({
  getAppDir: vi.fn(async () => "/app"),
  listDir: vi.fn(async () => [] as string[]),
  readFile: vi.fn(async (_path: string) => ""),
  writeFile: vi.fn(async (_path: string, _content: string) => {}),
  deleteItem: vi.fn(async (_path: string) => {}),
  createDir: vi.fn(async (_path: string) => {}),
}));

const invokeMock = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => 0));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, ...ipc };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useKnowledgeStore, knowledgeStoredName } from "./useKnowledgeStore";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  ipc.getAppDir.mockResolvedValue("/app");
  ipc.listDir.mockResolvedValue([]);
  ipc.readFile.mockResolvedValue("");
  ipc.deleteItem.mockResolvedValue(undefined);
  invokeMock.mockResolvedValue(0);
  useKnowledgeStore.setState({ files: [], bases: [], activeBaseId: null, loaded: false });
});

describe("T-017 导入文件落盘名", () => {
  it("非文本文件统一存为 <原名>.txt，纯文本保持原名", () => {
    expect(knowledgeStoredName("report.pdf")).toBe("report.pdf.txt");
    expect(knowledgeStoredName("scan.PNG")).toBe("scan.PNG.txt");
    expect(knowledgeStoredName("notes.md")).toBe("notes.md");
    expect(knowledgeStoredName("data.json")).toBe("data.json");
    expect(knowledgeStoredName("readme.txt")).toBe("readme.txt");
  });

  it("loadFiles 列出 .pdf.txt 条目，旧的原扩展名文件也不再消失", async () => {
    ipc.listDir.mockResolvedValue(["report.pdf.txt", "report.pdf", "notes.md"]);
    ipc.readFile.mockImplementation(async (path: string) =>
      path.includes("report.pdf.txt") ? "pdf text" : "x"
    );

    await useKnowledgeStore.getState().loadFiles("kb1");

    expect(useKnowledgeStore.getState().files.map((f) => f.name)).toEqual([
      "report.pdf.txt",
      "report.pdf",
      "notes.md",
    ]);
  });

  it("旧文件读不出内容时仍以空内容列出（可删除），不静默消失", async () => {
    ipc.listDir.mockResolvedValue(["legacy.pdf"]);
    ipc.readFile.mockRejectedValue(new Error("binary"));

    await useKnowledgeStore.getState().loadFiles("kb1");

    expect(useKnowledgeStore.getState().files).toEqual([{ name: "legacy.pdf", content: "" }]);
  });
});

describe("T-016 删除文件同步删除 chunks", () => {
  it("先删 chunks 再删磁盘，并从 store 移除", async () => {
    const order: string[] = [];
    invokeMock.mockImplementation(async () => {
      order.push("chunks");
      return 2;
    });
    ipc.deleteItem.mockImplementation(async () => {
      order.push("disk");
    });
    useKnowledgeStore.setState({ files: [{ name: "a.txt", content: "x" }] });

    await useKnowledgeStore.getState().deleteFile("kb1", "a.txt");

    expect(invokeMock).toHaveBeenCalledWith("rag_delete_document", {
      kbId: "kb1",
      fileId: "a.txt",
    });
    expect(ipc.deleteItem).toHaveBeenCalledWith("/app/knowledge/kb1/a.txt");
    expect(order).toEqual(["chunks", "disk"]);
    expect(useKnowledgeStore.getState().files).toEqual([]);
  });

  it("chunks 删除失败时保留磁盘文件与列表项（不制造假删除）", async () => {
    invokeMock.mockRejectedValue(new Error("sled unavailable"));
    useKnowledgeStore.setState({ files: [{ name: "a.txt", content: "x" }] });

    await expect(useKnowledgeStore.getState().deleteFile("kb1", "a.txt")).rejects.toThrow("sled");

    expect(ipc.deleteItem).not.toHaveBeenCalled();
    expect(useKnowledgeStore.getState().files).toEqual([{ name: "a.txt", content: "x" }]);
  });
});
