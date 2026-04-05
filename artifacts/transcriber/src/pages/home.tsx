import { UploadArea } from "@/components/UploadArea";
import { TranscriptionList } from "@/components/TranscriptionList";
import { StatsSummary } from "@/components/StatsSummary";
import { Waves } from "lucide-react";

export default function Home() {
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
          <div className="text-sm font-medium text-muted-foreground">
            Studio Workstation
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="grid grid-cols-1 gap-12">
          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">New Transcription</h2>
              <p className="text-muted-foreground">Upload high-quality audio for the best results.</p>
            </div>
            <UploadArea />
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
    </div>
  );
}
