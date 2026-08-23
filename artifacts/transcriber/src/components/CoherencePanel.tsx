import { useState } from "react";
import {
  useCreateCoherenceJob,
  useListCoherenceJobs,
  getListCoherenceJobsQueryKey,
  type CoherenceJob,
  type CoherenceJobInputFidelityMode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Loader2, Sparkles, Copy, Download, AlertCircle, Check, Drama, RefreshCcw, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface CoherencePanelProps {
  transcriptionId: number;
}

export function CoherencePanel({ transcriptionId }: CoherencePanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Create job form state
  const [specs, setSpecs] = useState("");
  const [wordCount, setWordCount] = useState<string>("5000");
  const [fidelity, setFidelity] = useState<CoherenceJobInputFidelityMode>("adaptive");
  
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);

  // Poll list if pending
  const { data: jobs, isLoading } = useListCoherenceJobs(transcriptionId, {
    query: {
      queryKey: getListCoherenceJobsQueryKey(transcriptionId),
      refetchInterval: (query) => {
        const hasPending = query.state.data?.some(
          (j) => j.status !== "complete" && j.status !== "failed"
        );
        return hasPending ? 3000 : false;
      },
    }
  });

  const createJobMutation = useCreateCoherenceJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCoherenceJobsQueryKey(transcriptionId) });
        setSpecs("");
        toast({ title: "Job started" });
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Failed to start job";
        toast({ title: "Failed to start", description: msg, variant: "destructive" });
      }
    }
  });

  const isBusy = createJobMutation.isPending || (jobs && jobs.some(j => j.status !== "complete" && j.status !== "failed"));

  const handleCreatePolish = () => {
    createJobMutation.mutate({
      id: transcriptionId,
      data: { jobType: "polish" }
    });
  };

  const handleCreatePlay = () => {
    const wc = parseInt(wordCount, 10);
    if (isNaN(wc) || wc < 1 || wc > 60000) {
      toast({ title: "Invalid word count", description: "Must be between 1 and 60000", variant: "destructive" });
      return;
    }
    createJobMutation.mutate({
      id: transcriptionId,
      data: {
        jobType: "play",
        manualSpecifications: specs.trim() || undefined,
        targetWordCount: wc,
        fidelityMode: fidelity
      }
    });
  };

  const handleCopy = (text: string, jobId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedJobId(jobId);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopiedJobId(null), 2000);
  };

  const handleDownload = (text: string, jobId: string, type: string) => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transcript-${type}-${jobId.substring(0, 8)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-4 space-y-6 rounded-lg border border-border/40 bg-card p-5">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <Sparkles className="h-4 w-4 text-primary" />
        Perfect Transcript & Create Play
      </div>
      
      {/* Create Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Polish */}
        <div className="space-y-3 rounded-md bg-muted/20 p-4 border border-border/40">
          <div className="flex items-start gap-2">
            <RefreshCcw className="h-4 w-4 text-primary mt-0.5" />
            <div>
              <h4 className="text-sm font-semibold">Perfect Transcript</h4>
              <p className="text-xs text-muted-foreground mt-1">
                Creates a highly polished version of the transcript with strict speaker-aware legal and hearing typography. Ensures perfect formatting with no invented content.
              </p>
            </div>
          </div>
          <Button 
            onClick={handleCreatePolish} 
            disabled={isBusy}
            size="sm"
            className="w-full mt-2"
          >
            {createJobMutation.isPending && createJobMutation.variables?.data.jobType === "polish" ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Create perfect transcript
          </Button>
        </div>

        {/* Play */}
        <div className="space-y-4 rounded-md bg-muted/20 p-4 border border-border/40">
          <div className="flex items-start gap-2">
            <Drama className="h-4 w-4 text-primary mt-0.5" />
            <div>
              <h4 className="text-sm font-semibold">Create Play</h4>
              <p className="text-xs text-muted-foreground mt-1">
                Transforms the transcript into a play or dramatic narrative based on your creative requirements.
              </p>
            </div>
          </div>
          
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`specs-${transcriptionId}`} className="text-xs">Manual Specifications</Label>
              <Textarea
                id={`specs-${transcriptionId}`}
                value={specs}
                onChange={(e) => setSpecs(e.target.value)}
                placeholder="E.g. Focus on the emotional tension between speaker 1 and 2..."
                rows={2}
                className="text-xs resize-none"
                disabled={isBusy}
              />
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`words-${transcriptionId}`} className="text-xs">Target Words (max 60k)</Label>
                <Input
                  id={`words-${transcriptionId}`}
                  type="number"
                  min="1"
                  max="60000"
                  value={wordCount}
                  onChange={(e) => setWordCount(e.target.value)}
                  className="text-xs h-8"
                  disabled={isBusy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`fidelity-${transcriptionId}`} className="text-xs">Fidelity Mode</Label>
                <Select value={fidelity} onValueChange={(v: CoherenceJobInputFidelityMode) => setFidelity(v)} disabled={isBusy}>
                  <SelectTrigger id={`fidelity-${transcriptionId}`} className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="verbatim">Verbatim</SelectItem>
                    <SelectItem value="adaptive">Adaptive</SelectItem>
                    <SelectItem value="fictionalized">Fictionalized</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button 
              onClick={handleCreatePlay} 
              disabled={isBusy}
              size="sm"
              className="w-full"
            >
              {createJobMutation.isPending && createJobMutation.variables?.data.jobType === "play" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              Create play
            </Button>
          </div>
        </div>
      </div>

      {createJobMutation.isError && (
        <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm border border-destructive/20 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <p>
            {createJobMutation.error instanceof Error
              ? createJobMutation.error.message
              : "Failed to create coherence job."}
          </p>
        </div>
      )}

      {/* Jobs List */}
      {jobs && jobs.length > 0 && (
        <div className="space-y-4 pt-4 border-t border-border/40">
          <h4 className="text-sm font-semibold">Job History</h4>
          <div className="space-y-4">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-md border border-border/50 bg-background/50 overflow-hidden">
                <div className="p-3 bg-muted/10 border-b border-border/50 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {job.status === "failed" ? (
                      <AlertCircle className="w-4 h-4 text-destructive" />
                    ) : job.status === "complete" ? (
                      <Check className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <Loader2 className="w-4 h-4 text-primary animate-spin" />
                    )}
                    <span className="text-sm font-medium capitalize">
                      {job.jobType} <span className="text-muted-foreground font-normal text-xs ml-1">({job.fidelityMode})</span>
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-3">
                    <span className="capitalize">{job.status.replace("_", " ")}</span>
                    {job.status !== "failed" && job.status !== "complete" && (
                      <span>{Math.round(job.progress)}%</span>
                    )}
                  </div>
                </div>

                <div className="p-3 space-y-3">
                  {job.status !== "complete" && job.status !== "failed" && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Chunk {job.currentChunk} of {job.totalChunks}</span>
                        <span>{Math.round(job.progress)}%</span>
                      </div>
                      <Progress value={job.progress} className="h-1.5" />
                    </div>
                  )}

                  {job.status === "failed" && job.error && (
                    <div className="text-sm text-destructive bg-destructive/10 p-2 rounded-md border border-destructive/20">
                      {job.error}
                    </div>
                  )}

                  {job.warnings && job.warnings.length > 0 && (
                    <div className="text-xs text-amber-600 bg-amber-500/10 p-2 rounded-md border border-amber-500/20">
                      <div className="font-semibold mb-1 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        Warnings
                      </div>
                      <ul className="list-disc pl-4 space-y-1">
                        {job.warnings.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </div>
                  )}

                  {job.status === "complete" && job.finalOutput && (
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          Word count: {job.finalWordCount?.toLocaleString()} 
                          {job.targetWordCount ? ` (Target: ${job.targetWordCount.toLocaleString()})` : ""}
                        </span>
                        <div className="flex gap-2">
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className={cn("h-7 px-2 text-xs", copiedJobId === job.id && "text-emerald-500")}
                            onClick={() => handleCopy(job.finalOutput!, job.id)}
                          >
                            {copiedJobId === job.id ? <Check className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
                            {copiedJobId === job.id ? "Copied" : "Copy"}
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="h-7 px-2 text-xs"
                            onClick={() => handleDownload(job.finalOutput!, job.id, job.jobType)}
                          >
                            <Download className="w-3 h-3 mr-1" />
                            Download
                          </Button>
                        </div>
                      </div>
                      <p className="max-h-[350px] overflow-y-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/20 p-4 font-mono text-sm leading-relaxed text-foreground/90">
                        {job.finalOutput}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
