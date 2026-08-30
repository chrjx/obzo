/* Obzo Bridge — Zotero 7 companion plugin
 *
 * Registers two endpoints on Zotero's built-in HTTP server (port 23119):
 *
 *   GET /obzo/ping     -> { ok, plugin, version, push }
 *   GET /obzo/current  -> the PDF open in the active reader tab, plus the
 *                         parent item's metadata (title, creators, DOI,
 *                         abstract, Better BibTeX citekey) and the file path.
 *   GET /obzo/wait     -> long-poll: blocks until the active reader tab
 *                         changes (or a ~25s heartbeat), then returns the same
 *                         payload as /obzo/current. Lets the client be pushed
 *                         updates instead of polling on a timer.
 *
 * Zotero's server treats requests with no Origin header (curl, Obsidian's
 * requestUrl) as trusted, so no extra auth is needed for local use.
 */

var PLUGIN_VERSION = "0.3.0";

function log(msg) {
  try {
    Zotero.debug("[Obzo] " + msg);
  } catch (e) {
    /* Zotero not ready */
  }
}

function jsonResponse(status, obj) {
  return [status, "application/json", JSON.stringify(obj, null, 2)];
}

/* ------------------------------------------------------------------ *
 * Item description helpers
 * ------------------------------------------------------------------ */

function safeField(item, field) {
  try {
    return item.getField(field) || null;
  } catch (e) {
    return null;
  }
}

function getCitationKey(item) {
  try {
    if (Zotero.BetterBibTeX && Zotero.BetterBibTeX.KeyManager) {
      const k = Zotero.BetterBibTeX.KeyManager.get(item.id);
      if (k && k.citationKey) return k.citationKey;
    }
  } catch (e) {
    /* BBT not installed / not ready */
  }
  return null;
}

function describeItem(item) {
  let creators = [];
  try {
    creators = item.getCreators().map(function (c) {
      return {
        firstName: c.firstName || "",
        lastName: c.lastName || c.name || "",
        creatorType: c.creatorTypeID
          ? Zotero.CreatorTypes.getName(c.creatorTypeID)
          : null,
      };
    });
  } catch (e) {
    /* ignore */
  }

  let itemType = null;
  try {
    itemType = Zotero.ItemTypes.getName(item.itemTypeID);
  } catch (e) {
    /* ignore */
  }

  return {
    key: item.key,
    libraryID: item.libraryID,
    itemType: itemType,
    title: safeField(item, "title"),
    date: safeField(item, "date"),
    DOI: safeField(item, "DOI"),
    url: safeField(item, "url"),
    publicationTitle: safeField(item, "publicationTitle"),
    abstractNote: safeField(item, "abstractNote"),
    creators: creators,
    citationKey: getCitationKey(item),
  };
}

async function describeAttachment(att) {
  let path = null;
  try {
    path = await att.getFilePathAsync();
  } catch (e) {
    /* file may be missing / not downloaded */
  }
  return {
    key: att.key,
    libraryID: att.libraryID,
    contentType: att.attachmentContentType || null,
    filename: att.attachmentFilename || null,
    path: path || null,
  };
}

async function describeBestAttachment(item) {
  try {
    const best = await item.getBestAttachment();
    if (best) return await describeAttachment(best);
  } catch (e) {
    /* ignore */
  }
  return null;
}

function readerPageIndex(reader) {
  // The current page lives in the internal reader's primary view stats.
  try {
    var r = reader._internalReader;
    if (
      r && r._state && r._state.primaryViewStats &&
      typeof r._state.primaryViewStats.pageIndex === "number"
    ) {
      return r._state.primaryViewStats.pageIndex;
    }
  } catch (e) {
    /* ignore */
  }
  // Fallbacks for other versions.
  try {
    var r2 = reader._internalReader || reader;
    if (r2 && r2._state && typeof r2._state.pageIndex === "number") {
      return r2._state.pageIndex;
    }
    if (r2 && r2.state && typeof r2.state.pageIndex === "number") {
      return r2.state.pageIndex;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

// Annotation keys currently selected in the reader.
function readerSelectedAnnotations(reader) {
  var out = [];
  try {
    var r = reader._internalReader;
    var ids = r && r._selectedAnnotationIDs;
    if (Array.isArray(ids)) {
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (typeof id === "string") {
          out.push(id); // reader annotation ids are Zotero item keys
        } else if (typeof id === "number") {
          try {
            var it = Zotero.Items.get(id);
            if (it) out.push(it.key);
          } catch (e) {
            /* ignore */
          }
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Core: what is the user reading right now?
 * ------------------------------------------------------------------ */

async function getCurrentReaderItem() {
  const win = Zotero.getMainWindow();
  if (!win || !win.Zotero_Tabs) {
    return { open: false, reason: "no-main-window" };
  }

  const tabID = win.Zotero_Tabs.selectedID;
  let reader = null;
  try {
    if (Zotero.Reader && Zotero.Reader.getByTabID) {
      reader = Zotero.Reader.getByTabID(tabID);
    }
  } catch (e) {
    /* ignore */
  }
  if (!reader && Zotero.Reader && Zotero.Reader._readers) {
    reader =
      Zotero.Reader._readers.find(function (r) {
        return r.tabID === tabID;
      }) || null;
  }

  // No reader focused: fall back to whatever is selected in the library pane.
  if (!reader) {
    let top = null;
    try {
      const pane = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
      const selected = pane && pane.getSelectedItems ? pane.getSelectedItems() : [];
      if (selected && selected.length) {
        const first = selected[0];
        top = first.isAttachment()
          ? first.parentItem || first
          : first;
      }
    } catch (e) {
      /* ignore */
    }
    return {
      open: false,
      source: "selection",
      item: top ? describeItem(top) : null,
      attachment: top ? await describeBestAttachment(top) : null,
    };
  }

  const attachment = Zotero.Items.get(reader.itemID);
  const parent =
    attachment && attachment.parentItem ? attachment.parentItem : attachment;

  return {
    open: true,
    source: "reader",
    tabID: tabID,
    page: readerPageIndex(reader),
    selectedAnnotations: readerSelectedAnnotations(reader),
    item: parent ? describeItem(parent) : null,
    attachment: attachment ? await describeAttachment(attachment) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Change notifications: observe Zotero tab selection so clients can
 * long-poll for updates instead of polling on a timer. Zotero fires
 * Notifier 'tab' events (select/add/close/load) on every tab change.
 * ------------------------------------------------------------------ */

var changeSeq = 0; // bumped whenever the active tab changes
var lastServedSeq = -1; // highest seq handed to a waiting client
var waiters = []; // pending long-poll resolvers
var notifierID = null;

function later(fn, ms) {
  try {
    if (typeof setTimeout === "function") return setTimeout(fn, ms);
  } catch (e) {
    /* fall through */
  }
  var win = Zotero.getMainWindow();
  return win && win.setTimeout ? win.setTimeout(fn, ms) : null;
}

function fireChange() {
  changeSeq++;
  var pending = waiters;
  waiters = [];
  for (var i = 0; i < pending.length; i++) {
    try {
      pending[i]();
    } catch (e) {
      /* ignore */
    }
  }
}

// Resolves as soon as the active tab changes; falls back to a ~25s heartbeat
// so the client refreshes periodically and can detect a dropped connection.
function waitForChange() {
  if (changeSeq !== lastServedSeq) {
    lastServedSeq = changeSeq;
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    var done = false;
    var settle = function () {
      if (done) return;
      done = true;
      lastServedSeq = changeSeq;
      resolve();
    };
    waiters.push(settle);
    later(function () {
      var i = waiters.indexOf(settle);
      if (i !== -1) waiters.splice(i, 1);
      settle();
    }, 25000);
  });
}

function drainWaiters() {
  var pending = waiters;
  waiters = [];
  for (var i = 0; i < pending.length; i++) {
    try {
      pending[i]();
    } catch (e) {
      /* ignore */
    }
  }
}

async function currentWithSeq() {
  var data = await getCurrentReaderItem();
  data.seq = changeSeq;
  return data;
}

function registerNotifier() {
  try {
    var observer = {
      notify: function (event, type /*, ids, extraData */) {
        if (type === "tab") fireChange();
      },
    };
    notifierID = Zotero.Notifier.registerObserver(
      observer,
      ["tab"],
      "obzo-bridge"
    );
    log("tab notifier registered");
  } catch (e) {
    log("failed to register notifier: " + e);
  }
}

function unregisterNotifier() {
  try {
    if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
  } catch (e) {
    /* ignore */
  }
  notifierID = null;
}

/* ------------------------------------------------------------------ *
 * HTTP endpoints. Support both the modern promise-return signature and
 * the older (data, sendResponseCallback) signature so this keeps working
 * across Zotero versions.
 * ------------------------------------------------------------------ */

function makeEndpoint(handler) {
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: ["GET"],
    supportedDataTypes: ["application/json"],
    init: function (requestData, sendResponseCallback) {
      const p = Promise.resolve()
        .then(handler)
        .then(function (data) {
          return jsonResponse(200, data);
        })
        .catch(function (e) {
          log("endpoint error: " + e + "\n" + (e && e.stack));
          return jsonResponse(500, { error: String(e) });
        });

      if (typeof sendResponseCallback === "function") {
        p.then(function (res) {
          sendResponseCallback(res[0], res[1], res[2]);
        });
        return;
      }
      return p;
    },
  };
  return Endpoint;
}

function registerEndpoints() {
  Zotero.Server.Endpoints["/obzo/ping"] = makeEndpoint(function () {
    return { ok: true, plugin: "obzo-bridge", version: PLUGIN_VERSION, push: true };
  });
  Zotero.Server.Endpoints["/obzo/current"] = makeEndpoint(currentWithSeq);
  Zotero.Server.Endpoints["/obzo/wait"] = makeEndpoint(function () {
    return waitForChange().then(currentWithSeq);
  });
  log("endpoints registered: /obzo/ping, /obzo/current, /obzo/wait");
}

function unregisterEndpoints() {
  var paths = ["/obzo/ping", "/obzo/current", "/obzo/wait"];
  for (var i = 0; i < paths.length; i++) {
    try {
      delete Zotero.Server.Endpoints[paths[i]];
    } catch (e) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Bootstrap lifecycle
 * ------------------------------------------------------------------ */

function install() {}
function uninstall() {}

async function startup({ id, version }) {
  if (version) PLUGIN_VERSION = version;
  await Zotero.initializationPromise;
  registerEndpoints();
  registerNotifier();
  log("startup complete (v" + PLUGIN_VERSION + ")");
}

function shutdown() {
  unregisterNotifier();
  drainWaiters();
  unregisterEndpoints();
  log("shutdown");
}
