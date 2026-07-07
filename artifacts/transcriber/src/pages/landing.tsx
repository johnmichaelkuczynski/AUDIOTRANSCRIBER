import { useLocation } from "wouter";
import { Waves, Mic, FileAudio, Sparkles } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  );
}

function signInWithGoogle() {
  window.location.href = "/api/auth/google";
}

export default function Landing() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <Waves className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">Transcriber</h1>
          </div>
          <div className="flex items-center gap-3">
            {user ? (
              <button
                type="button"
                onClick={() => setLocation("/app")}
                className="text-sm font-semibold rounded-lg bg-primary text-primary-foreground px-4 py-2 shadow-sm hover:bg-primary/90 transition-colors"
              >
                Open app
              </button>
            ) : (
              <button
                type="button"
                onClick={signInWithGoogle}
                className="inline-flex items-center gap-2 text-sm font-semibold rounded-lg border border-border bg-card text-foreground px-4 py-2 shadow-sm hover:bg-secondary transition-colors"
              >
                <GoogleIcon className="w-4 h-4" />
                Sign in with Google
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-16 pb-12 sm:pt-24 sm:pb-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground mb-6">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            AI-powered audio transcription
          </div>
          <h2 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-foreground max-w-3xl mx-auto leading-[1.05]">
            Turn any recording into clean, readable text
          </h2>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            Upload a file or record in your browser. Transcriber handles the rest — accurate
            transcripts you can clean up and rewrite in seconds.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            {user ? (
              <button
                type="button"
                onClick={() => setLocation("/app")}
                className="w-full sm:w-auto text-base font-semibold rounded-xl bg-primary text-primary-foreground px-7 py-3.5 shadow-sm hover:bg-primary/90 transition-colors"
              >
                Open app
              </button>
            ) : (
              <button
                type="button"
                onClick={signInWithGoogle}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-3 text-base font-semibold rounded-xl border border-border bg-card text-foreground px-7 py-3.5 shadow-sm hover:bg-secondary transition-colors"
              >
                <GoogleIcon className="w-5 h-5" />
                Continue with Google
              </button>
            )}
          </div>
        </section>

        <section className="max-w-5xl mx-auto px-4 sm:px-6 pb-20">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { icon: FileAudio, title: "Upload any audio", body: "Drop in MP3, WAV, M4A and more — up to 50MB per file." },
              { icon: Mic, title: "Record in-browser", body: "Capture audio directly and transcribe it instantly." },
              { icon: Sparkles, title: "Clean up with AI", body: "Rewrite and polish transcripts with one click." },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-2xl border border-border bg-card p-6 text-left">
                <div className="w-10 h-10 rounded-lg bg-accent flex items-center justify-center mb-4">
                  <Icon className="w-5 h-5 text-accent-foreground" />
                </div>
                <h3 className="font-bold text-foreground">{title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 text-center text-sm text-muted-foreground">
          © {new Date().getFullYear()} Transcriber
        </div>
      </footer>
    </div>
  );
}
