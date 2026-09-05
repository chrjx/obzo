import { Notice, Plugin, Editor, EditorPosition } from "obsidian";
import {
  ObzoSettings,
  DEFAULT_SETTINGS,
  ObzoSettingTab,
  STATEMENT_TEMPLATES,
  EQUATION_TEMPLATES,
  FIGURE_TEMPLATES,
} from "./settings";
import {
  ZoteroBridge,
  CurrentReading,
  itemLabel,
  generateCiteKey,
  creatorSummary,
} from "./zotero";
import {
  PaperIndex,
  Suggestion,
  SuggestionRender,
  buildIndexFromText,
  filterSuggestions,
  metadataNoiseWords,
  normalizeMath,
} from "./paper-index";
import { ObzoSuggest } from "./suggest";
import { PaperPickerModal } from "./picker";
import { NoteIndex } from "./notes";
import { TFile, normalizePath } from "obsidian";
import { ZoteroItem } from "./zotero";
import {
  createExtractor,
  ExtractedEquation,
  ExtractedFigure,
  ExtractedStatement,
} from "./mineru";
import { promises as fs } from "fs";

/** Safety-heartbeat cadence while push (long-poll) updates are active. */
const SLOW_HEARTBEAT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Availability of each optional capability layer (tier). */
export interface Capabilities {
  /** Tier 0: Zotero's local API is reachable. */
  zotero: boolean;
  /** Tier 1: the Obzo Bridge is installed (live tab tracking, page, selection). */
  bridge: boolean;
  /** Tier 2: an extractor is configured (MinerU token) for equations/theorems/figures. */
  extractor: boolean;
}

/** Status-bar prefix reflecting how the current paper was resolved (its tier). */
function sourcePrefix(r: CurrentReading): string {
  switch (r.source) {
    case "reader":
      return "Obzo ▸ ";
    case "manual":
      return "Obzo 📌 ▸ ";
    case "recent":
      return "Obzo (recent) ▸ ";
    case "selection":
      return "Obzo (selected) ▸ ";
    default:
      return "Obzo ▸ ";
  }
}

export default class ObzoPlugin extends Plugin {
  settings!: ObzoSettings;
  bridge!: ZoteroBridge;

  /** The paper currently open in Zotero's reader (or null). */
  current: CurrentReading | null = null;
  /** Extracted suggestion index for the current paper. */
  currentIndex: PaperIndex | null = null;
  /** Manually-pinned paper (overrides recent auto-tracking when the bridge is absent). */
  pinnedReading: CurrentReading | null = null;

  /** Which capability tiers are currently available (updated each heartbeat). */
  caps: Capabilities = { zotero: false, bridge: false, extractor: false };

  /** Vault notes indexed by Zotero identifiers (for citation ↔ note linking). */
  noteIndex!: NoteIndex;

  private statusEl!: HTMLElement;
  private pollHandle: number | null = null;
  private lastAttachmentKey: string | null = null;
  private bridgeOk = false;
  private extracting = false;
  /** Whether the push (long-poll) loop is active. */
  private eventLoopRunning = false;
  /** False once we learn the installed bridge has no /obzo/wait endpoint. */
  private pushSupported = true;
  /** Attachment key currentIndex was built for; drives self-healing rebuilds. */
  private indexedKey: string | null = null;
  /** Monotonic token so a slow rebuild can't overwrite a newer paper's index. */
  private indexSeq = 0;

  /** Cached extracted content (equations/statements/figures) per attachment. */
  private eqCache: Map<
    string,
    {
      mtime: number;
      equations: Suggestion[];
      statements: Suggestion[];
      figures: Suggestion[];
      lastUsed: number;
    }
  > = new Map();

  async onload() {
    await this.loadSettings();
    await this.loadEqCache();
    this.bridge = new ZoteroBridge(this.settings.zoteroPort);

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("obzo-status");
    this.setStatus("Obzo: connecting…");
    this.statusEl.onClickEvent(() => this.tick(true));

    this.addSettingTab(new ObzoSettingTab(this.app, this));
    this.registerEditorSuggest(new ObzoSuggest(this));

    // Index vault notes by Zotero id; keep it fresh as notes change.
    this.noteIndex = new NoteIndex(this.app, () => ({
      citekeyProp: this.settings.citekeyProperty,
      zoteroKeyProp: this.settings.zoteroKeyProperty,
    }));
    this.app.workspace.onLayoutReady(() => this.noteIndex.rebuild());
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile) this.noteIndex.indexFile(file);
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => this.noteIndex.rebuild())
    );

    this.addCommand({
      id: "obzo-refresh-current",
      name: "Refresh current paper from Zotero",
      callback: () => this.tick(true),
    });

    this.addCommand({
      id: "obzo-show-current",
      name: "Show current paper",
      callback: () => {
        const label = this.current?.item ? itemLabel(this.current) : null;
        new Notice(label ? `Obzo: ${label}` : "Obzo: no paper open in Zotero.");
      },
    });

    this.addCommand({
      id: "obzo-extract-equations",
      name: "Extract paper: equations, theorems, figures (MinerU)",
      callback: () => void this.extractPaper(),
    });

    this.addCommand({
      id: "obzo-set-current-paper",
      name: "Set current paper…",
      callback: () => this.openPaperPicker(),
    });

    this.addCommand({
      id: "obzo-clear-pinned-paper",
      name: "Clear pinned paper (resume auto-tracking)",
      callback: () => {
        this.pinnedReading = null;
        new Notice("Obzo: pinned paper cleared.");
        this.refreshCurrent();
      },
    });

    this.addCommand({
      id: "obzo-status",
      name: "Show status & capabilities",
      callback: () => this.showStatus(),
    });

    this.addCommand({
      id: "obzo-create-literature-note",
      name: "Create (or open) literature note for current paper",
      callback: () => {
        void (async () => {
          const item = this.current?.item;
          if (!item) {
            new Notice("Obzo: no current paper.");
            return;
          }
          const file = await this.createLiteratureNote(item);
          await this.app.workspace.getLeaf(false).openFile(file);
        })();
      },
    });

    this.startPolling();
  }

  onunload() {
    this.stopPolling();
  }

  // ---- update loop (tiered) ---------------------------------------------
  //
  // Tier 1 (bridge present): runEventLoop() blocks on /obzo/wait and applies
  //   the active reader tab the instant it changes (live push).
  // Tier 0 (no bridge): the heartbeat tick() resolves the current paper from
  //   a manually-pinned item, else the most recently modified paper via the
  //   Zotero local API. Nothing hard-fails when the bridge is absent.
  // The heartbeat always runs as the safety net and detects the bridge coming
  // and going.

  startPolling() {
    void this.tick(true);
    this.setHeartbeat(SLOW_HEARTBEAT_MS);
  }

  stopPolling() {
    this.eventLoopRunning = false;
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  restartPolling() {
    this.stopPolling();
    this.pushSupported = true;
    this.startPolling();
  }

  /** Re-resolve the current paper now (used by commands and settings). */
  refreshCurrent() {
    void this.tick(false);
  }

  /** Rebuild the note index (after the frontmatter-key settings change). */
  rebuildNoteIndex() {
    this.noteIndex?.rebuild();
  }

  /**
   * Create a literature note for an item (or return the existing one, matched
   * by Zotero key / citekey). Standalone — no ZotLit required.
   */
  async createLiteratureNote(item: ZoteroItem): Promise<TFile> {
    const citekey = item.citationKey || generateCiteKey(item);
    const existing = this.noteIndex?.lookup(item.key, citekey);
    if (existing) return existing;

    const fields = noteFields(item, citekey);
    const folder = this.settings.literatureFolder.trim();
    const name =
      sanitizeFilename(fillTemplate(this.settings.noteFilenameTemplate, fields)) ||
      citekey;
    const dir = folder ? normalizePath(folder) : "";
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => {});
    }

    let path = normalizePath(dir ? `${dir}/${name}.md` : `${name}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(dir ? `${dir}/${name} ${n}.md` : `${name} ${n}.md`);
      n++;
    }

    const body = fillTemplate(this.settings.noteTemplate, fields);
    const file = await this.app.vault.create(path, body);
    this.noteIndex?.indexFile(file);
    return file;
  }

  /** Fetch full item metadata by key, then create (or find) its note. */
  async createLiteratureNoteByKey(itemKey: string): Promise<TFile | null> {
    const reading = await this.bridge.readingForItem(
      itemKey,
      this.settings.zoteroDataDir
    );
    if (!reading?.item) return null;
    return this.createLiteratureNote(reading.item);
  }

  /** Create the note for an item, then replace the trigger with a wikilink. */
  async createNoteAndLink(
    itemKey: string,
    citekey: string,
    editor: Editor,
    start: EditorPosition,
    end: EditorPosition
  ): Promise<void> {
    try {
      const file = await this.createLiteratureNoteByKey(itemKey);
      if (!file) {
        new Notice("Obzo: couldn't load that item from Zotero.");
        return;
      }
      const key = citekey || file.basename.replace(/^@/, "");
      editor.replaceRange(wikilink(file, key), start, end);
      new Notice(`Obzo: created ${file.basename}`);
    } catch (e: any) {
      new Notice(`Obzo: couldn't create note — ${e?.message ?? e}`);
      console.error("[Obzo] create note failed", e);
    }
  }

  /** Open the library picker to manually pin the current paper. */
  openPaperPicker() {
    new PaperPickerModal(
      this.app,
      (q) => this.bridge.searchLibrary(q, 20),
      (hit) => {
        void (async () => {
          const reading = await this.bridge.readingForItem(
            hit.key,
            this.settings.zoteroDataDir
          );
          if (!reading) {
            new Notice("Obzo: couldn't load that item from Zotero.");
            return;
          }
          this.pinnedReading = reading;
          this.applyReading(reading, true);
        })();
      }
    ).open();
  }

  private setHeartbeat(ms: number) {
    if (this.pollHandle !== null) window.clearInterval(this.pollHandle);
    this.pollHandle = window.setInterval(() => void this.tick(false), ms);
    this.registerInterval(this.pollHandle);
  }

  /** Push loop: block until Zotero's active tab changes, then apply it. */
  private async runEventLoop() {
    while (this.eventLoopRunning) {
      const res = await this.bridge.waitForChange();
      if (!this.eventLoopRunning) break;
      if (!res.ok) {
        // Bridge went away or is too old for push — stop the loop; the
        // heartbeat tick() takes over (and restarts push if it returns).
        if (res.unsupported) this.pushSupported = false;
        this.eventLoopRunning = false;
        break;
      }
      this.bridgeOk = true;
      this.applyReading(res.reading, false);
    }
  }

  /** Heartbeat: resolve the current paper via the best available tier. */
  private async tick(verbose: boolean) {
    this.caps.extractor =
      this.settings.enableEquations && !!this.settings.mineruToken;

    const bridgeOk = await this.bridge.ping();
    this.bridgeOk = bridgeOk;
    this.caps.bridge = bridgeOk;

    if (bridgeOk) {
      this.caps.zotero = true;
      // Tier 1: live. (Re)start the push loop if it isn't running.
      if (this.pushSupported && !this.eventLoopRunning) {
        this.eventLoopRunning = true;
        void this.runEventLoop();
      }
      this.applyReading(await this.bridge.current(), verbose);
      return;
    }

    // No bridge — fall back to Tier 0.
    this.eventLoopRunning = false;
    await this.resolveTier0(verbose);
  }

  /** Tier 0 current-paper resolution: pinned item, else most-recent paper. */
  private async resolveTier0(verbose: boolean) {
    if (this.pinnedReading) {
      this.applyReading(this.pinnedReading, verbose);
      return;
    }
    const alive = await this.bridge.zoteroAlive();
    this.caps.zotero = alive;
    if (!alive) {
      this.setStatus("Obzo: Zotero not reachable");
      if (verbose) {
        new Notice("Obzo: can't reach Zotero. Is Zotero running?");
      }
      return;
    }
    if (this.settings.autoTrackRecent) {
      const reading = await this.bridge.recentReading(
        this.settings.zoteroDataDir
      );
      this.applyReading(reading, verbose);
    } else {
      this.current = null;
      this.setStatus('Obzo: run "Set current paper" to pick a paper');
    }
  }

  /** Shared handling of a reading, whether pushed or polled. */
  private applyReading(reading: CurrentReading | null, verbose: boolean) {
    this.current = reading;

    const key = reading?.attachment?.key ?? null;
    const changed = key !== this.lastAttachmentKey;
    this.lastAttachmentKey = key;

    if (reading?.item) {
      this.setStatus(sourcePrefix(reading) + itemLabel(reading));
    } else {
      this.setStatus("Obzo: no paper open");
    }

    if (changed && verbose && reading?.item) {
      new Notice(`Obzo now tracking: ${itemLabel(reading)}`);
    }

    // Rebuild whenever the index doesn't match the open paper. Self-healing:
    // if a rebuild is ever missed, the next tick retries it.
    if (key !== this.indexedKey) {
      void this.rebuildIndex(reading);
    }
  }

  // ---- index building ----------------------------------------------------

  private async rebuildIndex(reading: CurrentReading | null) {
    const att = reading?.attachment;
    const seq = ++this.indexSeq;

    if (!att || att.contentType !== "application/pdf") {
      this.currentIndex = null;
      this.indexedKey = att?.key ?? null;
      return;
    }

    try {
      const text = await this.bridge.fulltext(att.key);
      if (seq !== this.indexSeq) return; // a newer switch superseded this one
      if (!text) {
        this.currentIndex = null;
        this.indexedKey = att.key;
        return;
      }

      const noise = metadataNoiseWords(
        reading?.item?.creators ?? [],
        reading?.item?.publicationTitle
      );
      const index = buildIndexFromText(
        att.key,
        reading?.item?.title ?? "",
        text,
        noise
      );

      // Attach previously extracted equations if the PDF is unchanged.
      const cached = this.eqCache.get(att.key);
      if (cached) {
        const mtime = await this.fileMtime(att.path);
        if (seq !== this.indexSeq) return;
        if (mtime === null || Math.abs(mtime - cached.mtime) < 1000) {
          cached.lastUsed = Date.now(); // touch for LRU
          index.equations = cached.equations;
        }
      }

      if (seq !== this.indexSeq) return; // abandon a stale (old-paper) result
      this.currentIndex = index;
      this.indexedKey = att.key;

      const n = index.terms.length + index.refs.length + index.equations.length;
      this.setStatus(`Obzo ▸ ${itemLabel(reading)}  (${n} suggestions)`);
    } catch (e) {
      console.error("[Obzo] indexing failed", e);
      // Leave indexedKey unchanged so the next poll retries this paper.
    }
  }

  // ---- suggestion providers ---------------------------------------------

  /** Paper-context suggestions (terms / figures / equations), synchronous. */
  getPaperSuggestions(query: string): Suggestion[] {
    const attKey = this.current?.attachment?.key ?? null;

    // Only trust the text index if it was built for the paper open *now*.
    // Otherwise its terms/figures are stale and must not be shown.
    const index =
      this.currentIndex && this.currentIndex.attachmentKey === attKey
        ? this.currentIndex
        : null;

    // Equations always come live from the cache, keyed by the currently-open
    // attachment — so a slow or stale index can never surface a previous
    // paper's equations.
    // Equations / statements / figures come live from the cache, keyed by the
    // currently-open attachment — never a previous paper's.
    const cached = attKey ? this.eqCache.get(attKey) : undefined;
    const cachedPool = cached
      ? [...cached.equations, ...cached.statements, ...cached.figures]
      : [];

    const combined: PaperIndex = {
      attachmentKey: attKey ?? "",
      title: index?.title ?? "",
      terms: index?.terms ?? [],
      refs: index?.refs ?? [],
      equations: cachedPool,
    };
    const results = filterSuggestions(combined, query, 40);

    // Offer a one-time "extract" row when nothing is cached for this paper yet.
    const canExtract =
      this.settings.enableEquations &&
      !!this.settings.mineruToken &&
      !!this.current?.attachment?.path &&
      cachedPool.length === 0;
    const q = query.toLowerCase().trim();
    const wantsIt =
      q === "" || "equations".startsWith(q) || "extract".startsWith(q);
    if (canExtract && wantsIt && !this.extracting) {
      results.unshift({
        kind: "equation",
        label: "⚙ Extract this paper — equations, theorems, figures (MinerU)",
        detail: "one-time · uploads the PDF · ~1 min",
        insert: "",
        score: 1e9,
        action: "extract-equations",
      });
    }
    return results;
  }

  /** Text to insert for a suggestion, optionally with a zotero:// page backlink. */
  insertTextFor(s: Suggestion): string {
    const text = s.render
      ? renderInsert(s.render, this.settings, s.page)
      : s.insert;
    if (
      !this.settings.insertBacklinks ||
      s.action ||
      s.kind === "citation" ||
      typeof s.page !== "number"
    ) {
      return text;
    }
    const key = this.current?.attachment?.key;
    if (!key) return text;
    const p = s.page + 1; // zotero ?page= is 1-based
    const link = `[📄 p.${p}](zotero://open-pdf/library/items/${key}?page=${p})`;
    return `${text.replace(/\s+$/, "")}\n${link}\n`;
  }

  /** Citation suggestions from the Zotero library, async. */
  async getCitationSuggestions(query: string): Promise<Suggestion[]> {
    const q = query.trim();
    const out: Suggestion[] = [];

    // With no query yet, offer the paper you're currently reading.
    if (q.length < 2) {
      const it = this.current?.item;
      if (it) {
        out.push(
          this.citationSuggestion(it.citationKey, it.key, it.title, "(current paper)", 1e6, it)
        );
        if (!this.noteIndex?.lookup(it.key, it.citationKey)) {
          out.push(this.createNoteSuggestion(it.citationKey, it.key, it, 1e6));
        }
      }
      return out;
    }

    const hits = await this.bridge.searchLibrary(q, 20);
    for (const h of hits) {
      out.push(
        this.citationSuggestion(h.citationKey, h.key, h.title, creatorSummary(h), 0, h)
      );
      if (!this.noteIndex?.lookup(h.key, h.citationKey)) {
        out.push(this.createNoteSuggestion(h.citationKey, h.key, h, 0));
      }
    }
    return out;
  }

  /**
   * Build a citation suggestion in one of two modes:
   *  - a matching literature note exists → insert a bidirectional [[wikilink]]
   *  - no note → insert [@citekey](zotero://select/...) linking to Zotero.
   */
  private citationSuggestion(
    citationKey: string | null,
    itemKey: string,
    title: string | null,
    meta: string,
    score: number,
    forKeygen: { creators?: any[]; date?: string | null; title?: string | null }
  ): Suggestion {
    const key = citationKey || generateCiteKey(forKeygen);
    const note = this.noteIndex?.lookup(itemKey, citationKey);
    if (note) {
      return {
        kind: "citation",
        label: `@${key}`,
        detail: `→ ${note.basename}  ·  ${meta}`.trim(),
        insert: wikilink(note, key),
        score: score + 10, // prefer papers you already have notes for
      };
    }
    const link = itemKey
      ? `[@${key}](zotero://select/library/items/${itemKey})`
      : `[@${key}]`;
    return {
      kind: "citation",
      label: `@${key}`,
      detail: `↗ Zotero  ·  ${title ?? ""} — ${meta}`.trim(),
      insert: link,
      score,
    };
  }

  /** A "create & link literature note" row, offered when no note exists yet. */
  private createNoteSuggestion(
    citationKey: string | null,
    itemKey: string,
    forKeygen: { creators?: any[]; date?: string | null; title?: string | null },
    score: number
  ): Suggestion {
    const key = citationKey || generateCiteKey(forKeygen);
    return {
      kind: "citation",
      label: `＋ create & link note — @${key}`,
      detail: "makes a literature note, then inserts a wikilink",
      insert: "",
      score: score - 1,
      action: "create-note",
      citeItemKey: itemKey,
      citeKey: key,
    };
  }

  // ---- paper extraction (pluggable backend) -----------------------------

  async extractPaper(): Promise<void> {
    const att = this.current?.attachment;
    if (!att?.path || att.contentType !== "application/pdf") {
      new Notice("Obzo: no PDF open in Zotero to extract from.");
      return;
    }
    const extractor = createExtractor({
      backend: this.settings.extractorBackend,
      mineruToken: this.settings.mineruToken,
    });
    if (!extractor) {
      new Notice("Obzo: no extractor configured. Set a MinerU token in settings.");
      return;
    }
    if (this.extracting) {
      new Notice("Obzo: an extraction is already running.");
      return;
    }

    this.extracting = true;
    const notice = new Notice(`Obzo: extracting paper (${extractor.name})…`, 0);
    try {
      const content = await extractor.extract(att.path, (m) =>
        notice.setMessage(`Obzo: ${m}`)
      );

      const equations = content.equations.map((e, i) => equationSuggestion(e, i));
      const statements = content.statements.map((s, i) =>
        statementSuggestion(s, i)
      );
      const figures = await this.saveFigures(att.key, content.figures);

      const mtime = (await this.fileMtime(att.path)) ?? Date.now();
      this.eqCache.set(att.key, {
        mtime,
        equations,
        statements,
        figures,
        lastUsed: Date.now(),
      });
      this.enforceCacheLimit(att.key);
      await this.saveEqCache();

      notice.setMessage(
        `Obzo: ${equations.length} equations, ${statements.length} statements, ${figures.length} figures ready — type "${this.settings.paperTrigger}".`
      );
      window.setTimeout(() => notice.hide(), 6000);
    } catch (e: any) {
      notice.hide();
      new Notice(`Obzo: extraction failed — ${e?.message ?? e}`, 8000);
      console.error("[Obzo] MinerU extraction failed", e);
    } finally {
      this.extracting = false;
    }
  }

  /** Save figure crops into the vault and build insertable suggestions. */
  private async saveFigures(
    attachmentKey: string,
    figures: ExtractedFigure[]
  ): Promise<Suggestion[]> {
    if (figures.length === 0) return [];
    const adapter = this.app.vault.adapter;
    const dir = `obzo-figures/${attachmentKey}`;
    try {
      if (!(await adapter.exists("obzo-figures"))) await adapter.mkdir("obzo-figures");
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    } catch (e) {
      console.error("[Obzo] could not create figure folder", e);
    }

    const out: Suggestion[] = [];
    for (let i = 0; i < figures.length; i++) {
      const fig = figures[i];
      const path = `${dir}/${fig.kind}-p${(fig.page ?? 0) + 1}-${i + 1}.${fig.ext}`;
      try {
        await adapter.writeBinary(path, toArrayBuffer(fig.data));
        out.push(figureSuggestion(path, fig, i));
      } catch (e) {
        console.error("[Obzo] failed to save figure", path, e);
      }
    }
    return out;
  }

  private async fileMtime(path: string | null): Promise<number | null> {
    if (!path) return null;
    try {
      return (await fs.stat(path)).mtimeMs;
    } catch {
      return null;
    }
  }

  private cachePath(): string {
    return `${this.app.vault.configDir}/plugins/obzo-complete/equation-cache.json`;
  }

  private async loadEqCache(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.cachePath());
      const obj = JSON.parse(raw) as Record<
        string,
        {
          mtime: number;
          equations?: Suggestion[];
          statements?: Suggestion[];
          figures?: Suggestion[];
          lastUsed?: number;
        }
      >;
      this.eqCache = new Map(
        Object.entries(obj).map(([k, v]) => [
          k,
          {
            mtime: v.mtime,
            equations: (v.equations ?? []).map(normalizeEqSuggestion),
            statements: (v.statements ?? []).map(backfillPage).map(backfillRender),
            figures: (v.figures ?? []).map(backfillPage).map(backfillRender),
            lastUsed: v.lastUsed ?? 0,
          },
        ])
      );
      // Apply the limit on load in case it was lowered or the file predates it.
      if (this.enforceCacheLimit()) await this.saveEqCache();
    } catch {
      this.eqCache = new Map();
    }
  }

  async saveEqCache(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.eqCache);
      await this.app.vault.adapter.write(
        this.cachePath(),
        JSON.stringify(obj)
      );
    } catch (e) {
      console.error("[Obzo] failed to persist equation cache", e);
    }
  }

  /**
   * Evict least-recently-used cached papers until the cache is under the
   * configured size limit. `keepKey` (the paper just cached) is never evicted.
   * Returns true if anything was removed.
   */
  enforceCacheLimit(keepKey?: string): boolean {
    const maxBytes = Math.max(1, this.settings.cacheMaxMB) * 1024 * 1024;

    const sizes = new Map<string, number>();
    let total = 0;
    for (const [k, v] of this.eqCache) {
      const bytes = JSON.stringify(v).length;
      sizes.set(k, bytes);
      total += bytes;
    }
    if (total <= maxBytes) return false;

    const lru = Array.from(this.eqCache.keys())
      .filter((k) => k !== keepKey)
      .sort(
        (a, b) =>
          (this.eqCache.get(a)?.lastUsed ?? 0) -
          (this.eqCache.get(b)?.lastUsed ?? 0)
      );

    let evicted = 0;
    for (const k of lru) {
      if (total <= maxBytes) break;
      total -= sizes.get(k) ?? 0;
      this.eqCache.delete(k);
      evicted++;
    }
    if (evicted > 0) {
      console.log(
        `[Obzo] evicted ${evicted} paper(s) to keep the equation cache under ${this.settings.cacheMaxMB} MB`
      );
    }
    return evicted > 0;
  }

  private setStatus(text: string) {
    this.statusEl.setText(text);
    // Tooltip shows which capability tiers are active.
    this.statusEl.setAttr("aria-label", `${text}\n${this.capabilitySummary()}`);
  }

  /** Human-readable summary of active/missing capability tiers. */
  capabilitySummary(): string {
    const mark = (on: boolean) => (on ? "✓" : "○");
    return [
      `${mark(this.caps.zotero)} Zotero (base)`,
      `${mark(this.caps.bridge)} Bridge (live tab/page/selection)`,
      `${mark(this.caps.extractor)} Extractor (equations/theorems/figures)`,
    ].join("   ");
  }

  /** Notice with the current paper, active tiers, and how to enable missing ones. */
  private showStatus() {
    const lines: string[] = [];
    lines.push(
      this.current?.item
        ? `Paper: ${itemLabel(this.current)}  (${this.current.source ?? "?"})`
        : "Paper: none"
    );
    lines.push("");
    lines.push(
      `${this.caps.zotero ? "✓" : "○"} Base — Zotero local API` +
        (this.caps.zotero ? "" : "  → start Zotero")
    );
    lines.push(
      `${this.caps.bridge ? "✓" : "○"} Live — Obzo Bridge` +
        (this.caps.bridge ? "" : "  → install the bridge xpi for live tab/page/selection")
    );
    lines.push(
      `${this.caps.extractor ? "✓" : "○"} Content — extractor` +
        (this.caps.extractor ? "" : "  → set a MinerU token in settings")
    );
    new Notice(lines.join("\n"), 10000);
  }

  // ---- settings ----------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** A readable one-line label from LaTeX: structural noise stripped so it reads
 *  like the math ("X_{t} = X_0 + …"), not "\begin{array}…". The full LaTeX is
 *  still what gets inserted — this only affects the browsing label. */
function prettyLatex(latex: string): string {
  let s = latex
    .replace(/\\tag\{[^}]*\}/g, "")
    .replace(/\\begin\{[^}]*\}(\s*\{[^}]*\})?/g, "") // \begin{array}{l} incl. col-spec
    .replace(/\\end\{[^}]*\}/g, "")
    .replace(/\\displaystyle/g, "")
    .replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, "")
    .replace(/\\[,;:!]/g, " ")
    .replace(/\\q?quad/g, " ")
    .replace(/\s*_\s*/g, "_")
    .replace(/\s*\^\s*/g, "^");
  // Unwrap grouping braces repeatedly: {t} -> t, {{X_t}} -> X_t.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\{\s*([^{}]*?)\s*\}/g, "$1");
  } while (s !== prev);
  return s.replace(/\s+/g, " ").trim();
}

/** Build an equation suggestion. `insert` keeps the FULL original LaTeX so the
 *  equation is pasted verbatim; label/searchKey are derived for browsing. */
function buildEquationSuggestion(
  latex: string,
  page: number | null,
  score: number
): Suggestion {
  const tag = latex.match(/\\tag\{([^}]*)\}/)?.[1] ?? null;
  const shown = ((tag ? `(${tag}) ` : "") + prettyLatex(latex)).trim();
  const label = shown.length > 72 ? shown.slice(0, 71) + "…" : shown || "(equation)";
  const pageLabel = page !== null ? `p.${page + 1}` : null;
  const render: SuggestionRender = { type: "equation", latex, tag: tag ?? "" };
  return {
    kind: "equation",
    label,
    detail: [tag ? `eq (${tag})` : "equation", pageLabel]
      .filter(Boolean)
      .join(" · "),
    insert: renderInsert(render, DEFAULT_SETTINGS, page ?? undefined), // block form = full LaTeX verbatim
    render,
    score,
    eqNum: tag ?? undefined,
    searchKey: normalizeMath(latex),
    page: page ?? undefined,
  };
}

function equationSuggestion(e: ExtractedEquation, index: number): Suggestion {
  return buildEquationSuggestion(e.latex, e.page, 900 - index);
}

/** Re-derive label/number/searchKey for a cached equation (written before
 *  these existed) from its stored insert, preserving the exact insert text. */
function normalizeEqSuggestion(s: Suggestion): Suggestion {
  if (s.kind !== "equation" || s.action) return s;
  const latex = s.insert.replace(/\$\$/g, "").trim();
  const pageM = s.detail?.match(/p\.(\d+)/);
  const pageIdx = pageM ? parseInt(pageM[1], 10) - 1 : null;
  const rebuilt = buildEquationSuggestion(latex, pageIdx, s.score);
  rebuilt.insert = s.insert; // keep the original paste text exactly
  return rebuilt;
}

const STATEMENT_ALIASES: Record<string, string> = {
  theorem: "theorem thm",
  definition: "definition def",
  lemma: "lemma",
  proposition: "proposition prop",
  corollary: "corollary cor",
  assumption: "assumption assum",
  claim: "claim",
  condition: "condition cond",
  hypothesis: "hypothesis hyp",
  remark: "remark",
  example: "example",
};

/** Suggestion for a theorem/definition/assumption/… statement (inserts a callout). */
function statementSuggestion(s: ExtractedStatement, index: number): Suggestion {
  const label = `${s.kind}${s.number ? " " + s.number : ""}`; // "Theorem 1"
  const body = s.text
    .replace(/\$\$[\s\S]*?\$\$/g, " ") // drop display math from the preview
    .replace(/\s+/g, " ")
    .replace(new RegExp("^" + escapeRegExp(label) + "\\.?\\s*"), "")
    .trim();
  const shown = body ? `${label} — ${body}` : label;
  const display = shown.length > 84 ? shown.slice(0, 83) + "…" : shown;

  const aliases = STATEMENT_ALIASES[s.kind.toLowerCase()] ?? s.kind.toLowerCase();
  // Statement text without the leading "Theorem 1." (the label carries it).
  const renderBody = s.text
    .replace(new RegExp("^" + escapeRegExp(label) + "\\.?\\s*"), "")
    .trim();
  const render: SuggestionRender = {
    type: "statement",
    kind: s.kind,
    label,
    number: s.number ?? "",
    body: renderBody,
  };

  return {
    kind: "statement",
    label: display,
    detail: [label, s.page !== null ? `p.${s.page + 1}` : null]
      .filter(Boolean)
      .join(" · "),
    insert: renderInsert(render, DEFAULT_SETTINGS, s.page ?? undefined),
    render,
    score: 950 - index,
    searchKey: normalizeMath(`${s.kind} ${s.number ?? ""} ${aliases} ${body}`),
    page: s.page ?? undefined,
  };
}

/** Suggestion that embeds a saved figure/table/chart image + caption. */
function figureSuggestion(
  vaultPath: string,
  fig: ExtractedFigure,
  index: number
): Suggestion {
  const kindLabel = fig.kind.charAt(0).toUpperCase() + fig.kind.slice(1);
  const cap = fig.caption ?? `${kindLabel} (p.${(fig.page ?? 0) + 1})`;
  const shortCap = cap.length > 70 ? cap.slice(0, 69) + "…" : cap;
  const render: SuggestionRender = {
    type: "figure",
    path: vaultPath,
    caption: fig.caption ?? "",
    figKind: fig.kind,
  };
  return {
    kind: "figure-image",
    label: `🖼 ${shortCap}`,
    detail: [kindLabel, fig.page !== null ? `p.${fig.page + 1}` : null]
      .filter(Boolean)
      .join(" · "),
    insert: renderInsert(render, DEFAULT_SETTINGS, fig.page ?? undefined),
    render,
    score: 700 - index,
    searchKey: normalizeMath(`${fig.kind} figure ${fig.caption ?? ""}`),
    page: fig.page ?? undefined,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bidirectional wikilink to a literature note, aliased to the @citekey. */
function wikilink(note: TFile, citekey: string): string {
  return `[[${note.basename}|@${citekey}]]`;
}

/** Placeholder fields for literature-note filename/body templates. */
function noteFields(item: ZoteroItem, citekey: string): Record<string, string> {
  const authors = (item.creators ?? [])
    .filter((c) => !c.creatorType || c.creatorType === "author")
    .map((c) => [c.lastName, c.firstName].filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
  return {
    citekey,
    zoteroKey: item.key,
    title: (item.title ?? "").replace(/"/g, "'"),
    authors,
    year: item.date?.match(/\d{4}/)?.[0] ?? "",
    abstract: item.abstractNote ?? "",
    doi: item.DOI ?? "",
    url: item.url ?? "",
  };
}

/** Fill a {placeholder} template (reuses the insert-template renderer). */
function fillTemplate(tpl: string, fields: Record<string, string>): string {
  return renderTemplate(tpl, fields);
}

/** Strip characters not allowed in vault filenames. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength
  ) as ArrayBuffer;
}

/** Backfill a suggestion's 0-based page from its "p.N" detail if missing. */
function backfillPage(s: Suggestion): Suggestion {
  if (typeof s.page === "number") return s;
  const m = s.detail?.match(/p\.(\d+)/);
  return m ? { ...s, page: parseInt(m[1], 10) - 1 } : s;
}

/** Substitute {placeholders}; multi-line values inherit the line's `>`/indent
 *  prefix so callout/blockquote bodies stay properly quoted. */
function renderTemplate(tpl: string, fields: Record<string, string>): string {
  return tpl
    .split("\n")
    .map((line) => {
      const contPrefix = line.match(/^(\s*(?:>\s?)*)/)?.[1] ?? "";
      return line.replace(/\{(\w+)\}/g, (_m, key) =>
        (fields[key] ?? "").replace(/\n/g, "\n" + contPrefix)
      );
    })
    .join("\n");
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderFields(r: SuggestionRender, page?: number): Record<string, string> {
  const pageStr = typeof page === "number" ? String(page + 1) : "";
  if (r.type === "statement") {
    return {
      kind: r.kind.toLowerCase(),
      Kind: capFirst(r.kind),
      label: r.label,
      number: r.number,
      body: r.body,
      page: pageStr,
    };
  }
  if (r.type === "equation") {
    return {
      latex: r.latex,
      latexInline: r.latex.replace(/\s*\n\s*/g, " ").trim(),
      tag: r.tag,
      page: pageStr,
    };
  }
  return {
    path: r.path,
    caption: r.caption,
    kind: r.figKind,
    Kind: capFirst(r.figKind),
    page: pageStr,
  };
}

function templateFor(r: SuggestionRender, s: ObzoSettings): string {
  if (r.type === "statement") {
    return s.statementFormat === "custom"
      ? s.statementTemplate
      : STATEMENT_TEMPLATES[s.statementFormat] ?? STATEMENT_TEMPLATES.callout;
  }
  if (r.type === "equation") {
    return s.equationFormat === "custom"
      ? s.equationTemplate
      : EQUATION_TEMPLATES[s.equationFormat] ?? EQUATION_TEMPLATES.block;
  }
  return s.figureFormat === "custom"
    ? s.figureTemplate
    : FIGURE_TEMPLATES[s.figureFormat] ?? FIGURE_TEMPLATES["embed-caption"];
}

/** Render a suggestion's insert text from the chosen (preset or custom) template. */
function renderInsert(
  r: SuggestionRender,
  s: ObzoSettings,
  page?: number
): string {
  const out = renderTemplate(templateFor(r, s), renderFields(r, page));
  return out.replace(/\n*$/, "") + "\n";
}

/** Reconstruct a render payload for cached statement/figure suggestions that
 *  predate it, by parsing their baked insert — so the format setting applies
 *  without re-extraction. */
function backfillRender(s: Suggestion): Suggestion {
  if (s.render) return s;
  if (s.kind === "statement") {
    const m = s.insert.match(/^>\s*\[!(\w+)\]\s*(.+)/);
    if (!m) return s;
    const kind = m[1];
    const label = m[2].trim();
    const body = s.insert
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .trim()
      .replace(new RegExp("^" + escapeRegExp(label) + "\\.?\\s*"), "")
      .trim();
    const number = label.match(/\d+(?:\.\d+)*/)?.[0] ?? "";
    return { ...s, render: { type: "statement", kind, label, number, body } };
  }
  if (s.kind === "figure-image") {
    const m = s.insert.match(/!\[\[([^\]]+)\]\]/);
    if (!m) return s;
    const caption = s.insert.match(/\*([^*\n]+)\*/)?.[1] ?? "";
    return {
      ...s,
      render: { type: "figure", path: m[1], caption, figKind: "figure" },
    };
  }
  return s;
}
