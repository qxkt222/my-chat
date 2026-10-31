import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useT } from "@/lib/i18n";

type Translate = ReturnType<typeof useT>;

interface Props {
  children: ReactNode;
}
interface InnerProps extends Props {
  /** 来自 useT()，随 locale 变化 —— 类组件内部不能直接调 hook */
  t: Translate;
}
interface State {
  hasError: boolean;
  error: string;
}

class ErrorBoundaryInner extends Component<InnerProps, State> {
  override state: State = { hasError: false, error: "" };
  static getDerivedStateFromError(e: Error): State {
    return { hasError: true, error: e.message };
  }

  override render() {
    const { t } = this.props;
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-background">
          <div className="text-center max-w-md p-8">
            <AlertTriangle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h1 className="text-lg font-semibold mb-2">{t("error.title")}</h1>
            <p className="text-sm text-muted-foreground mb-1">{this.state.error}</p>
            <button
              onClick={() => {
                this.setState({ hasError: false });
                window.location.reload();
              }}
              className="mt-4 px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-2 mx-auto"
            >
              <RefreshCw className="w-4 h-4" /> {t("error.reload")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 错误边界。T-138：类组件里不能用 hook，裸 t() 也不会随 locale 重渲染，
 * 所以由这个函数组件用 useT() 订阅语言，再把 t 传给真正的边界。
 */
export function ErrorBoundary({ children }: Props) {
  const t = useT();
  return <ErrorBoundaryInner t={t}>{children}</ErrorBoundaryInner>;
}
