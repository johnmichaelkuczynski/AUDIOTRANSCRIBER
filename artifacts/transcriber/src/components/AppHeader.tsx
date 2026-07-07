import { Link, useLocation } from "wouter";
import { Waves, LogOut, BarChart3 } from "lucide-react";
import { useLogout } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/useAuth";

export function AppHeader() {
  const { user } = useAuth();
  const [location] = useLocation();
  const logout = useLogout({
    mutation: {
      onSuccess: () => {
        window.location.href = import.meta.env.BASE_URL;
      },
    },
  });

  return (
    <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href="/app" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <Waves className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Transcriber
            </h1>
          </Link>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <Link
            href="/analytics"
            className={`inline-flex items-center gap-1.5 text-sm font-medium transition-colors ${
              location === "/analytics"
                ? "text-primary"
                : "text-foreground hover:text-primary"
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span className="hidden sm:inline">Analytics</span>
          </Link>
          {user && (
            <span className="hidden sm:flex items-center gap-2 text-sm font-medium text-muted-foreground">
              {user.picture && (
                <img
                  src={user.picture}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-7 h-7 rounded-full border border-border"
                />
              )}
              {user.name ?? user.email}
            </span>
          )}
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors disabled:opacity-50"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline">Log out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
