import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  error: string;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, error: "" };
  static getDerivedStateFromError(e: Error): State {
    return { hasError: true, error: e.message };
  }

  override render() {
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
