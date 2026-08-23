export const CLEAR_CURRENT_UPLOAD_EVENT =
  "transcriber:clear-current-upload";

export function resetTranscriberPage(): void {
  window.dispatchEvent(new Event(CLEAR_CURRENT_UPLOAD_EVENT));
  window.location.reload();
}