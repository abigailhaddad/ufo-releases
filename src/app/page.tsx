import { RecordsTable } from "@/components/records-table";
import { agencies, records, types } from "@/lib/records";

export default function Home() {
  const totalActive = records.filter((r) => !r.removedFromSource).length;
  const totalRemoved = records.length - totalActive;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 md:px-6 md:py-14">
      <header className="mb-8 space-y-3">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          Unofficial mirror — for browsing convenience only
        </p>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          UAP / UFO releases — searchable index
        </h1>
        <p className="max-w-3xl text-muted-foreground">
          The U.S. Department of War published declassified UAP records at{" "}
          <a
            href="https://www.war.gov/UFO/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            war.gov/UFO
          </a>
          . This page mirrors their record index — {totalActive.toLocaleString()} records across{" "}
          {agencies.length} agencies — in a sortable, searchable table. All file links point to
          the original government-hosted files. Refreshed daily from the source CSV.
          {totalRemoved > 0
            ? ` ${totalRemoved.toLocaleString()} additional records that have since been removed from war.gov are kept here for the record (toggle the checkbox to see them).`
            : ""}
        </p>
      </header>

      <RecordsTable records={records} agencies={agencies} types={types} />

      <footer className="mt-12 border-t pt-6 text-xs text-muted-foreground">
        <p>
          Built by an unaffiliated third party. Records and files are sourced from{" "}
          <a
            href="https://www.war.gov/UFO/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            war.gov/UFO
          </a>
          . Source data is the public CSV at{" "}
          <code className="rounded bg-muted px-1 py-0.5">
            /Portals/1/Interactive/2026/UFO/uap-csv.csv
          </code>
          .
        </p>
      </footer>
    </main>
  );
}
