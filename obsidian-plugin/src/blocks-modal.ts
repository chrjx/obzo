import { App, Editor, SuggestModal } from "obsidian";

/** A block result surfaced by the importer. */
export interface BlockHit {
  heading: string | null;
  text: string;
  page: number | null;
}

/**
 * "Import block…" — type a phrase (or a concept) and get the paper's matching
 * paragraph(s) with their equations, ranked semantically (Voyage) when a key is
 * set, else lexically. Selecting one inserts it into the note you came from.
 */
export class BlockImportModal extends SuggestModal<BlockHit> {
  private token = 0;
  private last: BlockHit[] = [];

  constructor(
    app: App,
    private editor: Editor,
    private search: (q: string) => Promise<BlockHit[]>,
    private insert: (hit: BlockHit, editor: Editor) => void
  ) {
    super(app);
    this.setPlaceholder("Import block: type a phrase or concept (e.g. profit maximization)…");
  }

  async getSuggestions(query: string): Promise<BlockHit[]> {
    // Debounce: only the latest keystroke's search runs; superseded calls
    // return the previous results rather than hanging or flickering.
    const mine = ++this.token;
    await sleep(250);
    if (mine !== this.token) return this.last;
    try {
      const results = await this.search(query);
      if (mine !== this.token) return this.last;
      this.last = results;
      return results;
    } catch (e) {
      console.error("[Obzo] block search failed", e);
      return this.last;
    }
  }

  renderSuggestion(hit: BlockHit, el: HTMLElement) {
    el.addClass("obzo-suggestion");
    const head = [hit.heading, hit.page !== null ? `p.${hit.page + 1}` : null]
      .filter(Boolean)
      .join("  ·  ");
    if (head) el.createDiv({ cls: "obzo-suggestion-kind", text: head });
    const preview = hit.text.replace(/\$\$[\s\S]*?\$\$/g, " [eq] ").replace(/\s+/g, " ").trim();
    el.createDiv({
      cls: "obzo-suggestion-title",
      text: preview.length > 160 ? preview.slice(0, 159) + "…" : preview,
    });
  }

  onChooseSuggestion(hit: BlockHit) {
    this.insert(hit, this.editor);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
