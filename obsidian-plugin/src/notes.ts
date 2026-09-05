import { App, TFile } from "obsidian";

/**
 * Indexes vault notes by their Zotero identifiers (frontmatter `zotero-key` and
 * `citekey`), so citation completions can link to an existing literature note
 * (bidirectional wikilink) instead of only linking out to Zotero. ZotLit-made
 * notes, hand-made notes, and Obzo-made notes are all matched the same way.
 */
export class NoteIndex {
  private byZoteroKey = new Map<string, TFile>();
  private byCitekey = new Map<string, TFile>();

  constructor(
    private app: App,
    private keys: () => { citekeyProp: string; zoteroKeyProp: string }
  ) {}

  /** Rebuild the whole index from current frontmatter. */
  rebuild(): void {
    this.byZoteroKey.clear();
    this.byCitekey.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.indexFile(file);
    }
  }

  /** (Re)index a single file. */
  indexFile(file: TFile): void {
    const { citekeyProp, zoteroKeyProp } = this.keys();
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return;
    const zk = normStr(fm[zoteroKeyProp]);
    const ck = normStr(fm[citekeyProp]);
    if (zk) this.byZoteroKey.set(zk, file);
    if (ck) this.byCitekey.set(ck.toLowerCase(), file);
  }

  /** Find the note for an item, preferring the (always-available) Zotero key. */
  lookup(zoteroKey?: string | null, citekey?: string | null): TFile | null {
    if (zoteroKey && this.byZoteroKey.has(zoteroKey)) {
      return this.byZoteroKey.get(zoteroKey)!;
    }
    if (citekey && this.byCitekey.has(citekey.toLowerCase())) {
      return this.byCitekey.get(citekey.toLowerCase())!;
    }
    return null;
  }
}

function normStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
