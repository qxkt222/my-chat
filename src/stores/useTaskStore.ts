// stores/useTaskStore.ts — 后台任务队列 + 任务面板(20)
//
// 外部参考:ChatGPT Deep Research / best-of-Agent-Harnesses 的任务队列 + 后台运行 +
// 完成后通知。本地实现:任务列表持久化 localStorage,任务由调用方提供 async runner,
// 队列按 FIFO 顺序执行;侧栏「任务」面板监控进度,完成后 toast 通知。
// 典型用途:深度研究、批量摘要(记忆卡)、长文档归档——不阻塞当前会话。

import { create } from "zustand";

export type TaskStatus = "queued" | "running" | "done" | "error";

export interface TaskItem {
  id: string;
  title: string;
  /** 进度 0-100 */
  progress: number;
  status: TaskStatus;
  result?: string;
  error?: string;
  created_at: string;
}

const TASKS_KEY = "bg_tasks";

interface TaskState {
  tasks: TaskItem[];
  /** 运行中的任务数(状态栏/面板指示) */
  runningCount: number;
  /** 入队并立即执行(runner 完成后自动更新状态) */
  enqueue: (
    title: string,
    runner: (report: (pct: number, label?: string) => void) => Promise<string>
  ) => Promise<void>;
  removeTask: (id: string) => void;
  clearDone: () => void;
}

let running = false;

function loadTasks(): TaskItem[] {
  try {
    return JSON.parse(localStorage.getItem(TASKS_KEY) || "[]") as TaskItem[];
  } catch {
    return [];
  }
}

function persist(tasks: TaskItem[]): void {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: loadTasks(),
  runningCount: 0,

  enqueue: async (title, runner) => {
    const task: TaskItem = {
      id: crypto.randomUUID(),
      title,
      progress: 0,
      status: "queued",
      created_at: new Date().toISOString(),
    };
    const tasks = [task, ...get().tasks];
    persist(tasks);
    set({ tasks, runningCount: get().runningCount + 1 });

    // FIFO:一次只跑一个(并发多任务会让本地模型过载)
    const waitTurn = async () => {
      while (running) {
        await new Promise((r) => setTimeout(r, 120));
      }
    };
    await waitTurn();
    running = true;
    try {
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === task.id ? { ...t, status: "running" } : t)),
      }));
      const result = await runner((pct) => {
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === task.id ? { ...t, progress: Math.min(100, Math.max(0, Math.round(pct))) } : t
          ),
        }));
      });
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === task.id ? { ...t, status: "done", progress: 100, result } : t
        ),
      }));
      persist(get().tasks);
    } catch (e) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === task.id ? { ...t, status: "error", error: String(e) } : t
        ),
      }));
      persist(get().tasks);
    } finally {
      running = false;
      set((s) => ({ runningCount: Math.max(0, s.runningCount - 1) }));
    }
  },

  removeTask: (id) => {
    const tasks = get().tasks.filter((t) => t.id !== id);
    persist(tasks);
    set({ tasks });
  },

  clearDone: () => {
    const tasks = get().tasks.filter((t) => t.status === "queued" || t.status === "running");
    persist(tasks);
    set({ tasks });
  },
}));
