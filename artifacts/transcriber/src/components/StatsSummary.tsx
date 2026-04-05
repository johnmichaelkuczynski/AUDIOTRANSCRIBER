import { useGetTranscriptionStats } from "@workspace/api-client-react";
import { formatFileSize } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Clock, FileAudio, CheckCircle2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export function StatsSummary() {
  const { data: stats, isLoading } = useGetTranscriptionStats();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      <Card className="p-5 flex items-center gap-4 bg-card border-border shadow-sm">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <FileAudio className="w-6 h-6 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">Total Files</p>
          <p className="text-2xl font-bold text-foreground">{stats.totalCount}</p>
        </div>
      </Card>
      
      <Card className="p-5 flex items-center gap-4 bg-card border-border shadow-sm">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-6 h-6 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">Completed</p>
          <p className="text-2xl font-bold text-foreground">{stats.completedCount}</p>
        </div>
      </Card>
      
      <Card className="p-5 flex items-center gap-4 bg-card border-border shadow-sm">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Clock className="w-6 h-6 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">Total Size</p>
          <p className="text-2xl font-bold text-foreground">{formatFileSize(stats.totalFileSize)}</p>
        </div>
      </Card>
    </div>
  );
}
