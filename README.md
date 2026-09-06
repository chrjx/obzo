# Obzo

Read what you're reading in Zotero, and get context-aware completions in
Obsidian: **citations, equations (as LaTeX), theorems/definitions, and
figures** sourced from the paper open in your Zotero reader.

Obzo is designed in **tiers** — it works with just the plugin, and gets more
capable as you add optional pieces. None of the optional layers are required.

| Tier | You add | You get |
| --- | --- | --- |
| **Base** | the plugin + Zotero running | citations ↔ literature notes, term/figure references, current-paper tracking, library search |
| **Live** | the Obzo Bridge (Zotero plugin) | instant active-tab tracking, current page, selected annotations |
| **Content** | a MinerU token | equations, theorems/definitions, and figures extracted from the PDF |
| **Agent** | an MCP client (Claude Code / Codex / Cursor) | summarize highlights, draft literature notes — on your own subscription, no API key |

## Install

### From the Community Plugins store
Once accepted: **Settings → Community plugins → Browse → "Obzo" → Install → Enable**.

### Via BRAT (before it's in the store)
Install the **BRAT** plugin, then *Add beta plugin* with this repository URL.

### Manually
Download `manifest.json`, `main.js`, and `styles.css` from the
[latest release](../../releases/latest) into
`<vault>/.obsidian/plugins/obzo/`, then enable it in
**Settings → Community plugins**.

## Usage

With a paper open in Zotero (or after running **"Obzo: Set current paper…"**):

- Type **`@`** for citations — inserts a bidirectional `[[wikilink]]` if you
  have a literature note for that paper, otherwise a `zotero://` link (with an
  inline option to create & link a note).
- Type **`;;`** for content from the current paper — figure/section
  references, and (with a MinerU token) equations, theorems, and figures. Insert
  formats are configurable, and each insert can carry a `zotero://` page backlink.
- Run **"Import block…"** to pull a whole paragraph *with its equations* by
  meaning — type a phrase or concept (e.g. "profit maximization") and Obzo
  ranks the paper's blocks and inserts the one you pick (see below).

Commands: *Set current paper*, *Clear pinned paper*, *Create literature note*,
*Extract paper (MinerU)*, *Import block…*, *Show status & capabilities*.

## Semantic block import

"Import block…" finds a meaningful **block** (a paragraph plus its equations,
tagged with its section heading) by *meaning*, not just keywords — so "profit
maximization" matches the paragraph about maximizing expected profit even if it
never uses that phrase.

- Blocks come from the same MinerU extraction as equations/figures (run
  "Extract paper" once).
- Ranking is **hybrid**: a section-heading/text keyword match, plus semantic
  similarity via **[Voyage](https://voyageai.com) embeddings** (free tier works;
  set the key in settings). Block vectors are computed once per paper and cached.
- **Without a Voyage key** it still works, ranking by keyword only.

Privacy: like MinerU, the Voyage backend sends block/query text to Voyage's
servers to embed it.

> **Future:** a local/offline embedding model (no key, no upload) is planned
> behind the same pluggable interface — it'll be a settings switch, not a
> rewrite. Voyage is the first backend.

## Optional companions

These live in this repo and enable the higher tiers:

| Path | What it enables |
| --- | --- |
| `zotero-plugin/` | **Obzo Bridge** — a Zotero plugin adding live tab tracking, current page, and selected annotations. Build with `bash zotero-plugin/build.sh` → install the resulting `.xpi` in Zotero. |
| `obzo-mcp/` | **MCP server** — exposes the current paper, annotations, and extracted content to any MCP client, plus tools/prompts to write notes on your subscription. See `obzo-mcp/README.md`. |

Without them, Obzo falls back to Zotero's local API (recent paper / manual
picker) and works fine — run **"Obzo: Show status & capabilities"** to see which
tiers are active.

## Development

```bash
cd obsidian-plugin
npm install
npm run dev          # watch build → main.js
bash install.sh      # copy manifest.json (root) + main.js + styles.css to your vault
```

### Releasing

```bash
node scripts/version-bump.mjs 0.2.0     # update manifest.json + versions.json
git commit -am "0.2.0" && git tag 0.2.0 && git push --follow-tags
```

Pushing the tag runs `.github/workflows/release.yml`, which builds the plugin
and attaches `manifest.json`, `main.js`, and `styles.css` to a GitHub release
named for the version — the format the Community Plugins store expects.

## License

MIT — see [LICENSE](LICENSE).
