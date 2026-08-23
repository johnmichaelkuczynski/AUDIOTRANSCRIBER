export const CLEAR_CURRENT_UPLOAD_EVENT =
  "transcriber:clear-current-upload";

const WORKSPACE_CLEARED_AT_KEY = "transcriber:workspace-cleared-at";

export function getWorkspaceClearedAt(): number {
  if (typeof window === "undefined") return 0;

  const stored = Number(window.localStorage.getItem(WORKSPACE_CLEARED_AT_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
}

export function wasCreatedAfterWorkspaceClear(createdAt: string): boolean {
  return new Date(createdAt).getTime() > getWorkspaceClearedAt();
}

export function resetTranscriberPage(): void {
  window.dispatchEvent(new Event(CLEAR_CURRENT_UPLOAD_EVENT));
  window.localStorage.setItem(WORKSPACE_CLEARED_AT_KEY, String(Date.now()));
  window.location.reload();
}
