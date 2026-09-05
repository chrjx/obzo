import { App, SuggestModal } from "obsidian";
import { ZoteroSearchHit, creatorSummary } from "./zotero";

/**
 * Fuzzy picker over the Zotero library, used to manually set the current paper
 * when the bridge isn't installed (or to override recent auto-tracking).
 */
export class PaperPickerModal extends SuggestModal<ZoteroSearchHit> {
  constructor(
    app: App,
    private search: (q: string) => Promise<ZoteroSearchHit[]>,
    private onChoose: (hit: ZoteroSearchHit) => void
  ) {
    super(app);
    this.setPlaceholder("Search your Zotero library for a paper…");
  }

  async getSuggestions(query: string): Promise<ZoteroSearchHit[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    return this.search(q);
  }

  renderSuggestion(hit: ZoteroSearchHit, el: HTMLElement) {
    el.createDiv({ text: hit.title || "(untitled)", cls: "obzo-suggestion-title" });
    const meta = creatorSummary(hit);
    if (meta) el.createDiv({ text: meta, cls: "obzo-suggestion-meta" });
  }

  onChooseSuggestion(hit: ZoteroSearchHit) {
    this.onChoose(hit);
  }
}
