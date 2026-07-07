import { useLocation } from "wouter";
import { Waves, Mic, FileAudio, Sparkles } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Landing() {
  const [, setLocation] = useLocation();

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
            <button
              type="button"
              onClick={() => setLocation("/app")}
              className="text-sm font-semibold rounded-lg bg-primary text-primary-foreground px-4 py-2 shadow-sm hover:bg-primary/90 transition-colors"
            >
              Open app
            </button>
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
            <button
              type="button"
              onClick={() => setLocation("/app")}
              className="w-full sm:w-auto text-base font-semibold rounded-xl bg-primary text-primary-foreground px-7 py-3.5 shadow-sm hover:bg-primary/90 transition-colors"
            >
              Get started free
            </button>
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
