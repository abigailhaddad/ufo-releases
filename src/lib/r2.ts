import type { UfoRecord } from "./records";

export const R2_BASE = "https://pub-a5fc1ae0b89944dba0ab60286076ab1e.r2.dev";

/** Returns the R2 mirror URL for a record's source file (PDF/IMG/VID), or "". */
export function r2SourceUrl(r: UfoRecord): string {
  if (!r.fileUrl && !r.dvidsVideoId) return "";
  if (r.type === "PDF") return `${R2_BASE}/pdfs/${r.id}.pdf`;
  if (r.type === "IMG" && r.fileUrl) {
    const ext = r.fileUrl.split("?")[0].split(".").pop() || "png";
    return `${R2_BASE}/media/${r.id}.${ext.toLowerCase()}`;
  }
  if (r.type === "VID" && r.dvidsVideoId) {
    return `${R2_BASE}/media/${r.id}.mp4`;
  }
  return "";
}

/** Returns the R2 URL for the AI-transcribed text file, or "" if none. */
export function r2TextUrl(r: UfoRecord): string {
  return r.extractionModel ? `${R2_BASE}/text/${r.id}.txt` : "";
}
