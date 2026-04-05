import { useState } from "react";
import { Transcription } from "@workspace/api-client-react/src/generated/api.schemas";
import { useDeleteTranscription, getListTranscriptionsQueryKey, getGetTranscriptionStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatFileSize, formatDate } from "@/lib/format";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Copy, Trash2, FileAudio, AlertCircle, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
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
  const { toast } = useToast();
  const queryClient = useQueryClient();

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

  const isProcessing = transcription.status === "processing";
  const isFailed = transcription.status === "failed";
  const isCompleted = transcription.status === "completed";

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
              Processing
            </Badge>
          )}
          {isFailed && (
            <Badge variant="destructive" className="font-medium">
              Failed
            </Badge>
          )}
          {isCompleted && (
            <Badge variant="outline" className="border-primary/30 text-primary font-medium">
              Completed
            </Badge>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="pt-4 pb-2">
        {isProcessing && (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin mb-2" />
            <p className="text-sm font-medium text-foreground">AI is transcribing your audio...</p>
            <p className="text-xs mt-1">This usually takes a fraction of the audio duration.</p>
          </div>
        )}
        
        {isFailed && (
          <div className="p-4 rounded-md bg-destructive/10 text-destructive text-sm border border-destructive/20">
            <p className="font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Transcription failed
            </p>
            <p className="mt-1 ml-6 text-destructive/80">
              {transcription.errorMessage || "An unknown error occurred during processing."}
            </p>
          </div>
        )}
        
        {isCompleted && transcription.text && (
          <div className="relative">
            <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed font-mono bg-muted/30 p-4 rounded-lg border border-border/40 max-h-[300px] overflow-y-auto">
              {transcription.text}
            </p>
          </div>
        )}
      </CardContent>
      
      <CardFooter className="pt-2 flex justify-between">
        <div className="flex items-center gap-2">
          {isCompleted && (
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
        </div>
        
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
              <Trash2 className="w-4 h-4" />
              <span className="sr-only">Delete</span>
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
