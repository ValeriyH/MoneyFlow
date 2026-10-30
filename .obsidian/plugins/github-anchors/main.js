const { Plugin, PluginSettingTab, Setting, debounce } = require("obsidian");
const { ViewPlugin, Decoration } = require("@codemirror/view");
const { RangeSetBuilder } = require("@codemirror/state");
const { syntaxTree } = require("@codemirror/language");

const DEFAULT_SETTINGS = { highlightBroken: true };

// Прибирає markdown-розмітку із тексту заголовка, як це робить GitHub
function stripMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")          // картинки
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")     // [[note|alias]]
    .replace(/\[\[([^\]]*)\]\]/g, "$1")                // [[note]]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")           // [text](url)
    .replace(/<[^>]+>/g, "")                           // html-теги
    .replace(/`([^`]*)`/g, "$1")                       // `code`
    .replace(/(\*\*|__|~~|\*)/g, "");                  // **bold**, *italic*, ~~strike~~
}

// Алгоритм слагів GitHub: нижній регістр, прибрати пунктуацію, пробіли -> дефіси
function githubSlug(text) {
  return stripMarkdown(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} \-]/gu, "")
    .replace(/ /g, "-");
}

// Повертає масив { slug, heading } з урахуванням дублікатів (-1, -2, ...)
function buildSlugs(headings) {
  const used = new Map();
  const result = [];
  for (const h of headings) {
    const base = githubSlug(h.heading);
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    result.push({ slug: count === 0 ? base : `${base}-${count}`, heading: h.heading });
  }
  return result;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

module.exports = class GithubAnchorsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new GithubAnchorsSettingTab(this.app, this));

    this.patchWorkspace();
    this.setupBrokenHighlight();
  }

  // ---------- Перехоплення відкриття посилань і попапів ----------

  patchWorkspace() {
    const workspace = this.app.workspace;
    const plugin = this;

    const original = workspace.openLinkText;
    workspace.openLinkText = function (linktext, sourcePath, ...rest) {
      try {
        const r = plugin.check(linktext, sourcePath);
        if (r.status === "fixed") linktext = r.linktext;
      } catch (e) {
        console.error("[github-anchors]", e);
      }
      return original.call(this, linktext, sourcePath, ...rest);
    };

    // Попапи: підміняємо linktext у події hover-link
    const originalTrigger = workspace.trigger;
    workspace.trigger = function (name, ...args) {
      if (name === "hover-link" && args[0] && typeof args[0].linktext === "string") {
        try {
          const r = plugin.check(args[0].linktext, args[0].sourcePath || "");
          if (r.status === "fixed") args[0].linktext = r.linktext;
        } catch (e) {
          console.error("[github-anchors]", e);
        }
      }
      return originalTrigger.call(this, name, ...args);
    };

    this.register(() => {
      workspace.openLinkText = original;
      workspace.trigger = originalTrigger;
    });
  }

  // ---------- Перевірка якоря ----------
  // status: "skip" (не наша справа) | "ok" | "fixed" (є GitHub-збіг) | "broken"
  check(linktext, sourcePath) {
    const hashIndex = linktext.indexOf("#");
    if (hashIndex === -1) return { status: "skip", linktext };

    const path = linktext.slice(0, hashIndex);
    let anchor = safeDecode(linktext.slice(hashIndex + 1));
    // порожній якір, посилання на блок або вкладений шлях заголовків (A#B)
    if (!anchor || anchor.startsWith("^") || anchor.includes("#")) {
      return { status: "skip", linktext };
    }

    const cache = this.app.metadataCache;
    const file = path
      ? cache.getFirstLinkpathDest(safeDecode(path), sourcePath)
      : this.app.vault.getAbstractFileByPath(sourcePath);
    if (!file || file.extension !== "md") return { status: "skip", linktext };

    const fileCache = cache.getFileCache(file);
    if (!fileCache) return { status: "skip", linktext }; // ще не проіндексовано
    const headings = fileCache.headings || [];

    const lower = anchor.toLowerCase();
    if (headings.some((h) => h.heading === anchor || h.heading.toLowerCase() === lower)) {
      return { status: "ok", linktext };
    }

    const match = buildSlugs(headings).find((s) => s.slug === lower);
    if (match) return { status: "fixed", linktext: path + "#" + match.heading };

    return { status: "broken", linktext };
  }

  // ---------- Підсвічування зламаних якорів ----------

  setupBrokenHighlight() {
    const plugin = this;

    // Режим читання
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!plugin.settings.highlightBroken) return;
      el.querySelectorAll("a.internal-link").forEach((a) => {
        const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
        if (plugin.check(href, ctx.sourcePath).status === "broken") {
          a.addClass("ga-broken-anchor");
          a.setAttribute("title", "Якір не знайдено: у нотатці немає такого заголовка");
        }
      });
    });

    // Live Preview / редактор
    const linkRe = /\[[^\]\n]*\]\(([^)\n]*)\)/g;
    const editorExt = ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.decorations = this.build(view);
        }
        update(u) {
          if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.reconfigured)) {
            this.decorations = this.build(u.view);
          }
        }
        build(view) {
          if (!plugin.settings.highlightBroken) return Decoration.none;
          const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? "";
          const builder = new RangeSetBuilder();
          const tree = syntaxTree(view.state);

          for (const { from, to } of view.visibleRanges) {
            const text = view.state.sliceDoc(from, to);
            const re = new RegExp(linkRe.source, "g");
            let m;
            while ((m = re.exec(text))) {
              if (m.index > 0 && text[m.index - 1] === "!") continue; // зображення
              let href = m[1].trim();
              if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
              href = href.replace(/\s+".*"$/, ""); // title у лапках
              if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // http:, mailto: тощо
              if (!href.includes("#")) continue;

              const start = from + m.index;
              const end = start + m[0].length;
              try {
                const node = tree.resolveInner
                  ? tree.resolveInner(start, 1)
                  : tree.resolve(start, 1);
                if (/code/i.test(node.name)) continue; // всередині коду
              } catch (_) {}

              if (plugin.check(href, sourcePath).status === "broken") {
                builder.add(start, end, Decoration.mark({ class: "ga-broken-anchor" }));
              }
            }
          }
          return builder.finish();
        }
      },
      { decorations: (v) => v.decorations }
    );
    this.registerEditorExtension(editorExt);

    // Оновлення при зміні заголовків
    const refresh = debounce(() => this.refreshViews(false), 500, true);
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
  }

  refreshViews(rerenderReading) {
    this.app.workspace.updateOptions();
    if (rerenderReading) {
      this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
        leaf.view?.previewMode?.rerender?.(true);
      });
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshViews(true);
  }
};

class GithubAnchorsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Підсвічувати зламані якорі")
      .setDesc(
        "Посилання виду [текст](#якір) або [[Нотатка#якір]], для яких у нотатці немає відповідного заголовка, підсвічуються червоним."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.highlightBroken).onChange(async (value) => {
          this.plugin.settings.highlightBroken = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
