# Obzo

Read what you're reading in Zotero, and get context-aware completions in
Obsidian: **equations (as LaTeX), theorems/definitions, citations, and
figures** sourced from the paper open in your Zotero reader.

## How it works

Two installable pieces, both JavaScript/TypeScript — no Python required.

```
┌────────────────────────┐   GET /obzo/current   ┌──────────────────────────┐
│  Zotero companion      │◄──────────────────────│  Obsidian plugin         │
│  plugin  (JS bootstrap)│   "which PDF is open?" │  (TypeScript)            │
│  • hooks the reader    │──────────────────────►│  • EditorSuggest UI      │
│  • serves endpoints on │  { key, path, title,   │  • current-paper tracker │
│    Zotero's :23119     │    citekey, abstract } │  • extractor + cache     │
└────────────────────────┘                        └────────────┬─────────────┘
                                                                │
   Zotero local API  (:23119/api/...)  ◄──── citations / metadata┤
   MinerU cloud API                    ◄──── equation LaTeX ─────┤
   pdf.js text / Zotero fulltext       ◄──── terms, figures ─────┘
```

1. The **Zotero companion plugin** (`zotero-plugin/`) registers
   `GET /obzo/current` on Zotero's built-in HTTP server. It reports the
   attachment open in the active reader tab, its file path, and the parent
   item's metadata (title, creators, DOI, abstract, Better BibTeX citekey).
2. The **Obsidian plugin** (`obsidian-plugin/`) polls that endpoint, extracts
   structured content from the PDF, and drives an `EditorSuggest` autocomplete:
   - **Citations** — from the Zotero local API + Better BibTeX citekeys.
   - **Terms / definitions** — from the PDF text layer (pdf.js / Zotero's
     stored fulltext).
   - **Figures / sections** — parsed from captions and headings.
   - **Equations** — real LaTeX via the free **MinerU** cloud API, cached per
     attachment. A local/offline extractor can be swapped in later for
     sensitive PDFs (MinerU cloud uploads the file to their servers).

## Repo layout

| Path              | What                                                        |
| ----------------- | ---------------------------------------------------------- |
| `zotero-plugin/`  | Zotero 7 bootstrap plugin exposing `/obzo/*` endpoints.    |
| `obsidian-plugin/`| The Obsidian plugin (TypeScript, esbuild).                 |
| `dist/`           | Build outputs (`obzo-bridge.xpi`).                         |

## Component 1 — Zotero companion plugin

Endpoints (on `http://127.0.0.1:23119`):

- `GET /obzo/ping` → `{ ok, plugin, version }`
- `GET /obzo/current` → the active reader item, e.g.:

```json
{
  "open": true,
  "source": "reader",
  "page": 3,
  "item": {
    "key": "GGBK5Z5D",
    "title": "AlphaAgent: LLM-Driven Alpha Mining",
    "creators": [{ "firstName": "…", "lastName": "Tang" }],
    "DOI": "…",
    "abstractNote": "…",
    "citationKey": "tang2025alphaagent"
  },
  "attachment": {
    "key": "…",
    "contentType": "application/pdf",
    "path": "/Users/chrix/Zotero/storage/…/paper.pdf"
  }
}
```

### Build & install

```bash
bash zotero-plugin/build.sh          # -> dist/obzo-bridge.xpi
```

Then in Zotero: **Tools → Plugins → gear (⚙) → Install Plugin From File…**,
choose `dist/obzo-bridge.xpi`, and restart Zotero. Verify:

```bash
curl -s http://127.0.0.1:23119/obzo/ping
# open a PDF in Zotero, then:
curl -s http://127.0.0.1:23119/obzo/current
```

## Component 2 — Obsidian plugin

See `obsidian-plugin/` (built next). Installs into
`/Users/chrix/Documents/Obsidian/.obsidian/plugins/obzo-complete/`.

## Status

Phased build — see the task list. Current: Zotero companion plugin.
