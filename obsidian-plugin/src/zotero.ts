import { requestUrl, RequestUrlResponse } from "obsidian";

/** Metadata for the parent bibliographic item (the paper). */
export interface ZoteroCreator {
  firstName: string;
  lastName: string;
  creatorType?: string | null;
}

export interface ZoteroItem {
  key: string;
  libraryID: number;
  itemType: string | null;
  title: string | null;
  date: string | null;
  DOI: string | null;
  url: string | null;
  publicationTitle: string | null;
  abstractNote: string | null;
  creators: ZoteroCreator[];
  citationKey: string | null;
}

export interface ZoteroAttachment {
  key: string;
  libraryID: number;
  contentType: string | null;
  filename: string | null;
  path: string | null;
}

/** Response shape of GET /obzo/current from the Zotero companion plugin. */
export interface CurrentReading {
  open: boolean;
  source?: string;
  reason?: string;
  page?: number | null;
  item: ZoteroItem | null;
  attachment: ZoteroAttachment | null;
}

/** A single hit from a Zotero library search (for citation autocomplete). */
export interface ZoteroSearchHit {
  key: string;
  itemType: string;
  title: string;
  date: string | null;
  creators: ZoteroCreator[];
  citationKey: string | null;
}

const ALLOW_HEADER = { "Zotero-Allowed-Request": "true" };

/** Result of a long-poll wait for the active-tab-changed signal. */
export type WaitResult =
  | { ok: true; reading: CurrentReading | null }
  | { ok: false; unsupported: boolean };

/**
 * Talks to the local Zotero process: the Obzo Bridge endpoints (/obzo/*)
 * and Zotero's built-in local API (/api/*). The local API accepts the "0"
 * user alias, so no userID configuration is required.
 */
export class ZoteroBridge {
  constructor(private port: number) {}

  setPort(port: number) {
    this.port = port;
  }

  private base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async get(path: string): Promise<RequestUrlResponse | null> {
    try {
      return await requestUrl({
        url: `${this.base()}${path}`,
        method: "GET",
        headers: ALLOW_HEADER,
        throw: false,
      });
    } catch {
      return null;
    }
  }

  /** Is the Obzo Bridge companion plugin installed and responding? */
  async ping(): Promise<boolean> {
    const res = await this.get("/obzo/ping");
    return !!res && res.status === 200 && res.json?.ok === true;
  }

  /** What is open in the active Zotero reader tab right now? */
  async current(): Promise<CurrentReading | null> {
    const res = await this.get("/obzo/current");
    if (!res || res.status !== 200) return null;
    return res.json as CurrentReading;
  }

  /**
   * Long-poll: resolves when Zotero's active tab changes (pushed by the
   * bridge), or after the bridge's ~25s heartbeat. `unsupported` is true when
   * the installed bridge predates /obzo/wait, so the client can fall back to
   * timer polling.
   */
  async waitForChange(): Promise<WaitResult> {
    const res = await this.get("/obzo/wait");
    if (!res) return { ok: false, unsupported: false };
    if (res.status === 404) return { ok: false, unsupported: true };
    if (res.status !== 200) return { ok: false, unsupported: false };
    return { ok: true, reading: res.json as CurrentReading };
  }

  /** Full extracted text of a PDF attachment (from Zotero's fulltext index). */
  async fulltext(attachmentKey: string): Promise<string | null> {
    const res = await this.get(`/api/users/0/items/${attachmentKey}/fulltext`);
    if (!res || res.status !== 200) return null;
    const content = (res.json as { content?: string })?.content;
    return typeof content === "string" ? content : null;
  }

  /** Search the library for citation candidates. */
  async searchLibrary(query: string, limit = 20): Promise<ZoteroSearchHit[]> {
    const q = encodeURIComponent(query);
    const res = await this.get(
      `/api/users/0/items/top?q=${q}&qmode=titleCreatorYear&limit=${limit}`
    );
    if (!res || res.status !== 200) return [];
    const rows = (res.json as any[]) || [];
    return rows
      .map(mapSearchHit)
      .filter((h) => h.itemType !== "attachment" && h.itemType !== "note");
  }
}

function mapSearchHit(row: any): ZoteroSearchHit {
  const d = row?.data ?? {};
  return {
    key: d.key ?? row?.key ?? "",
    itemType: d.itemType ?? "",
    title: d.title ?? d.caseName ?? d.subject ?? "(untitled)",
    date: d.date ?? null,
    creators: Array.isArray(d.creators)
      ? d.creators.map((c: any) => ({
          firstName: c.firstName ?? "",
          lastName: c.lastName ?? c.name ?? "",
          creatorType: c.creatorType ?? null,
        }))
      : [],
    citationKey: row?.meta?.citationKey ?? null,
  };
}

const CITEKEY_STOP = new Set([
  "the", "and", "for", "with", "from", "into", "using", "toward", "towards",
  "based", "via", "over", "under", "study", "analysis", "approach", "model",
  "models", "method", "methods", "data", "case", "new", "novel",
]);

/** Deterministic authorYearWord citekey when Better BibTeX isn't available. */
export function generateCiteKey(
  item: { creators?: ZoteroCreator[]; date?: string | null; title?: string | null }
): string {
  const author =
    item.creators?.find((c) => c.creatorType === "author") ??
    item.creators?.[0];
  const last = (author?.lastName || author?.firstName || "anon")
    .toLowerCase()
    .replace(/[^a-z]/g, "") || "anon";
  const year = item.date?.match(/\d{4}/)?.[0] ?? "nd";
  const word =
    (item.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .find((w) => w.length > 3 && !CITEKEY_STOP.has(w)) ?? "";
  return `${last}${year}${word}`;
}

/** A short, human-readable label for the item currently being read. */
export function itemLabel(reading: CurrentReading | null): string {
  if (!reading || !reading.item) return "no paper";
  const it = reading.item;
  const first = it.creators?.[0];
  const author = first ? first.lastName || first.firstName : "";
  const year = it.date ? it.date.match(/\d{4}/)?.[0] ?? "" : "";
  const title = it.title ?? "untitled";
  const short = title.length > 40 ? title.slice(0, 39) + "…" : title;
  const cite = [author, year].filter(Boolean).join(" ");
  return cite ? `${cite} — ${short}` : short;
}

/** authors + year, for a citation suggestion's detail line. */
export function creatorSummary(hit: ZoteroSearchHit): string {
  const names = hit.creators
    .filter((c) => !c.creatorType || c.creatorType === "author")
    .map((c) => c.lastName || c.firstName)
    .filter(Boolean);
  let who = "";
  if (names.length === 1) who = names[0];
  else if (names.length === 2) who = `${names[0]} & ${names[1]}`;
  else if (names.length > 2) who = `${names[0]} et al.`;
  const year = hit.date?.match(/\d{4}/)?.[0] ?? "";
  return [who, year].filter(Boolean).join(", ");
}
