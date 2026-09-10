# Zob MCP server

Exposes the Zotero paper you're currently reading to **any MCP client** (Claude
Code, Codex, Cursor, Claudian, Claude Desktop, …). The client's own model —
including a Claude Pro/Max or ChatGPT subscription via its CLI — does the
reasoning; **no API key is needed here.** Zob is just the context provider.

## Tools (read-only)

| Tool | Args | Returns |
| --- | --- | --- |
| `current_paper` | — | The paper open in Zotero's reader: title, authors, DOI, abstract, `attachmentKey`, current `page`, and `selectedAnnotations` (keys selected in the reader). |
| `list_annotations` | `attachmentKey?`, `color?`, `selectedOnly?` | Your highlights: text, comment, color, page, annotation key, `zotero://…?annotation=` backlink. `selectedOnly` returns just the annotation(s) selected in the reader right now. |
| `get_content` | `attachmentKey?`, `kind?` (`equation`/`statement`/`figure`/`all`), `query?`, `limit?` | Extracted content from Zob's MinerU cache, with ready-to-insert markdown + page. |
| `get_blocks` | `attachmentKey?`, `query?`, `limit?` | Prose blocks (paragraph + its equations + section heading). Read them, semantically pick the one matching the user's phrase, insert its markdown. |
| `get_fulltext` | `attachmentKey?`, `maxChars?` | The PDF's extracted text (Zotero fulltext index). |
| `insert_into_note` | `markdown`, `note_path?`, `mode?` (`append`/`prepend`/`create`) | Writes Markdown into a vault note (defaults to the Zob inbox). Returns the path. |

`attachmentKey` defaults to the currently-open paper for every read tool.

## Prompts (workflow templates)

| Prompt | Args | What it does |
| --- | --- | --- |
| `summarize_annotation` | `kind?` | Turn the selected (or most recent) Zotero highlight into a clean definition/theorem/claim and insert it, with a backlink. |
| `paper_note` | — | Draft a structured literature note for the current paper (metadata, key theorems/equations, your annotations) and save it. |

## Requirements

- **Zotero running** with the **Zob Bridge** plugin (provides `/obzo/current`).
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

Environment variables: `OBZO_VAULT` (for `get_content`, `get_blocks`, and
`insert_into_note`), `OBZO_INBOX` (default note for writes, default
`Zob Inbox.md`), `OBZO_ZOTERO_PORT` (default `23119`), `OBZO_ZOTERO_USER`
(default `0` — the local-API alias).

## Running on a local agent (your subscription, no API key)

Both major coding agents run **locally on your existing subscription** and can
drive this server — no Anthropic/OpenAI API key required:

- **Claude Code** authenticates with your **Claude Pro/Max** login. Add the
  server with `claude mcp add obzo …` (above); drive it interactively, or
  headless with `claude -p "…"` for scripting. Claude Code can also *be* an MCP
  server (`claude mcp serve`).
- **Codex** runs on your **ChatGPT** plan via its local app/CLI; point its MCP
  config at the JSON above.
- **Claudian** embeds these agent CLIs *inside Obsidian*, so the whole
  read → reason → write loop happens in your vault on your subscription.

This is why Zob is a context provider, not an LLM caller: the agent you already
pay for does the reasoning, and Zob supplies the paper, annotations, extracted
content, and blocks — and writes the result back with `insert_into_note`.

## Example agent request

> "Read my blue highlights on the current paper, turn each into a definition,
>  and append them to this note with a Zotero backlink."

The agent calls `current_paper` → `list_annotations {color:"#2ea8e5"}`, drafts
the definitions on its own subscription, and writes them into your note (it has
file access in Claudian / Claude Code) with each highlight's `backlink`.
