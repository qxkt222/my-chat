// components/settings/McpPermissionDialog.tsx — MCP 工具调用的运行时授权弹窗
//
// 背景（RS-01）：后端 `decide_permission` 对「未配置权限」的工具返回 Ask。
// 这个组件是 Ask 的唯一出口：收到 `mcp-permission-request` 事件后显示服务器 /
// 工具 / 参数摘要，用户选择「允许一次」「始终允许」或「拒绝」，再把结论回执给
// 后端（`mcp_resolve_permission`）。
//
// 约定：
// - 多个请求 **排队**，同一时刻只展示一个，避免弹窗叠成一片；
// - 「始终允许」= remember=true → 后端写入 allow 策略，下次不再询问；
// - 「拒绝」只是一次性拒绝，不写策略（用户可在设置页显式设为 deny）。

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  MCP_PERMISSION_REQUEST_EVENT,
  mcpResolvePermission,
  type McpPermissionAnswer,
  type McpPermissionRequestDto,
} from "@/lib/tauri";
import { showToast } from "@/components/ui/Toast";

export function McpPermissionDialog() {
  const [queue, setQueue] = useState<McpPermissionRequestDto[]>([]);
  const [busy, setBusy] = useState(false);
  const current = queue[0];

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<McpPermissionRequestDto>(MCP_PERMISSION_REQUEST_EVENT, (event) => {
      const req = event.payload;
      if (!req?.request_id) return;
      setQueue((prev) =>
        prev.some((q) => q.request_id === req.request_id) ? prev : [...prev, req]
      );
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e: unknown) => {
        showToast("error", `MCP 授权事件监听失败: ${String(e)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const answer = async (verdict: McpPermissionAnswer, remember: boolean) => {
    if (!current || busy) return;
    setBusy(true);
    const requestId = current.request_id;
    try {
      await mcpResolvePermission(requestId, verdict, remember);
    } catch (e) {
      // 常见原因：后端 60 秒超时已拒绝 → 请求不存在。无论哪种都把它移出队列，
      // 否则用户会被一条永远回执不了的请求卡住。
      showToast("error", `MCP 授权回执失败: ${String(e)}`);
    } finally {
      setQueue((prev) => prev.filter((q) => q.request_id !== requestId));
      setBusy(false);
    }
  };

  if (!current) return null;

  const remaining = queue.length - 1;

  return (
    <div className="fixed inset-0 z-[96] bg-black/40 flex items-center justify-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="MCP 工具授权"
        className="w-[420px] max-w-[90vw] bg-card border border-border rounded-lg shadow-xl p-4"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold">MCP 工具调用授权</span>
          {remaining > 0 && (
            <span className="text-[10px] text-muted-foreground">还有 {remaining} 个请求排队</span>
          )}
        </div>

        <p className="text-xs text-muted-foreground mb-3">
          这个工具尚未配置权限策略，是否允许本次调用？
        </p>

        <dl className="space-y-1.5 text-xs mb-3">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">服务器</dt>
            <dd className="flex-1 break-all">{current.server_name || current.server_id}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">工具</dt>
            <dd className="flex-1 break-all font-mono">{current.tool}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">参数</dt>
            <dd className="flex-1 break-all font-mono max-h-32 overflow-y-auto bg-muted/40 rounded px-2 py-1">
              {current.args_preview || "(无参数)"}
            </dd>
          </div>
        </dl>

        <div className="flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={() => void answer("deny", false)}
            className="px-3 py-1.5 text-xs rounded border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            拒绝
          </button>
          <button
            disabled={busy}
            onClick={() => void answer("allow", false)}
            className="px-3 py-1.5 text-xs rounded border border-input hover:bg-muted disabled:opacity-50"
          >
            允许一次
          </button>
          <button
            disabled={busy}
            onClick={() => void answer("allow", true)}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            始终允许
          </button>
        </div>
      </div>
    </div>
  );
}
