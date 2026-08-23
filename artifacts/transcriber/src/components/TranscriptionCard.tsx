import { useState, useRef } from "react";
import type { Transcription } from "@workspace/api-client-react";
import { useDeleteTranscription, getListTranscriptionsQueryKey, getGetTranscriptionStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { countWords, formatFileSize, formatDate } from "@/lib/format";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Copy, Trash2, FileAudio, AlertCircle, Check, Play, Pause, Download, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { TransformPanel } from "./TransformPanel";
import { CoherencePanel } from "./CoherencePanel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface TranscriptionCardProps {
  transcription: Transcription;
}

export function TranscriptionCard({ transcription }: TranscriptionCardProps) {
  const [copied, setCopied] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const togglePlayback = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
    } else {
      el.pause();
    }
  };

  const deleteMutation = useDeleteTranscription({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTranscriptionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTranscriptionStatsQueryKey() });
        toast({ title: "Transcription deleted" });
      },
      onError: () => {
        toast({ title: "Failed to delete", variant: "destructive" });
      }
    }
  });

  const handleCopy = () => {
    if (!transcription.text) return;
    navigator.clipboard.writeText(transcription.text);
    setCopied(true);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadTranscript = () => {
    if (!transcription.text) return;
    const baseName = transcription.filename.replace(/\.[^.]+$/, "") || "transcript";
    const blob = new Blob([transcription.text], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}-original-transcript.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleDownloadEvidenceRun = (text: string, runLabel: "A" | "B") => {
    const baseName = transcription.filename.replace(/\.[^.]+$/, "") || "transcript";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}-verification-run-${runLabel.toLowerCase()}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const isProcessing = transcription.status === "processing";
  const isFailed = transcription.status === "failed";
  const isCompleted = transcription.status === "completed";
  const originalWordCount = countWords(transcription.text);
  const isVerified = transcription.processingMode === "verified";
  const hasVerificationEvidence =
    isVerified &&
    Boolean(transcription.verificationRunA || transcription.verificationRunB);

  return (
    <Card className="group overflow-hidden transition-all hover:shadow-md border-border/50">
      <CardHeader className="pb-3 bg-muted/20 border-b border-border/30 flex flex-row items-start justify-between space-y-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            {isProcessing ? (
              <Loader2 className="w-5 h-5 text-primary animate-spin" />
            ) : isFailed ? (
              <AlertCircle className="w-5 h-5 text-destructive" />
            ) : (
              <FileAudio className="w-5 h-5 text-primary" />
            )}
          </div>
          <div>
            <h3 className="font-semibold text-base text-foreground truncate max-w-[200px] sm:max-w-[300px] md:max-w-[400px]">
              {transcription.filename}
            </h3>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <span>{formatDate(transcription.createdAt)}</span>
              <span>•</span>
              <span>{formatFileSize(transcription.fileSize)}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isProcessing && (
            <Badge variant="secondary" className="bg-primary/10 text-primary hover:bg-primary/20 font-medium">
              {isVerified ? "Verification pending" : "Processing"}
            </Badge>
          )}
          {isFailed && (
            <Badge variant="destructive" className="font-medium">
              {isVerified ? "Verification failed" : "Failed"}
            </Badge>
          )}
          {isCompleted && (
            <>
              {isVerified ? (
                transcription.verificationStatus === "passed" ? (
                  <Badge variant="outline" className="border-green-600/30 text-green-600 font-medium gap-1">
                    <ShieldCheck className="w-3 h-3" />
                    Verified
                  </Badge>
                ) : transcription.verificationStatus === "failed" ? (
                  <Badge variant="destructive" className="font-medium gap-1">
                    <AlertCircle className="w-3 h-3" />
                    Verification Failed
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-primary/30 text-primary font-medium">
                    Completed
                  </Badge>
                )
              ) : (
                <Badge variant="outline" className="border-primary/30 text-primary font-medium">
                  Completed
                </Badge>
              )}
            </>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="pt-4 pb-2">
        {isProcessing && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  {isVerified
                    ? "Running two continuous full-recording transcripts..."
                    : "Transcribing two-minute intervals..."}
                </p>
                <p className="text-xs mt-0.5">
                  {isVerified
                    ? "The final transcript is released only if the word-count variance is 1% or less."
                    : "Completed intervals appear below immediately."}
                </p>
              </div>
            </div>
            {transcription.text && (
              <>
                <p className="text-xs font-semibold text-muted-foreground">
                  Original transcription: {originalWordCount.toLocaleString()} words
                </p>
                <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed font-mono bg-muted/30 p-4 rounded-lg border border-border/40 max-h-[300px] overflow-y-auto">
                  {transcription.text}
                </p>
              </>
            )}
          </div>
        )}
        
        {isFailed && (
          <div className="p-4 rounded-md bg-destructive/10 text-destructive text-sm border border-destructive/20">
            <p className="font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {isVerified ? "Verification failed" : "Transcription failed"}
            </p>
            <p className="mt-1 ml-6 text-destructive/80">
              {transcription.errorMessage || "An unknown error occurred during processing."}
            </p>
          </div>
        )}
        
        {(isCompleted || (isVerified && isFailed)) && transcription.audioPath && (
          <div className="mb-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-bold uppercase tracking-wide text-foreground">
                Source recording
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-2 font-semibold"
                asChild
              >
                <a
                  href={`/api/transcriptions/${transcription.id}/audio?download=1`}
                  download={transcription.filename}
                >
                  <Download className="w-4 h-4" />
                  Download source recording
                </a>
              </Button>
            </div>
            <audio
              ref={audioRef}
              preload="none"
              src={`/api/transcriptions/${transcription.id}/audio`}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              className="hidden"
            />
            <Button
              onClick={togglePlayback}
              className="w-full h-14 text-base font-bold uppercase tracking-wide bg-red-600 hover:bg-red-700 text-white gap-2 shadow-md"
            >
              {isPlaying ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current" />
              )}
              {isPlaying ? "Pause Recording" : "Play This Recording"}
            </Button>
          </div>
        )}

        {hasVerificationEvidence && transcription.verificationStatus && (
          <div className="mb-4 p-4 rounded-lg border border-border bg-card shadow-sm space-y-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className={cn("w-5 h-5", transcription.verificationStatus === "passed" ? "text-green-600" : transcription.verificationStatus === "failed" ? "text-destructive" : "text-muted-foreground")} />
                <p className="text-sm font-bold uppercase tracking-wide text-foreground">
                  Verification {transcription.verificationStatus}
                </p>
              </div>
              {transcription.batchPosition != null && (
                <Badge variant="outline" className="font-mono text-xs">
                  Session Position: {transcription.batchPosition}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">Run A</p>
                <p className="font-semibold text-foreground">
                  {transcription.verificationWordCountA ?? 0} words
                </p>
                {transcription.verificationRunA && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-6 px-0 text-xs gap-1"
                    onClick={() =>
                      handleDownloadEvidenceRun(
                        transcription.verificationRunA ?? "",
                        "A",
                      )
                    }
                  >
                    <Download className="w-3 h-3" /> Raw Run A
                  </Button>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">Run B</p>
                <p className="font-semibold text-foreground">
                  {transcription.verificationWordCountB ?? 0} words
                </p>
                {transcription.verificationRunB && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-6 px-0 text-xs gap-1"
                    onClick={() =>
                      handleDownloadEvidenceRun(
                        transcription.verificationRunB ?? "",
                        "B",
                      )
                    }
                  >
                    <Download className="w-3 h-3" /> Raw Run B
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-2 pt-3 border-t border-border/50">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Variance</span>
                <span className={cn(
                  "text-sm font-semibold",
                  (transcription.verificationVarianceBps ?? 0) <= 100 ? "text-green-600" : "text-destructive"
                )}>
                  {((transcription.verificationVarianceBps ?? 0) / 100).toFixed(2)}%
                </span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs text-muted-foreground">Threshold</span>
                <span className="text-xs font-medium text-foreground">≤ 1.00%</span>
              </div>
            </div>
          </div>
        )}

        {isCompleted && transcription.text && (
          <div className="relative">
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-foreground">
                  {isVerified ? "Verified Transcript" : "Original transcript"}
                </p>
                <p className="text-xs font-semibold text-muted-foreground">
                  {originalWordCount.toLocaleString()} words
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-2 font-semibold"
                onClick={handleDownloadTranscript}
              >
                <Download className="w-4 h-4" />
                {isVerified
                  ? "Download verified transcript (.txt)"
                  : "Download original transcript (.txt)"}
              </Button>
            </div>
            <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed font-mono bg-muted/30 p-4 rounded-lg border border-border/40 max-h-[300px] overflow-y-auto">
              {transcription.text}
            </p>
            {(!isVerified || transcription.verificationStatus === "passed") && (
              <>
                <TransformPanel
                  transcriptionId={transcription.id}
                  transcriptionText={transcription.text}
                  transcriptionFilename={transcription.filename}
                />
                <CoherencePanel
                  transcriptionId={transcription.id}
                  originalWordCount={originalWordCount}
                />
              </>
            )}
          </div>
        )}

        {isCompleted && !transcription.text && (!isVerified || transcription.verificationStatus === "passed") && (
          <div className="mt-4 p-4 rounded-md bg-muted/20 border border-border/50 text-sm text-muted-foreground flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-muted-foreground/70" />
            <span>
              AI transcript perfection and play generation require transcript text. Import or transcribe audio to use these tools.
            </span>
          </div>
        )}
      </CardContent>
      
      <CardFooter className="pt-2 flex justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {transcription.text && !(isVerified && isFailed) && (
            <Button 
              variant="ghost" 
              size="sm" 
              className={cn("h-8 gap-2 text-muted-foreground hover:text-foreground transition-colors", copied && "text-green-600 hover:text-green-700")}
              onClick={handleCopy}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? "Copied" : "Copy text"}
            </Button>
          )}
          {!isCompleted && transcription.text && !(isVerified && isFailed) && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              onClick={handleDownloadTranscript}
            >
              <Download className="w-4 h-4" />
              Download current transcript (.txt)
            </Button>
          )}
          {!isCompleted && transcription.audioPath && (
            <Button variant="outline" size="sm" className="h-8 gap-2" asChild>
              <a
                href={`/api/transcriptions/${transcription.id}/audio?download=1`}
                download={transcription.filename}
              >
                <Download className="w-4 h-4" />
                Download source recording
              </a>
            </Button>
          )}
        </div>
        
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-2 px-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
              <Trash2 className="w-4 h-4" />
              <span>Delete</span>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete transcription</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete the transcription for "{transcription.filename}"? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction 
                onClick={() => deleteMutation.mutate({ id: transcription.id })}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}
