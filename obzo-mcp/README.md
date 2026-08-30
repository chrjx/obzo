# Obzo MCP server

Exposes the Zotero paper you're currently reading to **any MCP client** (Claude
Code, Codex, Cursor, Claudian, Claude Desktop, …). The client's own model —
including a Claude Pro/Max or ChatGPT subscription via its CLI — does the
reasoning; **no API key is needed here.** Obzo is just the context provider.

## Tools (read-only)

| Tool | Args | Returns |
| --- | --- | --- |
| `current_paper` | — | The paper open in Zotero's reader: title, authors, DOI, abstract, `attachmentKey`, current `page`, and `selectedAnnotations` (keys selected in the reader). |
| `list_annotations` | `attachmentKey?`, `color?`, `selectedOnly?` | Your highlights: text, comment, color, page, annotation key, `zotero://…?annotation=` backlink. `selectedOnly` returns just the annotation(s) selected in the reader right now. |
| `get_content` | `attachmentKey?`, `kind?` (`equation`/`statement`/`figure`/`all`), `query?`, `limit?` | Extracted content from Obzo's MinerU cache, with ready-to-insert markdown + page. |
| `get_fulltext` | `attachmentKey?`, `maxChars?` | The PDF's extracted text (Zotero fulltext index). |

`attachmentKey` defaults to the currently-open paper for every tool.

## Requirements

- **Zotero running** with the **Obzo Bridge** plugin (provides `/obzo/current`).
- **Node 18+** (uses global `fetch`).
- For `get_content`: the **Obsidian vault path** (to read the plugin's cache),
  passed as `OBZO_VAULT`.

## Build

```bash
cd obzo-mcp && npm install && npm run build   # -> dist/index.js
```

## Configure your client

### Claude Code
```bash
claude mcp add obzo \
  -e OBZO_VAULT=/Users/chrix/Documents/Obsidian \
  -- node /Users/chrix/Projects/obzo-complete/obzo-mcp/dist/index.js
```

### Claude Desktop / Claudian / Codex (JSON config)
```json
{
  "mcpServers": {
    "obzo": {
      "command": "node",
      "args": ["/Users/chrix/Projects/obzo-complete/obzo-mcp/dist/index.js"],
      "env": { "OBZO_VAULT": "/Users/chrix/Documents/Obsidian" }
    }
  }
}
```

Environment variables: `OBZO_VAULT` (for `get_content`), `OBZO_ZOTERO_PORT`
(default `23119`), `OBZO_ZOTERO_USER` (default `0` — the local-API alias).

## Example agent request

> "Read my blue highlights on the current paper, turn each into a definition,
>  and append them to this note with a Zotero backlink."

The agent calls `current_paper` → `list_annotations {color:"#2ea8e5"}`, drafts
the definitions on its own subscription, and writes them into your note (it has
file access in Claudian / Claude Code) with each highlight's `backlink`.
