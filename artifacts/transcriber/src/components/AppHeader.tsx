import { Link, useLocation } from "wouter";
import { Activity, Waves, XCircle } from "lucide-react";

export function AppHeader() {
  const [location] = useLocation();

  return (
    <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <Waves className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Transcriber
            </h1>
          </Link>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new Event("transcriber:clear-current-upload"));
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted"
          >
            <XCircle className="w-4 h-4" />
            <span className="hidden sm:inline">Clear current upload</span>
            <span className="sm:hidden">Clear</span>
          </button>
          <Link
            href="/diagnostics"
            className={`inline-flex items-center gap-1.5 text-sm font-medium transition-colors ${
              location === "/diagnostics"
                ? "text-primary"
                : "text-foreground hover:text-primary"
            }`}
          >
            <Activity className="w-4 h-4" />
            Diagnostics
          </Link>
        </div>
      </div>
    </header>
  );
}
