import recordsData from "../../data/records.json";

export type RecordType = "PDF" | "VID" | "IMG" | string;

export type UfoRecord = {
  id: number;
  title: string;
  type: RecordType;
  agency: string;
  releaseDate: string;
  incidentDate: string;
  incidentLocation: string;
  description: string;
  fileUrl: string;
  thumbnailUrl: string;
  dvidsVideoId: string;
  videoTitle: string;
  videoPairing: string;
  pdfPairing: string;
  redaction: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  removedFromSource?: boolean;
};

export const records: UfoRecord[] = (recordsData as UfoRecord[]).map((r) => ({
  ...r,
  title: r.title.replace(/\s+/g, " ").trim(),
}));

export const agencies = Array.from(
  new Set(records.map((r) => r.agency).filter(Boolean))
).sort();

export const types = Array.from(
  new Set(records.map((r) => r.type).filter(Boolean))
).sort();

export const releaseDates = Array.from(
  new Set(records.map((r) => r.releaseDate).filter(Boolean))
).sort();
