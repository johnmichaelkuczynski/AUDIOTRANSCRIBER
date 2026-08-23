import {
  getListTranscriptionsQueryKey,
  useListTranscriptions,
} from "@workspace/api-client-react";
import { formatFileSize } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Clock, FileAudio, CheckCircle2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { wasCreatedAfterWorkspaceClear } from "@/lib/resetPage";

export function StatsSummary() {
  const { data: transcriptions, isLoading } = useListTranscriptions({
    query: {
      queryKey: getListTranscriptionsQueryKey(),
    },
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }

  if (!transcriptions) return null;

  const currentTranscriptions = transcriptions.filter((transcription) =>
    wasCreatedAfterWorkspaceClear(transcription.createdAt),
  );
  const completedCount = currentTranscriptions.filter(
    (transcription) => transcription.status === "completed",
  ).length;
  const totalFileSize = currentTranscriptions.reduce(
    (total, transcription) => total + transcription.fileSize,
    0,
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      <Card className="p-5 flex items-center gap-4 bg-card border-border shadow-sm">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <FileAudio className="w-6 h-6 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">Total Files</p>
          <p className="text-2xl font-bold text-foreground">
            {currentTranscriptions.length}
          </p>
        </div>
      </Card>
      
      <Card className="p-5 flex items-center gap-4 bg-card border-border shadow-sm">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-6 h-6 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">Completed</p>
          <p className="text-2xl font-bold text-foreground">{completedCount}</p>
        </div>
      </Card>
      
      <Card className="p-5 flex items-center gap-4 bg-card border-border shadow-sm">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Clock className="w-6 h-6 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">Total Size</p>
          <p className="text-2xl font-bold text-foreground">
            {formatFileSize(totalFileSize)}
          </p>
        </div>
      </Card>
    </div>
  );
}
