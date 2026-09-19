import { useState } from "react";
import { FolderOpen, Database, UploadCloud, RefreshCw } from "lucide-react";
import { useT } from "@/lib/i18n";
import { createBackup, listBackups, restoreBackup, webdavUpload } from "@/lib/tauri";
import { showToast } from "@/components/ui/Toast";
import { askConfirm } from "@/components/ui/ConfirmDialog";

interface BackupItem {
  name: string;
  path: string;
  ts: number;
  size_mb: number;
}

export function DataManager() {
  const t = useT();
  const [backupDir, setBackupDir] = useState("");
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [busy, setBusy] = useState(false);

  // WebDAV config
  const [wdUrl, setWdUrl] = useState("");
  const [wdUser, setWdUser] = useState("");
  const [wdPass, setWdPass] = useState("");
  const [wdBusy, setWdBusy] = useState(false);

  const defaultDir = "数据-备份";

  const refreshList = async () => {
    if (!backupDir.trim()) return;
    try {
      setBackups(await listBackups(backupDir.trim()));
    } catch (e) {
      showToast("error", `${t("data.listFail")}${e}`);
    }
  };

  const doBackup = async () => {
    const dir = backupDir.trim() || defaultDir;
    setBusy(true);
    try {
      const p = await createBackup(dir);
      showToast("success", `${t("data.backupDone")}${p}`);
      setBackupDir(dir);
      refreshList();
    } catch (e) {
      showToast("error", `${t("data.backupFail")}${e}`);
    }
    setBusy(false);
  };

  const doRestore = async (item: BackupItem) => {
    if (!(await askConfirm(t("data.restoreConfirm", { name: item.name })))) return;
    try {
      const msg = await restoreBackup(item.path);
      showToast("success", msg);
    } catch (e) {
      showToast("error", `${t("data.restoreFail")}${e}`);
    }
  };

  const doUpload = async (item: BackupItem) => {
    if (!wdUrl.trim() || !wdUser.trim()) {
      showToast("error", t("data.uploadNeedConfig"));
      return;
    }
    setWdBusy(true);
    try {
      // Upload the whole backup directory recursively to the configured URL
      await webdavUpload(wdUrl.trim(), wdUser.trim(), wdPass, item.path);
      showToast("success", t("data.uploaded", { name: item.name }));
    } catch (e) {
      showToast("error", `${t("data.uploadFail")}${e}`);
    }
    setWdBusy(false);
  };

  return (
    <div className="space-y-5">
      {/* Local backup */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Database className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">{t("data.localBackup")}</span>
        </div>
        <div className="flex gap-1 mb-2">
          <input
            value={backupDir}
            onChange={(e) => setBackupDir(e.target.value)}
            placeholder={t("data.backupDirPlaceholder", { dir: defaultDir })}
            className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
          />
          <button
            onClick={doBackup}
            disabled={busy}
            className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
          >
            <FolderOpen className="w-3.5 h-3.5" />{" "}
            {busy ? t("data.backingUp") : t("data.backupNow")}
          </button>
          <button
            onClick={refreshList}
            disabled={!backupDir.trim()}
            className="p-1.5 rounded border border-input bg-background text-muted-foreground hover:text-foreground disabled:opacity-40"
            title={t("data.refresh")}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {backups.length > 0 && (
          <div className="space-y-1">
            {backups.map((b) => (
              <div
                key={b.name}
                className="flex items-center gap-2 px-2 py-1.5 rounded border border-border text-xs"
              >
                <span className="flex-1 truncate">{b.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {new Date(b.ts * 1000).toLocaleString()} · {b.size_mb} MB
                </span>
                <button
                  onClick={() => doUpload(b)}
                  disabled={wdBusy}
                  className="px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 shrink-0 flex items-center gap-0.5"
                  title={t("data.uploadWebdav")}
                >
                  <UploadCloud className="w-3 h-3" /> {t("data.upload")}
                </button>
                <button
                  onClick={() => doRestore(b)}
                  className="px-2 py-0.5 rounded border border-input hover:bg-muted shrink-0"
                  title={t("data.restore")}
                >
                  {t("data.restore")}
                </button>
              </div>
            ))}
          </div>
        )}
        {backups.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t("data.noBackups")}</p>
        )}
      </div>

      {/* WebDAV upload config */}
      <div className="pt-3 border-t border-border">
        <div className="flex items-center gap-1.5 mb-2">
          <UploadCloud className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">{t("data.webdavTitle")}</span>
        </div>
        <div className="space-y-1.5">
          <input
            value={wdUrl}
            onChange={(e) => setWdUrl(e.target.value)}
            placeholder={t("data.webdavUrlPlaceholder")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
          />
          <div className="flex gap-1.5">
            <input
              value={wdUser}
              onChange={(e) => setWdUser(e.target.value)}
              placeholder={t("data.username")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
            <input
              type="password"
              value={wdPass}
              onChange={(e) => setWdPass(e.target.value)}
              placeholder={t("data.password")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">{t("data.webdavHint")}</p>
        </div>
      </div>
    </div>
  );
}
