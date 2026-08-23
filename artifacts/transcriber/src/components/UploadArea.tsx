import React, { useState, useCallback, useEffect, useRef } from "react";
import { getListTranscriptionsQueryKey, getGetTranscriptionStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { UploadCloud, FileAudio, Loader2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { uploadAudioFileInChunks } from "@/lib/chunkedUpload";

export function UploadArea() {
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isUploading = uploadProgress !== null;

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

  const handleFiles = async (files: FileList) => {
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

    if (file.size > 1024 * 1024 * 1024) {
      toast({
        title: "File is too large",
        description: "Please upload an audio file smaller than 1 GB.",
        variant: "destructive",
      });
      return;
    }

    setUploadProgress(0);
    const abortController = new AbortController();
    uploadAbortRef.current = abortController;
    try {
      await uploadAudioFileInChunks(
        file,
        setUploadProgress,
        abortController.signal,
      );
      toast({
        title: "Transcription started",
        description: "Two-minute intervals will appear below as each one finishes.",
      });
      queryClient.invalidateQueries({ queryKey: getListTranscriptionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTranscriptionStatsQueryKey() });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        toast({
          title: "Upload cleared",
          description: "The uploader is ready for another recording.",
        });
        return;
      }
      toast({
        title: "Upload failed",
        description:
          err instanceof Error
            ? err.message
            : "Failed to upload the file. Please try again.",
        variant: "destructive",
      });
    } finally {
      uploadAbortRef.current = null;
      setUploadProgress(null);
      const input = document.getElementById("file-upload") as HTMLInputElement | null;
      if (input) input.value = "";
    }
  };

  const clearCurrentUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    setUploadProgress(null);
    setIsDragging(false);
    const input = document.getElementById("file-upload") as HTMLInputElement | null;
    if (input) input.value = "";
  }, []);

  useEffect(() => {
    window.addEventListener("transcriber:clear-current-upload", clearCurrentUpload);
    return () => {
      window.removeEventListener(
        "transcriber:clear-current-upload",
        clearCurrentUpload,
      );
    };
  }, [clearCurrentUpload]);

  const handleClear = (event: React.MouseEvent) => {
    event.stopPropagation();
    clearCurrentUpload();
  };

  return (
    <div
      className={cn(
        "relative group flex flex-col items-center justify-center w-full h-64 p-8 border-2 border-dashed rounded-xl transition-all duration-300 ease-in-out cursor-pointer overflow-hidden",
        isDragging 
          ? "border-primary bg-primary/5 scale-[1.02]" 
          : "border-border bg-card hover:border-primary/50 hover:bg-card/80",
        isUploading && "pointer-events-none opacity-80"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => !isUploading && document.getElementById("file-upload")?.click()}
    >
      <input
        id="file-upload"
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.ogg"
        className="hidden"
        onChange={handleFileInput}
        disabled={isUploading}
      />
      
      {isUploading ? (
        <div className="flex flex-col items-center animate-in fade-in zoom-in duration-300">
          <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
          <p className="text-lg font-medium text-foreground">
            Uploading {uploadProgress}%
          </p>
          <div className="w-64 max-w-full h-2 rounded-full bg-muted mt-3 overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Sent in retryable 8 MB pieces
          </p>
          <button
            type="button"
            onClick={handleClear}
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <X className="w-4 h-4" />
            Clear
          </button>
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
            Supported formats: MP3, WAV, M4A, OGG · up to 1 GB
          </p>
        </div>
      )}
    </div>
  );
}
