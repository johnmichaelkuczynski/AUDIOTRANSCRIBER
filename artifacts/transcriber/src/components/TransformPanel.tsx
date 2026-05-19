import { useState } from "react";
import { useTransformTranscription } from "@workspace/api-client-react";
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
import { Loader2, Sparkles, Wand2, Copy, Check, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Provider = "deepseek" | "anthropic" | "venice";
type Mode = "cleanup" | "rewrite";

interface TransformPanelProps {
  transcriptionId: number;
}

const PROVIDER_LABEL: Record<Provider, string> = {
  deepseek: "DeepSeek",
  anthropic: "Anthropic Claude",
  venice: "Venice AI",
};

export function TransformPanel({ transcriptionId }: TransformPanelProps) {
  const { toast } = useToast();
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<{ text: string; mode: Mode; provider: Provider } | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeMode, setActiveMode] = useState<Mode | null>(null);

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

  const isCleaning = transformMutation.isPending && activeMode === "cleanup";
  const isRewriting = transformMutation.isPending && activeMode === "rewrite";
  const busy = transformMutation.isPending;

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
              <SelectItem value="anthropic">{PROVIDER_LABEL.anthropic}</SelectItem>
              <SelectItem value="deepseek">{PROVIDER_LABEL.deepseek}</SelectItem>
              <SelectItem value="venice">{PROVIDER_LABEL.venice}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => runTransform("cleanup")}
          disabled={busy}
          className="gap-2"
        >
          {isCleaning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Clean up (remove fillers & repetitions)
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
              {result.mode === "cleanup" ? "Cleaned transcript" : "Rewritten transcript"} ·{" "}
              <span className="text-foreground">{PROVIDER_LABEL[result.provider]}</span>
            </div>
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
