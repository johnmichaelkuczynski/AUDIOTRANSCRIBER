import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Download, Loader2, ShieldCheck, PlusCircle } from "lucide-react";
import { getCombinedTranscript } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

interface VerifiedWorkflowProps {
  session: {
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    batchId: string;
    knownTerms: string;
    setKnownTerms: (v: string) => void;
    startNewSession: () => void;
  };
  passedCount: number;
  isProcessing: boolean;
}

export function VerifiedWorkflow({
  session,
  passedCount,
  isProcessing,
}: VerifiedWorkflowProps) {
  const { toast } = useToast();
  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const result = await getCombinedTranscript(session.batchId);
      const blob = new Blob([result.text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename || "combined-transcript.txt";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof Error ? err.message : "Failed to download combined transcript.",
        variant: "destructive",
      });
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="mb-6 space-y-4 bg-muted/20 border border-border/50 rounded-xl p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Switch
            id="verified-mode"
            checked={session.enabled}
            onCheckedChange={session.setEnabled}
          />
          <Label htmlFor="verified-mode" className="font-semibold text-base flex items-center gap-2 cursor-pointer">
            <ShieldCheck className="w-5 h-5 text-primary" />
            Verified Legal Transcript
          </Label>
        </div>
      </div>

      {session.enabled && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-300 space-y-4 pt-2">
          <div className="text-sm text-muted-foreground">
            The server runs the full recording twice independently. The recording
            fails verification when the word counts differ by more than 1%.
          </div>

          <div className="space-y-2">
            <Label htmlFor="known-terms" className="text-sm font-medium">
              Confirmed spellings and corrections
            </Label>
            <Textarea
              id="known-terms"
              placeholder={"Mr. Kuczynski\nKrasinski => Kuczynski"}
              value={session.knownTerms}
              onChange={(e) => session.setKnownTerms(e.target.value)}
              className="font-mono text-sm resize-y min-h-[80px]"
            />
            <p className="text-xs text-muted-foreground">
              Enter one canonical term per line. Use “heard wrong =&gt; confirmed
              spelling” only for corrections you have verified.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Current Session
              </p>
              <p className="text-xs text-muted-foreground">
                {passedCount} passed recording{passedCount !== 1 ? "s" : ""} in
                this session. Recordings are accepted one at a time.
                {isProcessing ? " The current recording is still processing." : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={isProcessing}
                onClick={session.startNewSession}
              >
                <PlusCircle className="w-4 h-4" />
                Start new session
              </Button>
              <Button
                variant="default"
                size="sm"
                className="gap-2"
                disabled={passedCount === 0 || isDownloading}
                onClick={handleDownload}
              >
                {isDownloading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                Download combined transcript
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}