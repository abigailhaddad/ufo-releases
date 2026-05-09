import Link from "next/link";
import { records } from "@/lib/records";
import { R2_BASE, r2SourceUrl, r2TextUrl } from "@/lib/r2";

export const metadata = {
  title: "R2 mirror — UAP / UFO releases",
  description:
    "Public Cloudflare R2 mirror of every PDF, image, and video referenced by war.gov/UFO.",
};

type Group = { label: string; records: typeof records };

export default function MirrorIndex() {
  const live = records.filter((r) => !r.removedFromSource);
  const groups: Group[] = [
    { label: "PDFs", records: live.filter((r) => r.type === "PDF") },
    { label: "Images", records: live.filter((r) => r.type === "IMG") },
    { label: "Videos (DVIDS source)", records: live.filter((r) => r.type === "VID") },
  ];
  const totalText = live.filter((r) => r.extractionModel).length;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 md:px-6 md:py-14">
      <header className="mb-8 space-y-3">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          Public file mirror
        </p>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          R2 mirror — every file in one place
        </h1>
        <p className="max-w-3xl text-muted-foreground">
          Every PDF, image, and DVIDS video referenced by{" "}
          <a
            href="https://www.war.gov/UFO/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            war.gov/UFO
          </a>{" "}
          is mirrored to a public Cloudflare R2 bucket so the archive survives if the source rotates them.{" "}
          {totalText.toLocaleString()} records also have AI-transcribed text.
        </p>
        <p className="text-sm text-muted-foreground">
          Bucket root:{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{R2_BASE}</code>{" "}
          (R2 doesn&apos;t serve directory listings — use the per-file links below).{" "}
          <Link href="/" className="underline underline-offset-4 hover:text-foreground">
            ← back to the searchable index
          </Link>
        </p>
      </header>

      {groups.map((g) => (
        <section key={g.label} className="mb-10">
          <h2 className="mb-3 text-lg font-semibold">
            {g.label}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              ({g.records.length})
            </span>
          </h2>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 w-[64px]">ID</th>
                  <th className="px-3 py-2 w-[120px]">Agency</th>
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2 w-[110px] text-right">R2 mirror</th>
                  <th className="px-3 py-2 w-[110px] text-right">Text</th>
                  <th className="px-3 py-2 w-[110px] text-right">Original</th>
                </tr>
              </thead>
              <tbody>
                {g.records.map((r) => {
                  const r2Source = r2SourceUrl(r);
                  const r2Text = r2TextUrl(r);
                  const original =
                    r.type === "VID" && r.dvidsVideoId
                      ? `https://www.dvidshub.net/video/${r.dvidsVideoId}`
                      : r.fileUrl;
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                      <td className="px-3 py-2 text-xs">{r.agency}</td>
                      <td className="px-3 py-2">{r.title}</td>
                      <td className="px-3 py-2 text-right">
                        {r2Source ? (
                          <a
                            href={r2Source}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs underline underline-offset-4 hover:text-foreground"
                          >
                            R2 ↗
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r2Text ? (
                          <a
                            href={r2Text}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs underline underline-offset-4 hover:text-foreground"
                          >
                            .txt ↗
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {original ? (
                          <a
                            href={original}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs underline underline-offset-4 hover:text-foreground"
                          >
                            source ↗
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </main>
  );
}
