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
  const [query, setQuery] = useState("");
  const [agency, setAgency] = useState<string>(ALL);
  const [type, setType] = useState<string>(ALL);
  const [showRemoved, setShowRemoved] = useState(false);
  const [searchFullText, setSearchFullText] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  // Lazy-fetched on-demand
  const [textIndex, setTextIndex] = useState<TextIndex | null>(null);
  const [textIndexLoading, setTextIndexLoading] = useState(false);
  const [recordTexts, setRecordTexts] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!searchFullText || textIndex || textIndexLoading) return;
    setTextIndexLoading(true);
    fetch("/text-index.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: TextIndex) => setTextIndex(data))
      .catch(() => setTextIndex({}))
      .finally(() => setTextIndexLoading(false));
  }, [searchFullText, textIndex, textIndexLoading]);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) => {
      if (!showRemoved && r.removedFromSource) return false;
      if (agency !== ALL && r.agency !== agency) return false;
      if (type !== ALL && r.type !== type) return false;
      if (!q) return true;
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
      if (metaHay.includes(q)) return true;
      if (searchFullText && textIndex) {
        const t = textIndex[String(r.id)];
        if (t && t.includes(q)) return true;
      }
      return false;
    });
  }, [records, query, agency, type, showRemoved, searchFullText, textIndex]);

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

  const q = query.trim().toLowerCase();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:flex-wrap">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, description, location…"
          className="md:max-w-sm"
        />
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
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={searchFullText}
            onChange={(e) => setSearchFullText(e.target.checked)}
            className="size-4"
          />
          Search full PDF text {textIndexLoading ? "(loading…)" : ""}
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
            className="size-4"
          />
          Include removed
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          Showing {filtered.length.toLocaleString()} of {records.length.toLocaleString()} records
        </span>
        {searchFullText ? (
          <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
            Full-text search uses AI-transcribed PDF text — may include errors. Always verify the original PDF.
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
              const hayText =
                searchFullText && textIndex ? textIndex[String(r.id)] : undefined;
              const matchSnippet =
                searchFullText && q && hayText ? snippetAt(hayText, q) : null;
              return (
                <Fragment key={r.id}>
                  <TableRow
                    onClick={() => toggle(r.id)}
                    className={`cursor-pointer ${r.removedFromSource ? "opacity-60" : ""}`}
                  >
                    <TableCell>
                      <Badge variant={badgeVariant(r.type)}>{r.type || "—"}</Badge>
                    </TableCell>
                    <TableCell className="truncate text-sm">{r.agency || "—"}</TableCell>
                    <TableCell>
                      <div className="truncate font-medium" title={r.title}>
                        {r.title || "(untitled)"}
                      </div>
                      {matchSnippet ? (
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          <span className="font-mono">{matchSnippet}</span>
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="truncate text-sm">
                      {r.incidentDate || "—"}
                    </TableCell>
                    <TableCell className="truncate text-sm">
                      {r.incidentLocation || "—"}
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
                      <TableCell colSpan={6} className="py-4">
                        <div className="flex flex-col gap-4 md:flex-row">
                          {r.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={r.thumbnailUrl}
                              alt=""
                              className="h-40 w-40 shrink-0 rounded border object-cover"
                              loading="lazy"
                            />
                          ) : null}
                          <div className="min-w-0 flex-1 space-y-3 text-sm">
                            {r.description ? (
                              <p className="whitespace-pre-line text-foreground/90">
                                {r.description}
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
                              query={q}
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
  query,
}: {
  record: UfoRecord;
  text: string | undefined;
  query: string;
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

  const hasQuery = query.length > 0 && text.toLowerCase().includes(query);
  const truncated = !showAll && text.length > 4000;
  const display = truncated ? text.slice(0, 4000) : text;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          AI-transcribed text
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
      <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
        Generated by a multimodal model from page images. Treat as an aid for browsing and search,
        not as authoritative — handwriting, stamps, and faded scans frequently produce errors.
        Verify anything important against the original PDF (linked above).
      </p>
      <pre className="max-h-80 overflow-auto rounded border bg-background p-3 text-xs leading-relaxed whitespace-pre-wrap font-mono">
        {hasQuery ? highlight(display, query) : display}
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

function highlight(text: string, query: string) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const found = lower.indexOf(q, i);
    if (found < 0) {
      out.push(text.slice(i));
      break;
    }
    if (found > i) out.push(text.slice(i, found));
    out.push(
      <mark key={key++} className="bg-yellow-200 text-foreground">
        {text.slice(found, found + q.length)}
      </mark>,
    );
    i = found + q.length;
  }
  return out;
}
