import { useEffect, useRef, useState } from "react";
import {
  getGetTranscriptionStatsQueryKey,
  getListTranscriptionsQueryKey,
  useTransformTranscription,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Sparkles,
  Wand2,
  Copy,
  Check,
  AlertCircle,
  Users,
  Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { importTranscriptInChunks } from "@/lib/chunkedTextImport";

type Provider = "openai" | "deepseek" | "anthropic" | "venice";
type Mode = "cleanup" | "speakers" | "rewrite";

interface TransformPanelProps {
  transcriptionId: number;
  transcriptionText: string;
  transcriptionFilename: string;
}

const PROVIDER_LABEL: Record<Provider, string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  anthropic: "Anthropic Claude",
  venice: "Venice AI",
};

function removeVocalFillers(text: string): string {
  return text
    .replace(/\b(?:um+|uh+m*|er+m*|ah+|hmm+)\b[,.!?;:]?[ \t]*/giu, "")
    .replace(/\b([\p{L}\p{N}'’-]+)(?:[ \t]+\1\b)+/giu, "$1")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function TransformPanel({
  transcriptionId,
  transcriptionText,
  transcriptionFilename,
}: TransformPanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<Provider>("openai");
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<{
    text: string;
    mode: Mode;
    provider?: Provider;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeMode, setActiveMode] = useState<Mode | null>(null);
  const [fillerProgress, setFillerProgress] = useState<number | null>(null);
  const [isRemovingFillers, setIsRemovingFillers] = useState(false);
  const fillerAbortRef = useRef<AbortController | null>(null);

  const transformMutation = useTransformTranscription({
    mutation: {
      onSuccess: (data) => {
        setResult({ text: data.text, mode: data.mode as Mode, provider: data.provider as Provider });
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : "Transform failed";
        toast({ title: "Transform failed", description: message, variant: "destructive" });
      },
      onSettled: () => setActiveMode(null),
    },
  });

  useEffect(() => {
    const cancel = () => {
      fillerAbortRef.current?.abort();
      fillerAbortRef.current = null;
      setIsRemovingFillers(false);
      setFillerProgress(null);
    };
    window.addEventListener("transcriber:clear-current-upload", cancel);
    return () => {
      window.removeEventListener("transcriber:clear-current-upload", cancel);
    };
  }, []);

  const removeFillersAndSave = async () => {
    const cleaned = removeVocalFillers(transcriptionText);
    if (!cleaned || cleaned === transcriptionText.trim()) {
      toast({
        title: "No filler words found",
        description: "The transcript was left unchanged.",
      });
      return;
    }

    const controller = new AbortController();
    fillerAbortRef.current = controller;
    setIsRemovingFillers(true);
    setFillerProgress(0);
    setResult({ text: cleaned, mode: "cleanup" });

    const baseName =
      transcriptionFilename.replace(/\.[^.]+$/, "") || "transcript";
    try {
      await importTranscriptInChunks(
        new Blob([cleaned], { type: "text/plain" }),
        `${baseName}-filler-free.txt`,
        setFillerProgress,
        controller.signal,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getListTranscriptionsQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetTranscriptionStatsQueryKey(),
        }),
      ]);
      toast({
        title: "Filler-free transcript saved",
        description: "A new cleaned copy was added. The original is unchanged.",
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message =
        error instanceof Error ? error.message : "Failed to save cleaned transcript";
      toast({
        title: "Cleanup failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      if (fillerAbortRef.current === controller) {
        fillerAbortRef.current = null;
        setIsRemovingFillers(false);
        setFillerProgress(null);
      }
    }
  };

  const runTransform = (mode: Mode) => {
    if (mode === "rewrite" && !instructions.trim()) {
      toast({
        title: "Instructions required",
        description: "Tell the model how to rewrite the transcript.",
        variant: "destructive",
      });
      return;
    }
    setActiveMode(mode);
    transformMutation.mutate({
      id: transcriptionId,
      data: {
        mode,
        provider,
        ...(mode === "rewrite" ? { instructions: instructions.trim() } : {}),
      },
    });
  };

  const handleCopyResult = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.text);
    setCopied(true);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadResult = () => {
    if (!result) return;
    const blob = new Blob([result.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const baseName =
      transcriptionFilename.replace(/\.[^.]+$/, "") || "transcript";
    anchor.download =
      result.mode === "cleanup"
        ? `${baseName}-filler-free.txt`
        : `${baseName}-${result.mode}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const isFormattingSpeakers =
    transformMutation.isPending && activeMode === "speakers";
  const isRewriting = transformMutation.isPending && activeMode === "rewrite";
  const busy = transformMutation.isPending || isRemovingFillers;

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border/40 bg-muted/10 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="h-4 w-4 text-primary" />
          AI tools
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={`provider-${transcriptionId}`} className="text-xs text-muted-foreground">
            Model
          </Label>
          <Select value={provider} onValueChange={(v) => setProvider(v as Provider)} disabled={busy}>
            <SelectTrigger id={`provider-${transcriptionId}`} className="h-8 w-[170px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
              <SelectItem value="anthropic">{PROVIDER_LABEL.anthropic}</SelectItem>
              <SelectItem value="deepseek">{PROVIDER_LABEL.deepseek}</SelectItem>
              <SelectItem value="venice">{PROVIDER_LABEL.venice}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Remove filler words
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Removes “um,” “uh,” “uhm,” “er,” “ah,” “hmm,” and immediate
            repeated words from the full transcript. Saves a new cleaned copy;
            the original stays unchanged.
          </p>
        </div>
        <Button
          onClick={removeFillersAndSave}
          disabled={busy}
          className="w-full gap-2"
        >
          {isRemovingFillers ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {isRemovingFillers
            ? "Removing filler words and saving..."
            : 'Remove “um,” “uh,” and filler words'}
        </Button>
        {fillerProgress !== null && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-medium text-muted-foreground">
              <span>Saving filler-free transcript</span>
              <span>{fillerProgress}%</span>
            </div>
            <Progress value={fillerProgress} className="h-2" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => runTransform("speakers")}
          disabled={busy}
          className="gap-2"
        >
          {isFormattingSpeakers ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Users className="h-4 w-4" />
          )}
          Format with speaker labels
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`rewrite-${transcriptionId}`} className="text-xs text-muted-foreground">
          Rewrite instructions
        </Label>
        <Textarea
          id={`rewrite-${transcriptionId}`}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={`e.g. "Recast the judge's statements as more explicitly cowardly and sharpen the defendant's arguments."`}
          rows={3}
          disabled={busy}
          className="resize-none text-sm"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => runTransform("rewrite")}
            disabled={busy || !instructions.trim()}
            className="gap-2"
          >
            {isRewriting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Rewrite with instructions
          </Button>
        </div>
      </div>

      {result && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground">
              {result.mode === "cleanup"
                ? "Saved filler-free transcript"
                : result.mode === "speakers"
                  ? "Speaker-formatted transcript"
                  : "Rewritten transcript"}{" "}
              {result.provider && (
                <>
                  ·{" "}
                  <span className="text-foreground">
                    {PROVIDER_LABEL[result.provider]}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyResult}
                className={cn(
                  "h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground",
                  copied && "text-green-600 hover:text-green-700",
                )}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDownloadResult}
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </Button>
            </div>
          </div>
          <p className="max-h-[300px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/40 bg-background p-4 font-mono text-sm leading-relaxed text-foreground/90">
            {result.text}
          </p>
        </div>
      )}

      {transformMutation.isError && !busy && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {transformMutation.error instanceof Error
              ? transformMutation.error.message
              : "Something went wrong while contacting the model."}
          </span>
        </div>
      )}
    </div>
  );
}
