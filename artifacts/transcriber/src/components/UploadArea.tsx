import React, { useState, useCallback } from "react";
import { useCreateTranscription, getListTranscriptionsQueryKey, getGetTranscriptionStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { UploadCloud, FileAudio, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export function UploadArea() {
  const [isDragging, setIsDragging] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const createTranscription = useCreateTranscription({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Transcription started",
          description: "Your file is being processed. It will appear below shortly.",
        });
        queryClient.invalidateQueries({ queryKey: getListTranscriptionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTranscriptionStatsQueryKey() });
      },
      onError: (err) => {
        toast({
          title: "Upload failed",
          description: err?.data?.error || "Failed to upload the file. Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  }, []);

  const handleFiles = (files: FileList) => {
    const file = files[0];
    if (!file) return;

    if (!file.type.startsWith("audio/") && !file.name.match(/\.(mp3|wav|m4a|ogg)$/i)) {
      toast({
        title: "Invalid file type",
        description: "Please upload an audio file (MP3, WAV, M4A, OGG).",
        variant: "destructive",
      });
      return;
    }

    createTranscription.mutate({ data: { file } });
  };

  return (
    <div
      className={cn(
        "relative group flex flex-col items-center justify-center w-full h-64 p-8 border-2 border-dashed rounded-xl transition-all duration-300 ease-in-out cursor-pointer overflow-hidden",
        isDragging 
          ? "border-primary bg-primary/5 scale-[1.02]" 
          : "border-border bg-card hover:border-primary/50 hover:bg-card/80",
        createTranscription.isPending && "pointer-events-none opacity-80"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => !createTranscription.isPending && document.getElementById("file-upload")?.click()}
    >
      <input
        id="file-upload"
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.ogg"
        className="hidden"
        onChange={handleFileInput}
        disabled={createTranscription.isPending}
      />
      
      {createTranscription.isPending ? (
        <div className="flex flex-col items-center animate-in fade-in zoom-in duration-300">
          <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
          <p className="text-lg font-medium text-foreground">Uploading & Processing</p>
          <p className="text-sm text-muted-foreground mt-1">This might take a moment...</p>
        </div>
      ) : (
        <div className="flex flex-col items-center animate-in fade-in zoom-in duration-300">
          <div className="w-16 h-16 rounded-full bg-accent/50 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
            {isDragging ? (
              <FileAudio className="w-8 h-8 text-primary" />
            ) : (
              <UploadCloud className="w-8 h-8 text-primary" />
            )}
          </div>
          <p className="text-lg font-semibold text-foreground mb-1">
            {isDragging ? "Drop audio file here" : "Click or drag to upload"}
          </p>
          <p className="text-sm text-muted-foreground max-w-xs text-center">
            Supported formats: MP3, WAV, M4A, OGG
          </p>
        </div>
      )}
    </div>
  );
}
