import {
  useListTranscriptions,
  getListTranscriptionsQueryKey,
} from "@workspace/api-client-react";
import { TranscriptionCard } from "./TranscriptionCard";
import { Skeleton } from "@/components/ui/skeleton";
import { FileAudio } from "lucide-react";

export function TranscriptionList() {
  const { data: transcriptions, isLoading } = useListTranscriptions({
    query: {
      queryKey: getListTranscriptionsQueryKey(),
      refetchInterval: (query) => {
        // Refetch frequently if there are processing transcriptions
        const hasProcessing = query.state.data?.some(t => t.status === "processing");
        return hasProcessing ? 3000 : false;
      }
    }
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!transcriptions || transcriptions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center border border-dashed rounded-xl bg-card/50">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <FileAudio className="w-8 h-8 text-muted-foreground/50" />
        </div>
        <h3 className="text-lg font-medium text-foreground">No transcriptions yet</h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          Upload an audio file above to get started. Your transcriptions will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {transcriptions.map((transcription, i) => (
        <div 
          key={transcription.id}
          className="animate-in fade-in slide-in-from-bottom-4 fill-mode-both"
          style={{ animationDelay: `${i * 100}ms`, animationDuration: '500ms' }}
        >
          <TranscriptionCard transcription={transcription} />
        </div>
      ))}
    </div>
  );
}
