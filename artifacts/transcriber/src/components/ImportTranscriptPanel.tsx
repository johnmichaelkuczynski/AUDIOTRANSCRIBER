import { useState } from "react";
import { 
  useImportTranscriptionText, 
  getListTranscriptionsQueryKey, 
  getGetTranscriptionStatsQueryKey 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Upload, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function ImportTranscriptPanel() {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const importMutation = useImportTranscriptionText({
    mutation: {
      onSuccess: () => {
        setTitle("");
        setText("");
        queryClient.invalidateQueries({ queryKey: getListTranscriptionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTranscriptionStatsQueryKey() });
        toast({ title: "Transcript imported successfully" });
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Failed to import";
        toast({ title: "Import failed", description: msg, variant: "destructive" });
      }
    }
  });

  const handleImport = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      toast({ title: "Text is required", variant: "destructive" });
      return;
    }
    importMutation.mutate({
      data: {
        text: text.trim(),
        filename: title.trim() || "Imported Transcript"
      }
    });
  };

  const isPending = importMutation.isPending;

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
            <Textarea
              id="import-text"
              placeholder="Paste the completed transcript text here to use the AI tools..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              className="font-mono text-sm resize-y"
              disabled={isPending}
            />
          </div>

          {importMutation.isError && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm border border-destructive/20 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <p>
                {importMutation.error instanceof Error
                  ? importMutation.error.message
                  : "An unknown error occurred during import."}
              </p>
            </div>
          )}

          <div className="flex justify-end">
            <Button 
              type="submit" 
              className="w-full sm:w-auto gap-2"
              disabled={isPending || !text.trim()}
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
