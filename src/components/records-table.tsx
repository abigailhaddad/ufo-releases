"use client";

import { Fragment, useMemo, useState } from "react";
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

function dvidsLink(id: string) {
  return id ? `https://www.dvidshub.net/video/${id}` : "";
}

function badgeVariant(type: string): "default" | "secondary" | "outline" {
  if (type === "VID") return "default";
  if (type === "IMG") return "secondary";
  return "outline";
}

export function RecordsTable({ records, agencies, types }: Props) {
  const [query, setQuery] = useState("");
  const [agency, setAgency] = useState<string>(ALL);
  const [type, setType] = useState<string>(ALL);
  const [showRemoved, setShowRemoved] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) => {
      if (!showRemoved && r.removedFromSource) return false;
      if (agency !== ALL && r.agency !== agency) return false;
      if (type !== ALL && r.type !== type) return false;
      if (!q) return true;
      const hay = [
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
      return hay.includes(q);
    });
  }, [records, query, agency, type, showRemoved]);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
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
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
            className="size-4"
          />
          Include removed
        </label>
      </div>

      <div className="text-sm text-muted-foreground">
        Showing {filtered.length.toLocaleString()} of {records.length.toLocaleString()} records
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
                          <div className="min-w-0 flex-1 space-y-2 text-sm">
                            {r.description ? (
                              <p className="whitespace-pre-line text-foreground/90">
                                {r.description}
                              </p>
                            ) : (
                              <p className="text-muted-foreground">No description provided.</p>
                            )}
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground md:grid-cols-4">
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
