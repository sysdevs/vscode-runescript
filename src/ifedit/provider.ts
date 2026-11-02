// The visual `.if` editor: a CustomTextEditor over the real TextDocument (so undo, dirty
// state and the text view stay in sync). The host parses, renders and edits; the webview
// (media/ifedit/main.js) only shows pixels and sends intents back.
import { existsSync } from "fs";
import { basename, dirname, join } from "path";
import * as vscode from "vscode";
import { settingPath } from "../client";
import { Assets } from "./assets";
import { Intent, applyIntent, copyText, minimalEdit, reconcileIds } from "./edits";
import { find, parseIf } from "./parse";
import { Area, PreviewState } from "./render";
import { buildCatalog, buildFrame } from "./session";

export const VIEW_TYPE = "runescript.ifEditor";

/** Editor-only layer state, remembered per file: never written to the `.if`. */
interface View {
  hidden: string[];
  locked: string[];
  collapsed: string[];
}

/** The first ancestor directory holding pack/interface.pack. */
export function contentRootOf(file: string): string | undefined {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pack", "interface.pack"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

export class IfEditorProvider implements vscode.CustomTextEditorProvider {
  private assets = new Map<string, Assets>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "ifedit");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const cfg = vscode.workspace.getConfiguration("runescript.interfaceEditor");
    const defaults = { zoom: cfg.get("zoom"), gridSize: cfg.get("gridSize"), grid: cfg.get("grid"), smartGuides: cfg.get("smartGuides") };
    panel.webview.html = html(panel.webview, media, defaults);

    const root = settingPath("contentRoot") || contentRootOf(doc.uri.fsPath);
    const stem = basename(doc.uri.fsPath, ".if");
    const areaKey = `ifedit.area:${doc.uri.fsPath}`;
    const viewKey = `ifedit.view:${doc.uri.fsPath}`;
    let view: View = { hidden: [], locked: [], collapsed: [], ...this.ctx.workspaceState.get<Partial<View>>(viewKey, {}) };
    const state: PreviewState = {
      area: this.ctx.workspaceState.get<Area>(areaKey, "main"),
      active: false,
      mouse: null,
      showHidden: false,
      scroll: {},
      vars: ["0", "0", "0", "0", "0"],
      hidden: view.hidden,
    };
    const post = (msg: unknown) => void panel.webview.postMessage(msg);
    if (!root) {
      post({ type: "error", message: "No Content root (a folder with pack/interface.pack) above this file; set runescript.contentRoot." });
      return;
    }
    let assets = this.assets.get(root);
    if (!assets) this.assets.set(root, (assets = new Assets(root)));

    let pending: NodeJS.Timeout | undefined;
    const frame = () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        post({ ...buildFrame(stem, doc.getText(), assets!, state), view });
      }, 0);
    };
    const catalog = () => post(buildCatalog(root, assets!, doc.getText()));

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "{sprites,fonts}/**"));
    const reload = () => {
      assets!.invalidate();
      catalog();
      frame();
    };
    let queue: Promise<void> = Promise.resolve();
    const subs = [
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === doc.uri.toString()) frame();
      }),
      // interface.pack / .order follow the .if when it is saved, so discarding or undoing edits never strands ids
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.toString() === doc.uri.toString()) e.waitUntil(this.reconcile(root, stem, e.document.getText()));
      }),
      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case "ready":
            catalog();
            frame();
            break;
          case "state":
            Object.assign(state, msg.state);
            if (msg.state.area) void this.ctx.workspaceState.update(areaKey, state.area);
            frame();
            break;
          case "view":
            view = { ...view, ...msg.view };
            state.hidden = view.hidden;
            void this.ctx.workspaceState.update(viewKey, view);
            frame();
            break;
          case "intent":
            // one at a time: each intent is computed against the text the previous one left
            queue = queue.then(() => this.apply(doc, stem, msg.intent as Intent, post));
            break;
          case "copy":
            await vscode.env.clipboard.writeText(copyText(stem, doc.getText(), msg.coms));
            break;
          case "paste": {
            const text = await vscode.env.clipboard.readText();
            queue = queue.then(() => this.apply(doc, stem, { kind: "paste", text, parent: msg.parent }, post));
            break;
          }
          case "rename":
            queue = queue.then(() => this.rename(doc, stem, msg.com, msg.to, post));
            break;
          case "openText":
            await vscode.commands.executeCommand("vscode.openWith", doc.uri, "default");
            break;
        }
      }),
    ];
    panel.onDidDispose(() => subs.forEach((d) => d.dispose()));
  }

  /** Applies one intent to the `.if` as a single minimal edit (undoable like typing), then selects new components. */
  private async apply(doc: vscode.TextDocument, stem: string, intent: Intent, post: (msg: unknown) => void) {
    const old = doc.getText();
    let next: string;
    try {
      next = applyIntent(stem, old, intent);
    } catch (e) {
      void vscode.window.showErrorMessage(`Interface editor: ${(e as Error).message}`);
      return;
    }
    const edit = minimalEdit(old, next);
    if (!edit) return;
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.text);
    if (!(await vscode.workspace.applyEdit(we))) return;
    const before = new Set(parseIf(stem, old).coms.map((c) => c.name));
    const added = parseIf(stem, next).coms.map((c) => c.name).filter((n) => !before.has(n));
    if (added.length) post({ type: "select", names: added });
  }

  /** Renames a component through the language server, which also updates scripts and interface.pack. */
  private async rename(doc: vscode.TextDocument, stem: string, com: string, to: string, post: (msg: unknown) => void) {
    const c = find(parseIf(stem, doc.getText()), com);
    if (!c || to === com) return;
    if (!/^[A-Za-z0-9_]+$/.test(to)) {
      void vscode.window.showErrorMessage(`Interface editor: "${to}" is not a valid component name.`);
      return;
    }
    let edit: vscode.WorkspaceEdit | undefined;
    try {
      edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", doc.uri, new vscode.Position(c.header, 1), to);
    } catch (e) {
      void vscode.window.showErrorMessage(`Interface editor: ${(e as Error).message}`);
      return;
    }
    if (!edit || edit.size === 0) {
      void vscode.window.showErrorMessage("Interface editor: rename needs the RuneScript language server.");
      return;
    }
    if (await vscode.workspace.applyEdit(edit)) post({ type: "select", names: [to] });
  }

  /** Gives every component in the saved text an id and drops ids of components no longer there. */
  private async reconcile(root: string, stem: string, text: string) {
    const coms = parseIf(stem, text).coms.map((c) => c.name);
    const pack = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, "pack", "interface.pack")));
    const order = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, "pack", "interface.order")));
    let ids: { pack: string; order: string };
    try {
      ids = reconcileIds(pack.getText(), order.getText(), stem, coms);
    } catch (e) {
      void vscode.window.showErrorMessage(`Interface editor: interface.pack not updated: ${(e as Error).message}`);
      return;
    }
    const we = new vscode.WorkspaceEdit();
    const changed: vscode.TextDocument[] = [];
    for (const [d, t] of [[pack, ids.pack], [order, ids.order]] as const) {
      const e = minimalEdit(d.getText(), t);
      if (!e) continue;
      we.replace(d.uri, new vscode.Range(d.positionAt(e.start), d.positionAt(e.end)), e.text);
      changed.push(d);
    }
    if (changed.length && (await vscode.workspace.applyEdit(we))) for (const d of changed) await d.save();
  }
}

/** `defaults` holds only numbers and booleans (the interfaceEditor settings), so it needs no escaping. */
function html(webview: vscode.Webview, media: vscode.Uri, defaults: object): string {
  const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join("");
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri("ifedit.css")}" rel="stylesheet">
<title>Interface Editor</title>
</head>
<body data-defaults='${JSON.stringify(defaults)}'>
<div id="toolbar"></div>
<div id="main">
  <div id="tree"></div>
  <div id="stage"><div id="canvases"><canvas id="pixels"></canvas><canvas id="overlay"></canvas></div></div>
  <div id="side"></div>
</div>
<script nonce="${nonce}" src="${uri("main.js")}"></script>
</body>
</html>`;
}
