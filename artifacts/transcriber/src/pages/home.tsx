import { UploadArea } from "@/components/UploadArea";
import { Recorder } from "@/components/Recorder";
import { TranscriptionList } from "@/components/TranscriptionList";
import { StatsSummary } from "@/components/StatsSummary";
import { AppHeader } from "@/components/AppHeader";
import { ImportTranscriptPanel } from "@/components/ImportTranscriptPanel";
import { VerifiedWorkflow } from "@/components/VerifiedWorkflow";
import { useVerifiedSession } from "@/hooks/use-verified-session";
import { useListTranscriptions, getListTranscriptionsQueryKey } from "@workspace/api-client-react";
import { useState } from "react";

export default function Home() {
  const verifiedSession = useVerifiedSession();
  const [verifiedInputBusy, setVerifiedInputBusy] = useState({
    upload: false,
    recorder: false,
  });
  const { data: transcriptions } = useListTranscriptions({
    query: {
      queryKey: getListTranscriptionsQueryKey(),
      refetchInterval: (query) =>
        query.state.data?.some((transcription) => transcription.status === "processing")
          ? 3000
          : false,
    },
  });

  const isVerifiedProcessing =
    verifiedSession.enabled &&
    !!transcriptions?.some(
      (transcription) =>
        transcription.batchId === verifiedSession.batchId &&
        transcription.status === "processing",
    );

  const passedCount =
    transcriptions?.filter(
      (transcription) =>
        transcription.batchId === verifiedSession.batchId &&
        transcription.status === "completed" &&
        transcription.verificationStatus === "passed",
    ).length ?? 0;
  const hasVerifiedInputBusy =
    verifiedInputBusy.upload || verifiedInputBusy.recorder;

  return (
    <div className="min-h-[100dvh] bg-background">
      <AppHeader />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="grid grid-cols-1 gap-12">
          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">New Transcription</h2>
              <p className="text-muted-foreground">Upload a file or record audio for the best results.</p>
            </div>
            <VerifiedWorkflow
              session={verifiedSession}
              passedCount={passedCount}
              isProcessing={isVerifiedProcessing || hasVerifiedInputBusy}
            />

            <UploadArea
              verifiedMode={verifiedSession.enabled}
              batchId={verifiedSession.batchId}
              knownTerms={verifiedSession.knownTerms}
              isVerifiedBusy={
                isVerifiedProcessing || verifiedInputBusy.recorder
              }
              onVerifiedBusyChange={(isBusy) =>
                setVerifiedInputBusy((current) => ({
                  ...current,
                  upload: isBusy,
                }))
              }
            />
            <div className="flex items-center gap-4">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <Recorder
              verifiedMode={verifiedSession.enabled}
              batchId={verifiedSession.batchId}
              knownTerms={verifiedSession.knownTerms}
              isVerifiedBusy={
                isVerifiedProcessing || verifiedInputBusy.upload
              }
              onVerifiedBusyChange={(isBusy) =>
                setVerifiedInputBusy((current) => ({
                  ...current,
                  recorder: isBusy,
                }))
              }
            />
          </section>

          <section className="space-y-4 pt-6 border-t border-border/50">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold tracking-tight text-foreground">Import Transcript</h2>
              <p className="text-muted-foreground">Already have a transcript? Paste it here to use the AI tools without uploading audio.</p>
            </div>
            <ImportTranscriptPanel />
          </section>

          <section className="space-y-6 pt-6 border-t border-border/50">
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
