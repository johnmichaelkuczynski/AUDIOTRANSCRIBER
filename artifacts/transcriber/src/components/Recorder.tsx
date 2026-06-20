import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  useCreateTranscription,
  getListTranscriptionsQueryKey,
  getGetTranscriptionStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Mic, Square, Loader2, Trash2, Download, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type RecorderState = "idle" | "recording" | "recorded";

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  if (typeof MediaRecorder !== "undefined") {
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
  }
  return "";
}

function extForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Recorder() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [state, setState] = useState<RecorderState>("idle");
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordedBlobRef = useRef<Blob | null>(null);
  const autoTranscribeRef = useRef(autoTranscribe);
  const audioUrlRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const finalizedRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    autoTranscribeRef.current = autoTranscribe;
  }, [autoTranscribe]);

  const createTranscription = useCreateTranscription({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Transcription started",
          description: "Your recording is being processed. It will appear below shortly.",
        });
        queryClient.invalidateQueries({ queryKey: getListTranscriptionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTranscriptionStatsQueryKey() });
        resetRecording();
      },
      onError: (err) => {
        toast({
          title: "Transcription failed",
          description: err?.error || "Could not transcribe the recording. Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const setAudioUrlTracked = useCallback((url: string | null) => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = url;
    setAudioUrl(url);
  }, []);

  const resetRecording = useCallback(() => {
    setState("idle");
    setElapsed(0);
    recordedBlobRef.current = null;
    setAudioUrlTracked(null);
  }, [setAudioUrlTracked]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stopTimer();
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // ignore
          }
        }
        mediaRecorderRef.current = null;
      }
      releaseStream();
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, [stopTimer, releaseStream]);

  const transcribeBlob = useCallback(
    (blob: Blob) => {
      const ext = extForMime(mimeRef.current || blob.type);
      const filename = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
      const file = new File([blob], filename, { type: blob.type || mimeRef.current });
      createTranscription.mutate({ data: { file } });
    },
    [createTranscription],
  );

  const finalizeRecording = useCallback(() => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;

    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    stopTimer();
    releaseStream();

    if (disposedRef.current) return;

    const blob = new Blob(chunksRef.current, {
      type: mimeRef.current || "audio/webm",
    });
    recordedBlobRef.current = blob;

    if (blob.size === 0) {
      setState("idle");
      setElapsed(0);
      toast({
        title: "No audio captured",
        description:
          "The recording came back empty. Please check your microphone and try again.",
        variant: "destructive",
      });
      return;
    }

    if (autoTranscribeRef.current) {
      setState("idle");
      setElapsed(0);
      transcribeBlob(blob);
    } else {
      setAudioUrlTracked(URL.createObjectURL(blob));
      setState("recorded");
    }
  }, [stopTimer, releaseStream, transcribeBlob, setAudioUrlTracked, toast]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast({
        title: "Recording not supported",
        description: "Your browser does not support audio recording.",
        variant: "destructive",
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mime = pickMimeType();
      mimeRef.current = mime;
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      finalizedRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        finalizeRecording();
      };

      recorder.onerror = () => {
        finalizeRecording();
      };

      // Collect data in 1s chunks so audio accumulates during the recording
      // (and survives even if the final `onstop` event is unreliable).
      recorder.start(1000);
      setState("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch (err) {
      releaseStream();
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      toast({
        title: denied ? "Microphone access denied" : "Could not start recording",
        description: denied
          ? "Please allow microphone access in your browser to record."
          : "Something went wrong while accessing your microphone.",
        variant: "destructive",
      });
    }
  }, [toast, finalizeRecording]);

  const stopRecording = useCallback(() => {
    stopTimer();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.requestData();
      } catch {
        // not supported in all browsers; ignore
      }
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }
    // Fallback: if `onstop` never fires (some browsers/iframes are flaky),
    // finalize from the chunks we already collected via the 1s timeslice.
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = setTimeout(() => {
      finalizeRecording();
    }, 700);
  }, [stopTimer, finalizeRecording]);

  const handleDownload = useCallback(() => {
    const blob = recordedBlobRef.current;
    if (!blob) return;
    const ext = extForMime(mimeRef.current || blob.type);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleTranscribeSaved = useCallback(() => {
    const blob = recordedBlobRef.current;
    if (!blob) return;
    transcribeBlob(blob);
  }, [transcribeBlob]);

  const isUploading = createTranscription.isPending;

  return (
    <div className="w-full rounded-xl border border-border bg-card p-6">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-accent/50 flex items-center justify-center">
            <Mic className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="font-semibold text-foreground leading-tight">Record audio</p>
            <p className="text-sm text-muted-foreground leading-tight">
              Dictate directly into the app
            </p>
          </div>
        </div>
        {state === "idle" && (
          <div className="flex items-center gap-2">
            <Switch
              id="auto-transcribe"
              checked={autoTranscribe}
              onCheckedChange={setAutoTranscribe}
            />
            <Label htmlFor="auto-transcribe" className="text-sm text-muted-foreground cursor-pointer">
              Transcribe on stop
            </Label>
          </div>
        )}
      </div>

      {isUploading ? (
        <div className="flex flex-col items-center justify-center py-8">
          <Loader2 className="w-10 h-10 text-primary animate-spin mb-3" />
          <p className="font-medium text-foreground">Uploading & Processing</p>
          <p className="text-sm text-muted-foreground mt-1">This might take a moment...</p>
        </div>
      ) : state === "idle" ? (
        <button
          type="button"
          onClick={startRecording}
          className="group flex flex-col items-center justify-center w-full py-8 rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-accent/30 transition-all duration-300"
        >
          <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center mb-4 shadow-sm group-hover:scale-110 transition-transform duration-300">
            <Mic className="w-7 h-7 text-primary-foreground" />
          </div>
          <p className="font-semibold text-foreground">Start recording</p>
          <p className="text-sm text-muted-foreground mt-1">
            {autoTranscribe
              ? "Transcribes automatically when you stop"
              : "Review and transcribe when you're ready"}
          </p>
        </button>
      ) : state === "recording" ? (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="relative mb-4">
            <span className="absolute inset-0 rounded-full bg-destructive/30 animate-ping" />
            <div className="relative w-16 h-16 rounded-full bg-destructive flex items-center justify-center">
              <Mic className="w-7 h-7 text-white" />
            </div>
          </div>
          <p className="text-2xl font-bold tabular-nums text-foreground">
            {formatDuration(elapsed)}
          </p>
          <p className="text-sm text-muted-foreground mt-1 mb-5">Recording...</p>
          <Button onClick={stopRecording} variant="destructive" size="lg">
            <Square className="w-4 h-4 mr-2 fill-current" />
            Stop
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-2">
          {audioUrl && (
            <audio controls src={audioUrl} className="w-full max-w-md">
              Your browser does not support audio playback.
            </audio>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={handleTranscribeSaved} className="gap-2">
              <Sparkles className="w-4 h-4" />
              Transcribe
            </Button>
            <Button onClick={handleDownload} variant="outline" className="gap-2">
              <Download className="w-4 h-4" />
              Save recording
            </Button>
            <Button onClick={resetRecording} variant="ghost" className="gap-2 text-muted-foreground">
              <Trash2 className="w-4 h-4" />
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
