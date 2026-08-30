#!/usr/bin/env node
/**
 * Obzo MCP server — exposes the Zotero paper you're reading to any MCP client
 * (Claude Code, Codex, Cursor, Claudian, …). Read-only tools:
 *   current_paper     — what's open in Zotero's reader
 *   list_annotations  — your highlights (text, comment, color, page, key)
 *   get_content       — equations / statements / figures from Obzo's cache
 *   get_fulltext      — the PDF's extracted text (Zotero fulltext index)
 *
 * Config via env: OBZO_ZOTERO_PORT (default 23119), OBZO_ZOTERO_USER
 * (default "0" — the local-API alias), OBZO_VAULT (path to the Obsidian vault,
 * needed by get_content to read the plugin's cache).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ZOTERO_PORT = process.env.OBZO_ZOTERO_PORT ?? "23119";
const ZOTERO_USER = process.env.OBZO_ZOTERO_USER ?? "0";
const VAULT = process.env.OBZO_VAULT ?? "";
const BASE = `http://127.0.0.1:${ZOTERO_PORT}`;
const HEADERS = { "Zotero-Allowed-Request": "true" };

async function zoteroGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Zotero ${path} → HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}

async function currentReading(): Promise<any> {
  return zoteroGet("/obzo/current");
}

async function resolveKey(attachmentKey?: string): Promise<string> {
  if (attachmentKey) return attachmentKey;
  const cur = await currentReading();
  const key = cur?.attachment?.key;
  if (!key) {
    throw new Error("No PDF open in Zotero, and no attachmentKey was given.");
  }
  return key;
}

async function readCache(): Promise<Record<string, any>> {
  if (!VAULT) {
    throw new Error("OBZO_VAULT is not set (needed to read extracted content).");
  }
  const p = join(
    VAULT,
    ".obsidian",
    "plugins",
    "obzo-complete",
    "equation-cache.json"
  );
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return {};
  }
}

function text(obj: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

function errText(e: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${e instanceof Error ? e.message : String(e)}`,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({ name: "obzo", version: "0.1.0" });

server.registerTool(
  "current_paper",
  {
    description:
      "The paper currently open in the Zotero reader: title, authors, date, DOI, abstract, citation key, the attachmentKey (use it with the other tools), and the current page.",
    inputSchema: {},
  },
  async () => {
    try {
      const cur = await currentReading();
      const it = cur?.item ?? {};
      return text({
        open: cur?.open,
        title: it.title,
        creators: it.creators,
        date: it.date,
        DOI: it.DOI,
        url: it.url,
        publicationTitle: it.publicationTitle,
        abstract: it.abstractNote,
        citationKey: it.citationKey,
        attachmentKey: cur?.attachment?.key,
        page: cur?.page,
        selectedAnnotations: cur?.selectedAnnotations ?? [],
      });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "list_annotations",
  {
    description:
      "List reader annotations (highlights) on the current paper — or a given attachmentKey. Each has: highlighted text, your comment, color (hex), page, annotation key, and a zotero:// backlink. Filter by color, or set selectedOnly to return just the annotation(s) currently selected in the reader.",
    inputSchema: {
      attachmentKey: z.string().optional(),
      color: z.string().optional(),
      selectedOnly: z.boolean().optional(),
    },
  },
  async ({ attachmentKey, color, selectedOnly }) => {
    try {
      const key = await resolveKey(attachmentKey);
      let selected: Set<string> | null = null;
      if (selectedOnly) {
        const cur = await currentReading();
        selected = new Set<string>(cur?.selectedAnnotations ?? []);
      }
      // Annotations are excluded from the default /children listing — filter for them.
      const children = await zoteroGet(
        `/api/users/${ZOTERO_USER}/items/${key}/children?itemType=annotation`
      );
      const anns = (Array.isArray(children) ? children : [])
        .filter((c: any) => c?.data?.itemType === "annotation")
        .map((c: any) => {
          const d = c.data;
          return {
            key: c.key,
            type: d.annotationType,
            color: d.annotationColor,
            page: d.annotationPageLabel,
            text: d.annotationText,
            comment: d.annotationComment,
            backlink: `zotero://open-pdf/library/items/${key}?annotation=${c.key}`,
          };
        })
        .filter(
          (a: any) =>
            !color || (a.color ?? "").toLowerCase() === color.toLowerCase()
        )
        .filter((a: any) => !selected || selected.has(a.key));
      return text({ attachmentKey: key, count: anns.length, annotations: anns });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_content",
  {
    description:
      "Extracted content for the current paper (or attachmentKey) from Obzo's MinerU cache: equations (LaTeX), statements (theorems/definitions/assumptions), figures. Each item carries the ready-to-insert markdown and page. Filter by kind and/or a text query.",
    inputSchema: {
      attachmentKey: z.string().optional(),
      kind: z.enum(["equation", "statement", "figure", "all"]).optional(),
      query: z.string().optional(),
      limit: z.number().optional(),
    },
  },
  async ({ attachmentKey, kind, query, limit }) => {
    try {
      const key = await resolveKey(attachmentKey);
      const entry = (await readCache())[key];
      if (!entry) {
        return text({
          attachmentKey: key,
          note: "No extracted content cached — run 'Extract this paper' in Obsidian first.",
          equations: [],
          statements: [],
          figures: [],
        });
      }
      const pick = (arr: any[] = []) => {
        let items = arr.map((s) => ({
          kind: s.kind,
          label: s.label,
          page: typeof s.page === "number" ? s.page + 1 : undefined,
          markdown: s.insert,
        }));
        if (query) {
          const q = query.toLowerCase();
          items = items.filter(
            (s) =>
              (s.label ?? "").toLowerCase().includes(q) ||
              (s.markdown ?? "").toLowerCase().includes(q)
          );
        }
        if (typeof limit === "number") items = items.slice(0, limit);
        return items;
      };
      const want = kind ?? "all";
      const out: any = { attachmentKey: key };
      if (want === "all" || want === "equation") out.equations = pick(entry.equations);
      if (want === "all" || want === "statement") out.statements = pick(entry.statements);
      if (want === "all" || want === "figure") out.figures = pick(entry.figures);
      return text(out);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_fulltext",
  {
    description:
      "The extracted full text of the current paper's PDF (or a given attachmentKey), from Zotero's fulltext index. Truncated to maxChars (default 20000).",
    inputSchema: {
      attachmentKey: z.string().optional(),
      maxChars: z.number().optional(),
    },
  },
  async ({ attachmentKey, maxChars }) => {
    try {
      const key = await resolveKey(attachmentKey);
      const ft = await zoteroGet(
        `/api/users/${ZOTERO_USER}/items/${key}/fulltext`
      );
      const content = typeof ft?.content === "string" ? ft.content : "";
      const cap = maxChars ?? 20000;
      return text(
        content.length > cap
          ? `${content.slice(0, cap)}\n…[truncated; ${content.length} chars total]`
          : content
      );
    } catch (e) {
      return errText(e);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — log to stderr only.
  console.error(
    `[obzo-mcp] ready (zotero :${ZOTERO_PORT}, vault: ${VAULT || "unset"})`
  );
}

main().catch((e) => {
  console.error("[obzo-mcp] fatal:", e);
  process.exit(1);
});
