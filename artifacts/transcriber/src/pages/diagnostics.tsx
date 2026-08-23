import { useRunDiagnostics } from "@workspace/api-client-react";
import {
  Activity,
  CheckCircle2,
  CirclePlay,
  KeyRound,
  Loader2,
  XCircle,
} from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";

export default function Diagnostics() {
  const diagnostics = useRunDiagnostics();
  const report = diagnostics.data;
  const passed = report?.checks.filter((check) => check.status === "passed").length ?? 0;

  return (
    <div className="min-h-[100dvh] bg-background">
      <AppHeader />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="w-6 h-6 text-primary" />
              <h2 className="text-2xl font-bold tracking-tight text-foreground">
                Diagnostics
              </h2>
            </div>
            <p className="mt-2 text-muted-foreground max-w-2xl">
              Runs live checks against the same database, storage, audio pipeline,
              and transcription provider used by the app.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => diagnostics.mutate()}
            disabled={diagnostics.isPending}
            className="shrink-0 gap-2"
          >
            {diagnostics.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CirclePlay className="w-4 h-4" />
            )}
            {diagnostics.isPending ? "Running checks" : "Run diagnostics"}
          </Button>
        </div>

        <section className="mt-8 rounded-xl border border-border bg-card">
          <div className="p-5 border-b border-border">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-accent/50 flex items-center justify-center shrink-0">
                <KeyRound className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Transcription provider</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  AssemblyAI diarization for audio transcription and direct OpenAI for transcript perfection/play generation
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Credentials:{" "}
                  <span className="font-mono text-foreground">
                    ASSEMBLYAI_API_KEY
                  </span>
                  ,{" "}
                  <span className="font-mono text-foreground">
                    OPENAI_API_KEY
                  </span>{" "}
                  (values are never shown)
                </p>
              </div>
            </div>
          </div>

          {!report && !diagnostics.isPending && !diagnostics.isError && (
            <div className="p-8 text-center text-muted-foreground">
              Run diagnostics to generate live, inspectable results.
            </div>
          )}

          {diagnostics.isPending && (
            <div className="p-8 flex flex-col items-center text-center">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
              <p className="mt-3 font-medium text-foreground">
                Testing every dependency
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                The live AI transcription check can take several seconds.
              </p>
            </div>
          )}

          {diagnostics.isError && (
            <div className="p-5 text-sm text-destructive">
              The diagnostics request itself failed:{" "}
              {diagnostics.error instanceof Error
                ? diagnostics.error.message
                : "Unknown request failure"}
            </div>
          )}

          {report && !diagnostics.isPending && (
            <>
              <div className="px-5 py-4 flex items-center justify-between gap-4 border-b border-border">
                <div>
                  <p className="font-semibold text-foreground">System check results</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(report.generatedAt).toLocaleString()}
                  </p>
                </div>
                <span
                  className={
                    report.status === "passed"
                      ? "text-sm font-semibold text-emerald-700"
                      : "text-sm font-semibold text-destructive"
                  }
                >
                  {passed}/{report.checks.length} passed
                </span>
              </div>

              <div className="divide-y divide-border">
                {report.checks.map((check) => (
                  <div
                    key={check.name}
                    className="p-5 flex items-start gap-3"
                  >
                    {check.status === "passed" ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-4">
                        <p className="font-medium text-foreground">{check.name}</p>
                        <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                          {check.durationMs} ms
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground break-words">
                        {check.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}