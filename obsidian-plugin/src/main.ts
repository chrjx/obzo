import { Notice, Plugin } from "obsidian";
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
import {
  MineruExtractor,
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

export default class ObzoPlugin extends Plugin {
  settings!: ObzoSettings;
  bridge!: ZoteroBridge;

  /** The paper currently open in Zotero's reader (or null). */
  current: CurrentReading | null = null;
  /** Extracted suggestion index for the current paper. */
  currentIndex: PaperIndex | null = null;

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

    this.startPolling();
  }

  onunload() {
    this.stopPolling();
  }

  // ---- update loop -------------------------------------------------------
  //
  // Primary path is push: runEventLoop() blocks on the bridge's /obzo/wait
  // endpoint and returns the instant Zotero's active tab changes. A slow
  // heartbeat tick() runs alongside as a safety net (and detects the bridge
  // coming back online). If the bridge is too old for /obzo/wait, we fall
  // back to fast timer polling.

  startPolling() {
    void this.tick(true);
    this.eventLoopRunning = true;
    void this.runEventLoop();
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
        if (res.unsupported) {
          // Old bridge without /obzo/wait — fall back to fast timer polling.
          this.pushSupported = false;
          this.eventLoopRunning = false;
          this.setHeartbeat(Math.max(this.settings.pollIntervalMs, 1000));
          break;
        }
        await sleep(3000); // transient error / bridge offline — back off
        continue;
      }
      if (!this.bridgeOk) this.bridgeOk = true;
      this.applyReading(res.reading, false);
    }
  }

  /** One-shot ping + fetch, used for the initial load and the heartbeat. */
  private async tick(verbose: boolean) {
    const ok = await this.bridge.ping();
    if (ok !== this.bridgeOk) {
      this.bridgeOk = ok;
      if (!ok) this.setStatus("Obzo: Zotero bridge offline");
    }
    if (!ok) {
      if (verbose) {
        new Notice(
          "Obzo: can't reach the Zotero bridge. Is Zotero running with the Obzo Bridge plugin?"
        );
      }
      return;
    }

    // Bridge is up: (re)start the push loop if it stopped while offline.
    if (this.pushSupported && !this.eventLoopRunning) {
      this.eventLoopRunning = true;
      void this.runEventLoop();
    }

    const reading = await this.bridge.current();
    this.applyReading(reading, verbose);
  }

  /** Shared handling of a reading, whether pushed or polled. */
  private applyReading(reading: CurrentReading | null, verbose: boolean) {
    this.current = reading;

    const key = reading?.attachment?.key ?? null;
    const changed = key !== this.lastAttachmentKey;
    this.lastAttachmentKey = key;

    if (reading?.item) {
      const prefix = reading.open ? "Obzo ▸ " : "Obzo (selected) ▸ ";
      this.setStatus(prefix + itemLabel(reading));
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
        const key = it.citationKey || generateCiteKey(it);
        out.push({
          kind: "citation",
          label: `@${key}`,
          detail: `${it.title ?? ""} (current paper)`.trim(),
          insert: `[@${key}]`,
          score: 1e6,
        });
      }
      return out;
    }

    const hits = await this.bridge.searchLibrary(q, 20);
    for (const h of hits) {
      const key = h.citationKey || generateCiteKey(h);
      out.push({
        kind: "citation",
        label: `@${key}`,
        detail: `${h.title} — ${creatorSummary(h)}`,
        insert: `[@${key}]`,
        score: 0,
      });
    }
    return out;
  }

  // ---- paper extraction (MinerU) ----------------------------------------

  async extractPaper(): Promise<void> {
    const att = this.current?.attachment;
    if (!att?.path || att.contentType !== "application/pdf") {
      new Notice("Obzo: no PDF open in Zotero to extract from.");
      return;
    }
    if (!this.settings.mineruToken) {
      new Notice("Obzo: set your MinerU API token in the plugin settings first.");
      return;
    }
    if (this.extracting) {
      new Notice("Obzo: an extraction is already running.");
      return;
    }

    this.extracting = true;
    const notice = new Notice("Obzo: extracting paper…", 0);
    try {
      const extractor = new MineruExtractor(this.settings.mineruToken, {
        enableFormula: true,
        enableTable: true,
        language: "en",
      });
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
    this.statusEl.setAttr("aria-label", text);
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
