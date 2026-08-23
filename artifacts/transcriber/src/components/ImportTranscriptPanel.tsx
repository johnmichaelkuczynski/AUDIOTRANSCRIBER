import { useCallback, useEffect, useRef, useState } from "react";
import {
  getListTranscriptionsQueryKey,
  getGetTranscriptionStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Upload, AlertCircle, FileText, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import { importTranscriptInChunks } from "@/lib/chunkedTextImport";
import {
  CLEAR_CURRENT_UPLOAD_EVENT,
  resetTranscriberPage,
} from "@/lib/resetPage";

export function ImportTranscriptPanel() {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const clearImport = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsPending(false);
    setProgress(null);
    setError(null);
    setSelectedFile(null);
    setText("");
    setTitle("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  useEffect(() => {
    window.addEventListener(CLEAR_CURRENT_UPLOAD_EVENT, clearImport);
    return () => {
      window.removeEventListener(CLEAR_CURRENT_UPLOAD_EVENT, clearImport);
    };
  }, [clearImport]);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    const pastedText = text.trim();
    if (!selectedFile && !pastedText) {
      toast({ title: "Text is required", variant: "destructive" });
      return;
    }

    const source = selectedFile ?? new Blob([pastedText], { type: "text/plain" });
    const filename =
      title.trim() || selectedFile?.name || "Imported Transcript.txt";
    const controller = new AbortController();
    abortRef.current = controller;
    setIsPending(true);
    setProgress(0);
    setError(null);

    try {
      await importTranscriptInChunks(
        source,
        filename,
        setProgress,
        controller.signal,
      );
      setTitle("");
      setText("");
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getListTranscriptionsQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetTranscriptionStatsQueryKey(),
        }),
      ]);
      toast({ title: "Transcript imported successfully" });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Failed to import";
      setError(message);
      toast({
        title: "Import failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsPending(false);
        setProgress(null);
      }
    }
  };

  const hasTranscript = Boolean(selectedFile || text.trim());

  return (
    <Card className="border-border/50 shadow-sm overflow-hidden bg-card transition-all">
      <CardContent className="pt-6">
        <form onSubmit={handleImport} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="import-title">Filename or Title</Label>
            <Input
              id="import-title"
              placeholder="e.g. Deposition of John Doe"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="import-text">Transcript Text</Label>
            <input
              ref={fileInputRef}
              id="import-transcript-file"
              type="file"
              accept=".txt,.text,.md,.markdown,text/plain,text/markdown"
              className="hidden"
              disabled={isPending}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setSelectedFile(file);
                setError(null);
                if (file) {
                  setText("");
                  setTitle((current) => current || file.name);
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileText className="mr-2 h-4 w-4" />
                Choose transcript file
              </Button>
              {selectedFile && (
                <span className="text-sm text-muted-foreground">
                  {selectedFile.name} —{" "}
                  {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                </span>
              )}
            </div>
            <Textarea
              id="import-text"
              placeholder={
                selectedFile
                  ? "A transcript file is selected. Clear it to paste text instead."
                  : "Paste the completed transcript text here, or choose a transcript file above..."
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              className="font-mono text-sm resize-y"
              disabled={isPending || Boolean(selectedFile)}
            />
          </div>

          {progress !== null && (
            <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
              <div className="flex justify-between text-sm font-medium">
                <span>Importing transcript in 8 MB chunks</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm border border-destructive/20 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {hasTranscript && (
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={resetTranscriberPage}
              >
                <XCircle className="h-4 w-4" />
                Clear
              </Button>
            )}
            <Button 
              type="submit" 
              className="w-full sm:w-auto gap-2"
              disabled={isPending || !hasTranscript}
            >
              {isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {isPending ? "Importing..." : "Import transcript"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
