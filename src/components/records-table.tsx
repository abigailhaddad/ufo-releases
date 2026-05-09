"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UfoRecord } from "@/lib/records";

type Props = {
  records: UfoRecord[];
  agencies: string[];
  types: string[];
};

const ALL = "__all__";
const SNIPPET_BEFORE = 80;
const SNIPPET_AFTER = 200;

function dvidsLink(id: string) {
  return id ? `https://www.dvidshub.net/video/${id}` : "";
}

function badgeVariant(type: string): "default" | "secondary" | "outline" {
  if (type === "VID") return "default";
  if (type === "IMG") return "secondary";
  return "outline";
}

type TextIndex = Record<string, string>;

function snippetAt(text: string, q: string): string | null {
  if (!q) return null;
  const idx = text.indexOf(q);
  if (idx < 0) return null;
  const start = Math.max(0, idx - SNIPPET_BEFORE);
  const end = Math.min(text.length, idx + q.length + SNIPPET_AFTER);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function RecordsTable({ records, agencies, types }: Props) {
  const [chips, setChips] = useState<string[]>([]);
  const [pending, setPending] = useState("");
  const [agency, setAgency] = useState<string>(ALL);
  const [type, setType] = useState<string>(ALL);
  const [showRemoved, setShowRemoved] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  // Always load the full-text search index in the background (~2 MB). Doesn't
  // block render; chip filters just don't match text bodies until it's ready.
  const [textIndex, setTextIndex] = useState<TextIndex | null>(null);
  const [recordTexts, setRecordTexts] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/text-index.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: TextIndex) => {
        if (!cancelled) setTextIndex(data);
      })
      .catch(() => {
        if (!cancelled) setTextIndex({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function addChip(raw: string) {
    const clean = raw.trim();
    if (!clean) return;
    setChips((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
    setPending("");
  }

  function removeChip(c: string) {
    setChips((prev) => prev.filter((x) => x !== c));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addChip(pending);
    } else if (e.key === "Backspace" && pending === "" && chips.length > 0) {
      removeChip(chips[chips.length - 1]);
    }
  }

  async function loadRecordText(id: number) {
    if (recordTexts[id] !== undefined) return;
    try {
      const r = await fetch(`/text/${id}.txt`);
      const text = r.ok ? await r.text() : "";
      setRecordTexts((prev) => ({ ...prev, [id]: text }));
    } catch {
      setRecordTexts((prev) => ({ ...prev, [id]: "" }));
    }
  }

  // Active terms = saved chips + whatever's currently in the input box, so
  // results update as you type without forcing Enter.
  const activeTerms = useMemo(() => {
    const live = pending.trim().toLowerCase();
    const saved = chips.map((c) => c.toLowerCase());
    return live ? [...saved, live] : saved;
  }, [chips, pending]);

  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (!showRemoved && r.removedFromSource) return false;
      if (agency !== ALL && r.agency !== agency) return false;
      if (type !== ALL && r.type !== type) return false;
      if (activeTerms.length === 0) return true;
      const metaHay = [
        r.title,
        r.description,
        r.agency,
        r.type,
        r.incidentLocation,
        r.incidentDate,
        r.videoTitle,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const fullText = textIndex ? textIndex[String(r.id)] : "";
      // Every chip must match somewhere — metadata OR full extracted text.
      return activeTerms.every(
        (term) => metaHay.includes(term) || (fullText && fullText.includes(term)),
      );
    });
  }, [records, activeTerms, agency, type, showRemoved, textIndex]);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        loadRecordText(id);
      }
      return next;
    });
  }

  // First active term used for snippet/highlight (whichever produced the match).
  const primaryTerm = activeTerms[0] ?? "";
  const hasRemovedRecords = useMemo(
    () => records.some((r) => r.removedFromSource),
    [records],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:flex-wrap">
        <div className="flex min-h-9 flex-1 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-xs md:max-w-2xl">
          {chips.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              {c}
              <button
                type="button"
                aria-label={`Remove ${c}`}
                onClick={() => removeChip(c)}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={pending}
            onChange={(e) => setPending(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => addChip(pending)}
            placeholder={
              chips.length === 0
                ? "Search — Enter or comma to add a term…"
                : "Add another term…"
            }
            className="flex-1 min-w-32 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Select value={agency} onValueChange={setAgency}>
          <SelectTrigger className="md:w-48">
            <SelectValue placeholder="Agency" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All agencies</SelectItem>
            {agencies.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="md:w-32">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasRemovedRecords ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showRemoved}
              onChange={(e) => setShowRemoved(e.target.checked)}
              className="size-4"
            />
            Include removed
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          Showing {filtered.length.toLocaleString()} of {records.length.toLocaleString()} records
          {textIndex === null ? " · loading text index…" : ""}
        </span>
        {activeTerms.length > 0 ? (
          <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
            Searches both metadata and extracted PDF text. Born-digital PDFs are exact (pdftotext); scans are AI-transcribed and may contain OCR errors — verify against the original PDF.
          </span>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[64px]">Type</TableHead>
              <TableHead className="w-[140px]">Agency</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-[110px]">Incident</TableHead>
              <TableHead className="w-[150px]">Location</TableHead>
              <TableHead className="w-[120px] text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => {
              const isVideo = r.type === "VID";
              const primary = isVideo ? dvidsLink(r.dvidsVideoId) : r.fileUrl;
              const isOpen = expanded.has(r.id);
              const hayText = textIndex ? textIndex[String(r.id)] : undefined;
              const matchSnippet =
                primaryTerm && hayText ? snippetAt(hayText, primaryTerm) : null;
              return (
                <Fragment key={r.id}>
                  <TableRow
                    onClick={() => toggle(r.id)}
                    className={`cursor-pointer ${r.removedFromSource ? "opacity-60" : ""}`}
                  >
                    <TableCell>
                      <Badge variant={badgeVariant(r.type)}>{r.type || "—"}</Badge>
                    </TableCell>
                    <TableCell className="truncate text-sm">
                      {highlightTerms(r.agency || "—", activeTerms)}
                    </TableCell>
                    <TableCell>
                      <div className="truncate font-medium" title={r.title}>
                        {highlightTerms(r.title || "(untitled)", activeTerms)}
                      </div>
                      {matchSnippet ? (
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          <span className="font-mono">
                            {highlightTerms(matchSnippet, activeTerms)}
                          </span>
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="truncate text-sm">
                      {highlightTerms(r.incidentDate || "—", activeTerms)}
                    </TableCell>
                    <TableCell className="truncate text-sm">
                      {highlightTerms(r.incidentLocation || "—", activeTerms)}
                    </TableCell>
                    <TableCell className="text-right">
                      {primary ? (
                        <a
                          href={primary}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-sm font-medium underline underline-offset-4 hover:text-foreground/80"
                        >
                          {isVideo ? "Watch ↗" : "Open ↗"}
                        </a>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                  {isOpen ? (
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={6} className="max-w-0 overflow-hidden whitespace-normal py-4 align-top">
                        <div className="flex w-full max-w-full flex-col gap-4 overflow-hidden md:flex-row">
                          {r.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={r.thumbnailUrl}
                              alt=""
                              className="h-40 w-40 shrink-0 rounded border object-cover"
                              loading="lazy"
                            />
                          ) : null}
                          <div className="min-w-0 max-w-full flex-1 space-y-3 overflow-hidden text-sm">
                            {r.description ? (
                              <p className="whitespace-pre-line text-foreground/90">
                                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  Description (from war.gov CSV)
                                </span>
                                {highlightTerms(r.description, activeTerms)}
                              </p>
                            ) : (
                              <p className="text-muted-foreground">No description provided.</p>
                            )}
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground md:grid-cols-4">
                              <div>
                                <dt className="font-medium text-foreground">Released</dt>
                                <dd>{r.releaseDate || "—"}</dd>
                              </div>
                              <div>
                                <dt className="font-medium text-foreground">Incident</dt>
                                <dd>{r.incidentDate || "—"}</dd>
                              </div>
                              <div>
                                <dt className="font-medium text-foreground">Location</dt>
                                <dd>{r.incidentLocation || "—"}</dd>
                              </div>
                              <div>
                                <dt className="font-medium text-foreground">Agency</dt>
                                <dd>{r.agency || "—"}</dd>
                              </div>
                            </dl>
                            <ExtractedText
                              record={r}
                              text={recordTexts[r.id]}
                              terms={activeTerms}
                            />
                            {r.removedFromSource ? (
                              <p className="text-xs text-amber-600">
                                No longer listed on war.gov (last seen {r.lastSeenAt ?? "—"})
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  No records match your filters.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ExtractedText({
  record,
  text,
  terms,
}: {
  record: UfoRecord;
  text: string | undefined;
  terms: string[];
}) {
  const [showAll, setShowAll] = useState(false);

  if (!record.textChars) {
    return (
      <p className="rounded border border-dashed p-2 text-xs text-muted-foreground">
        Extracted text not available yet for this record.
      </p>
    );
  }

  if (text === undefined) {
    return <p className="text-xs text-muted-foreground">Loading extracted text…</p>;
  }
  if (!text) {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn&apos;t load /text/{record.id}.txt.
      </p>
    );
  }

  const lowerText = text.toLowerCase();
  const hasMatch = terms.some((t) => lowerText.includes(t));
  const truncated = !showAll && text.length > 4000;
  const display = truncated ? text.slice(0, 4000) : text;

  const isPdftotext = record.extractionModel === "pdftotext";
  const heading = isPdftotext ? "Extracted text (pdftotext)" : "AI-transcribed text";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {heading}
          <span className="ml-2 font-normal lowercase">
            {record.extractionPages ?? 0}p · {record.textChars.toLocaleString()} chars · {record.extractionModel ?? "—"}
          </span>
        </p>
        <a
          href={`/text/${record.id}.txt`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-xs underline underline-offset-2 hover:text-foreground"
        >
          raw .txt ↗
        </a>
      </div>
      {isPdftotext ? (
        <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900">
          Extracted directly from the PDF&apos;s embedded text layer (born-digital file). Exact, no OCR involved.
        </p>
      ) : (
        <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          Generated by a multimodal model from page images. Treat as an aid for browsing and search,
          not as authoritative — handwriting, stamps, and faded scans frequently produce errors.
          Verify anything important against the original PDF (linked above).
        </p>
      )}
      <pre className="max-h-80 max-w-full overflow-auto break-words whitespace-pre-wrap rounded border bg-background p-3 font-mono text-xs leading-relaxed">
        {hasMatch ? highlightTerms(display, terms) : display}
      </pre>
      {truncated ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowAll(true);
          }}
          className="text-xs underline underline-offset-2 hover:text-foreground"
        >
          show all {text.length.toLocaleString()} chars
        </button>
      ) : null}
    </div>
  );
}

// Highlight every occurrence of any term (case-insensitive) by wrapping in
// <mark>. Returns the original string if no terms hit (cheap fast-path).
export function highlightTerms(
  text: string,
  terms: string[] | string,
): React.ReactNode {
  const list = (Array.isArray(terms) ? terms : [terms])
    .map((t) => t.trim())
    .filter(Boolean);
  if (list.length === 0 || !text) return text;
  const lower = text.toLowerCase();
  // Find the first matching term at each position; greedy left-to-right.
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    let earliest: { at: number; len: number } | null = null;
    for (const t of list) {
      const lo = t.toLowerCase();
      const at = lower.indexOf(lo, i);
      if (at < 0) continue;
      if (!earliest || at < earliest.at) earliest = { at, len: lo.length };
    }
    if (!earliest) {
      out.push(text.slice(i));
      break;
    }
    if (earliest.at > i) out.push(text.slice(i, earliest.at));
    out.push(
      <mark key={key++} className="bg-yellow-200 text-foreground">
        {text.slice(earliest.at, earliest.at + earliest.len)}
      </mark>,
    );
    i = earliest.at + earliest.len;
  }
  return out;
}

