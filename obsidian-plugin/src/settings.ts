import { App, PluginSettingTab, Setting } from "obsidian";
import type ObzoPlugin from "./main";

export interface ObzoSettings {
  /** Port of Zotero's local HTTP server (default 23119). */
  zoteroPort: number;
  /** How often to poll Zotero for the current reader item, in ms. */
  pollIntervalMs: number;
  /** Free MinerU cloud API token (for equation -> LaTeX extraction). */
  mineruToken: string;
  /** Optional Anthropic API key for the Claude vision equation fallback. */
  anthropicApiKey: string;
  /** Master toggle for equation extraction (off = citations/terms/figures only). */
  enableEquations: boolean;
  /** Max size (MB) of the parsed-equation cache before least-recently-used papers are evicted. */
  cacheMaxMB: number;
  /** Append a zotero:// page backlink to inserted equations/figures/statements. */
  insertBacklinks: boolean;
  /** Insert format for theorem/definition/… statements. */
  statementFormat: "callout" | "blockquote" | "bold" | "heading" | "plain" | "custom";
  /** Custom statement template (used when statementFormat = "custom"). */
  statementTemplate: string;
  /** Insert format for equations. */
  equationFormat: "block" | "inline" | "custom";
  /** Custom equation template. */
  equationTemplate: string;
  /** Insert format for figures/tables. */
  figureFormat: "embed-caption" | "embed" | "image-caption" | "custom";
  /** Custom figure template. */
  figureTemplate: string;
  /** Trigger character for citation autocomplete. */
  citationTrigger: string;
  /** Trigger string for paper-context autocomplete (terms/figures/equations). */
  paperTrigger: string;
}

/** Preset insert templates. Placeholders are {name}; lines starting with `>`
 *  auto-prefix multi-line values (so callout/blockquote bodies stay quoted). */
export const STATEMENT_TEMPLATES: Record<string, string> = {
  callout: "> [!{kind}] {label}\n> {body}",
  blockquote: "> **{label}.** {body}",
  bold: "**{label}.** {body}",
  heading: "### {label}\n{body}",
  plain: "{label}. {body}",
};
export const EQUATION_TEMPLATES: Record<string, string> = {
  block: "$$\n{latex}\n$$",
  inline: "${latexInline}$",
};
export const FIGURE_TEMPLATES: Record<string, string> = {
  "embed-caption": "![[{path}]]\n*{caption}*",
  embed: "![[{path}]]",
  "image-caption": "![{caption}]({path})",
};

export const DEFAULT_SETTINGS: ObzoSettings = {
  zoteroPort: 23119,
  pollIntervalMs: 2000,
  mineruToken: "",
  anthropicApiKey: "",
  enableEquations: true,
  cacheMaxMB: 25,
  insertBacklinks: true,
  statementFormat: "callout",
  statementTemplate: STATEMENT_TEMPLATES.callout,
  equationFormat: "block",
  equationTemplate: EQUATION_TEMPLATES.block,
  figureFormat: "embed-caption",
  figureTemplate: FIGURE_TEMPLATES["embed-caption"],
  citationTrigger: "@",
  paperTrigger: ";;",
};

export class ObzoSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObzoPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obzo" });

    const status = containerEl.createEl("p", {
      cls: "obzo-settings-status",
      text: "Checking Zotero connection…",
    });
    this.plugin.bridge.ping().then((ok) => {
      status.setText(
        ok
          ? "✓ Connected to Zotero + Obzo Bridge."
          : "✗ Obzo Bridge not found. Install the companion plugin in Zotero and restart it."
      );
    });

    new Setting(containerEl)
      .setName("Zotero port")
      .setDesc("Port of Zotero's local server. Default 23119.")
      .addText((t) =>
        t
          .setPlaceholder("23119")
          .setValue(String(this.plugin.settings.zoteroPort))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n)) {
              this.plugin.settings.zoteroPort = n;
              this.plugin.bridge.setPort(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Fallback poll interval (ms)")
      .setDesc(
        "Updates are normally pushed instantly when you switch tabs in Zotero. This timer is only a fallback, used if your Zotero bridge is too old to support push."
      )
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.pollIntervalMs))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 500) {
              this.plugin.settings.pollIntervalMs = n;
              await this.plugin.saveSettings();
              this.plugin.restartPolling();
            }
          })
      );

    new Setting(containerEl)
      .setName("Citation trigger")
      .setDesc("Character that opens citation autocomplete (e.g. @).")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.citationTrigger)
          .onChange(async (v) => {
            this.plugin.settings.citationTrigger = v.slice(0, 1) || "@";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Paper trigger")
      .setDesc(
        "Opens autocomplete for terms, figures, and equations from the paper you're reading (e.g. ;;)."
      )
      .addText((t) =>
        t
          .setValue(this.plugin.settings.paperTrigger)
          .onChange(async (v) => {
            this.plugin.settings.paperTrigger = v.slice(0, 4) || ";;";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Insert Zotero backlinks")
      .setDesc(
        "Append a zotero:// link (jumps to the page in Zotero's reader) after inserted equations, figures and statements."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.insertBacklinks).onChange(async (v) => {
          this.plugin.settings.insertBacklinks = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Insert formats" });

    const wideTextArea = (
      get: () => string,
      set: (v: string) => Promise<void>
    ) => (t: any) => {
      t.setValue(get()).onChange(async (v: string) => set(v));
      t.inputEl.rows = 2;
      t.inputEl.style.width = "100%";
      t.inputEl.style.fontFamily = "var(--font-monospace)";
    };

    new Setting(containerEl)
      .setName("Statement format")
      .setDesc("Preset, or Custom to use your own template below.")
      .addDropdown((d) =>
        d
          .addOption("callout", "Callout  > [!theorem]")
          .addOption("blockquote", "Blockquote  > **Theorem 1.**")
          .addOption("bold", "Bold inline")
          .addOption("heading", "Heading  ### Theorem 1")
          .addOption("plain", "Plain text")
          .addOption("custom", "Custom template ↓")
          .setValue(this.plugin.settings.statementFormat)
          .onChange(async (v) => {
            this.plugin.settings.statementFormat =
              v as ObzoSettings["statementFormat"];
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("↳ Custom statement template")
      .setDesc(
        "Placeholders: {kind} {Kind} {label} {number} {body} {page}. Lines starting with > auto-quote multi-line values."
      )
      .addTextArea(
        wideTextArea(
          () => this.plugin.settings.statementTemplate,
          async (v) => {
            this.plugin.settings.statementTemplate = v;
            await this.plugin.saveSettings();
          }
        )
      );

    new Setting(containerEl)
      .setName("Equation format")
      .addDropdown((d) =>
        d
          .addOption("block", "Display block  $$…$$")
          .addOption("inline", "Inline  $…$")
          .addOption("custom", "Custom template ↓")
          .setValue(this.plugin.settings.equationFormat)
          .onChange(async (v) => {
            this.plugin.settings.equationFormat =
              v as ObzoSettings["equationFormat"];
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("↳ Custom equation template")
      .setDesc("Placeholders: {latex} {latexInline} {tag} {page}.")
      .addTextArea(
        wideTextArea(
          () => this.plugin.settings.equationTemplate,
          async (v) => {
            this.plugin.settings.equationTemplate = v;
            await this.plugin.saveSettings();
          }
        )
      );

    new Setting(containerEl)
      .setName("Figure format")
      .addDropdown((d) =>
        d
          .addOption("embed-caption", "Embed + caption")
          .addOption("embed", "Embed only")
          .addOption("image-caption", "Markdown image + caption")
          .addOption("custom", "Custom template ↓")
          .setValue(this.plugin.settings.figureFormat)
          .onChange(async (v) => {
            this.plugin.settings.figureFormat =
              v as ObzoSettings["figureFormat"];
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("↳ Custom figure template")
      .setDesc("Placeholders: {path} {caption} {kind} {Kind} {page}.")
      .addTextArea(
        wideTextArea(
          () => this.plugin.settings.figureTemplate,
          async (v) => {
            this.plugin.settings.figureTemplate = v;
            await this.plugin.saveSettings();
          }
        )
      );

    containerEl.createEl("h3", { text: "Equations" });

    new Setting(containerEl)
      .setName("Enable equation extraction")
      .setDesc("Extract equations from the PDF as LaTeX via MinerU.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableEquations).onChange(async (v) => {
          this.plugin.settings.enableEquations = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("MinerU API token")
      .setDesc("Free token from mineru.net. Note: the cloud API uploads the PDF to MinerU's servers.")
      .addText((t) =>
        t
          .setPlaceholder("mineru token")
          .setValue(this.plugin.settings.mineruToken)
          .onChange(async (v) => {
            this.plugin.settings.mineruToken = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Equation cache limit (MB)")
      .setDesc(
        "Parsed equations are cached per paper so a PDF is only sent to MinerU once. When the cache exceeds this size, the least-recently-used papers are evicted."
      )
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.cacheMaxMB))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 1) {
              this.plugin.settings.cacheMaxMB = n;
              await this.plugin.saveSettings();
              if (this.plugin.enforceCacheLimit()) {
                await this.plugin.saveEqCache();
              }
            }
          })
      );

    new Setting(containerEl)
      .setName("Anthropic API key (optional)")
      .setDesc("Enables the Claude vision fallback for extracting a single equation region.")
      .addText((t) =>
        t
          .setPlaceholder("sk-ant-…")
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (v) => {
            this.plugin.settings.anthropicApiKey = v.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
