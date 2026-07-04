import { UploadArea } from "@/components/UploadArea";
import { Recorder } from "@/components/Recorder";
import { TranscriptionList } from "@/components/TranscriptionList";
import { StatsSummary } from "@/components/StatsSummary";
import { Waves, LogOut } from "lucide-react";
import { useUser, useClerk } from "@clerk/react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Home() {
  const { user } = useUser();
  const { signOut } = useClerk();

  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <Waves className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Transcriber
            </h1>
          </div>
          <div className="flex items-center gap-3 sm:gap-4">
            {user && (
              <span className="hidden sm:inline text-sm font-medium text-muted-foreground">
                {user.primaryEmailAddress?.emailAddress ??
                  user.fullName ??
                  "Signed in"}
              </span>
            )}
            <button
              type="button"
              onClick={() => signOut({ redirectUrl: basePath || "/" })}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Log out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="grid grid-cols-1 gap-12">
          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">New Transcription</h2>
              <p className="text-muted-foreground">Upload a file or record audio for the best results.</p>
            </div>
            <UploadArea />
            <div className="flex items-center gap-4">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <Recorder />
          </section>

          <section className="space-y-6">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">Activity</h2>
              <p className="text-muted-foreground">Your recent transcriptions and statistics.</p>
            </div>
            <StatsSummary />
            <TranscriptionList />
          </section>
        </div>
      </main>

      <footer className="border-t border-border mt-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} Transcriber</span>
          <span>
            Questions?{" "}
            <a
              href="mailto:zhi@zhisystems.org"
              className="font-medium text-primary hover:text-primary/80 transition-colors"
            >
              zhi@zhisystems.org
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
