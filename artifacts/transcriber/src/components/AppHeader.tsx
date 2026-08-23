import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  deleteTranscription,
  getGetTranscriptionStatsQueryKey,
  getListTranscriptionsQueryKey,
  useListTranscriptions,
} from "@workspace/api-client-react";
import { Activity, FilePlus2, Loader2, Waves, XCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  CLEAR_CURRENT_UPLOAD_EVENT,
  resetTranscriberPage,
} from "@/lib/resetPage";

export function AppHeader() {
  const [location] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [isStartingNewProject, setIsStartingNewProject] = useState(false);
  const { refetch: refetchTranscriptions } = useListTranscriptions({
    query: {
      queryKey: getListTranscriptionsQueryKey(),
    },
  });

  const startNewProject = async () => {
    setIsStartingNewProject(true);
    window.dispatchEvent(new Event(CLEAR_CURRENT_UPLOAD_EVENT));

    try {
      const latest = await refetchTranscriptions();
      if (latest.error) throw latest.error;
      const transcriptions = latest.data ?? [];
      const results = await Promise.allSettled(
        transcriptions.map((transcription) =>
          deleteTranscription(transcription.id),
        ),
      );
      const failed = results.filter((result) => result.status === "rejected");

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getListTranscriptionsQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetTranscriptionStatsQueryKey(),
        }),
      ]);

      if (failed.length > 0) {
        toast({
          title: "Some project items could not be deleted",
          description: `${failed.length} item${failed.length === 1 ? "" : "s"} remain. Try Start new project again.`,
          variant: "destructive",
        });
        return;
      }

      setShowNewProjectDialog(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
      toast({
        title: "New project ready",
        description: "All previous transcripts and recordings were deleted.",
      });
    } catch (error) {
      toast({
        title: "Could not start a new project",
        description:
          error instanceof Error
            ? error.message
            : "The current project could not be deleted. Try again.",
        variant: "destructive",
      });
    } finally {
      setIsStartingNewProject(false);
    }
  };

  return (
    <>
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-sm">
                <Waves className="w-5 h-5 text-primary-foreground" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                Transcriber
              </h1>
            </Link>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-3">
            <button
              type="button"
              onClick={() => setShowNewProjectDialog(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <FilePlus2 className="w-4 h-4" />
              <span className="hidden sm:inline">Start new project</span>
              <span className="sm:hidden">New</span>
            </button>
            <button
              type="button"
              onClick={resetTranscriberPage}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted"
            >
              <XCircle className="w-4 h-4" />
              <span>Clear</span>
            </button>
            <Link
              href="/diagnostics"
              className={`inline-flex items-center gap-1.5 text-sm font-medium transition-colors ${
                location === "/diagnostics"
                  ? "text-primary"
                  : "text-foreground hover:text-primary"
              }`}
            >
              <Activity className="w-4 h-4" />
              <span className="hidden md:inline">Diagnostics</span>
            </Link>
          </div>
        </div>
      </header>

      <AlertDialog
        open={showNewProjectDialog}
        onOpenChange={(open) => {
          if (!isStartingNewProject) setShowNewProjectDialog(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a completely new project?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes every saved transcript, recording,
              processing item, and generated result. It also cancels the current
              upload. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isStartingNewProject}>
              Keep current project
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void startNewProject();
              }}
              disabled={isStartingNewProject}
              className="gap-2 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isStartingNewProject && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {isStartingNewProject
                ? "Deleting current project..."
                : "Delete everything and start new"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
