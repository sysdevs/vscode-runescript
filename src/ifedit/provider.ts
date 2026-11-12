// The visual `.if` / `.if3` editor: a CustomTextEditor over the real TextDocument (so undo, dirty
// state and the text view stay in sync). The host parses, renders and edits; the webview
// (media/ifedit/main.js) only shows pixels and sends intents back.
import { existsSync } from "fs";
import { basename, dirname, extname, join } from "path";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { settingPath } from "../client";
import { Content } from "../modelview/content";
import { buildIfModel, IfModelSpec } from "../modelview/ifmodel";
import { Scene } from "../modelview/scene";
import { Assets } from "./assets";
import { Intent, applyIntent, copyText, minimalEdit, reconcileIds } from "./edits";
import { parseHook } from "./hook";
import { Format, find, get, parseIf } from "./parse";
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

/** One `[clientscript]` as runescript-lsp's `runescript/clientScripts` lists it. */
interface ClientScript {
  name: string;
  /** `type $name` per parameter. */
  params: string[];
  location: { uri: string; range: { start: { line: number; character: number } } } | null;
}

export class IfEditorProvider implements vscode.CustomTextEditorProvider {
  private assets = new Map<string, Assets>();
  private contents = new Map<string, Content>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly client: () => LanguageClient | undefined) {}

  /** The clientscripts the language server knows ([] without a running server). */
  private async clientScripts(): Promise<ClientScript[]> {
    const c = this.client();
    if (!c || !c.isRunning()) return [];
    try {
      return await c.sendRequest<ClientScript[]>("runescript/clientScripts");
    } catch {
      return [];
    }
  }

  async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "ifedit");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const cfg = vscode.workspace.getConfiguration("runescript.interfaceEditor");
    const defaults = { zoom: cfg.get("zoom"), gridSize: cfg.get("gridSize"), grid: cfg.get("grid"), smartGuides: cfg.get("smartGuides") };
    panel.webview.html = html(panel.webview, media, defaults);

    const root = settingPath("contentRoot") || contentRootOf(doc.uri.fsPath);
    const fmt: Format = extname(doc.uri.fsPath) === ".if3" ? "if3" : "if";
    const stem = basename(doc.uri.fsPath, `.${fmt}`);
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

    let content = this.contents.get(root);
    if (!content) this.contents.set(root, (content = new Content(root)));
    // model components' meshes go in their own message, sent only when what they show changes
    // (frames are re-sent on every hover and edit); built meshes are cached by spec
    const meshes = new Map<string, Scene | undefined>();
    let sentModels = "";
    const models = (specs: { com: string; spec: IfModelSpec }[]) => {
      const key = JSON.stringify(specs);
      if (key === sentModels) return;
      sentModels = key;
      const out = specs.flatMap(({ com, spec }) => {
        const k = JSON.stringify(spec);
        if (!meshes.has(k)) meshes.set(k, buildIfModel(content!, spec));
        const scene = meshes.get(k);
        return scene && scene.faces > 0 ? [{ com, scene }] : [];
      });
      post({ type: "models", models: out });
    };

    let pending: NodeJS.Timeout | undefined;
    const frame = () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        const f = buildFrame(stem, doc.getText(), assets!, state, fmt);
        post({ ...f, view });
        models(f.modelSpecs);
      }, 0);
    };
    const catalog = () => post(buildCatalog(root, assets!, doc.getText(), fmt));
    let scripts: ClientScript[] = [];
    const sendScripts = async () => {
      scripts = await this.clientScripts();
      post({ type: "scripts", scripts: scripts.map((s) => ({ name: s.name, params: s.params })) });
    };

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "{sprites,fonts}/**"));
    const reload = () => {
      assets!.invalidate();
      catalog();
      frame();
    };
    const modelWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "{models/**,**/*.seq,pack/anim.pack}"));
    const reloadModels = () => {
      content!.invalidate();
      meshes.clear();
      sentModels = "";
      frame();
    };
    let queue: Promise<void> = Promise.resolve();
    const subs = [
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      watcher.onDidDelete(reload),
      modelWatcher,
      modelWatcher.onDidChange(reloadModels),
      modelWatcher.onDidCreate(reloadModels),
      modelWatcher.onDidDelete(reloadModels),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === doc.uri.toString()) frame();
      }),
      // interface.pack / .order follow the .if when it is saved, so discarding or undoing edits never strands ids
      // (the packer assigns .if3 ids itself)
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (fmt === "if" && e.document.uri.toString() === doc.uri.toString()) e.waitUntil(reconcileIdsOnDisk(root, stem, e.document.getText()));
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (fmt === "if3" && d.uri.fsPath.endsWith(".cs2")) void sendScripts();
      }),
      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case "ready":
            catalog();
            frame();
            if (fmt === "if3") void sendScripts();
            break;
          case "wantScripts":
            void sendScripts();
            break;
          case "openScript": {
            if (!scripts.some((s) => s.name === msg.name)) await sendScripts();
            const loc = scripts.find((s) => s.name === msg.name)?.location;
            if (!loc) {
              void vscode.window.showErrorMessage(`Interface editor: no clientscript ${msg.name} (is the RuneScript language server running?)`);
              break;
            }
            const at = new vscode.Position(loc.range.start.line, loc.range.start.character);
            await vscode.window.showTextDocument(vscode.Uri.parse(loc.uri), { selection: new vscode.Range(at, at), viewColumn: vscode.ViewColumn.Beside });
            break;
          }
          case "newScript":
            queue = queue.then(() => this.newScript(doc, stem, msg.com, msg.hook, scripts, post));
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
            queue = queue.then(() => this.apply(doc, stem, fmt, msg.intent as Intent, post));
            break;
          case "copy":
            await vscode.env.clipboard.writeText(copyText(stem, doc.getText(), msg.coms, fmt));
            break;
          case "paste": {
            const text = await vscode.env.clipboard.readText();
            queue = queue.then(() => this.apply(doc, stem, fmt, { kind: "paste", text, parent: msg.parent }, post));
            break;
          }
          case "rename":
            queue = queue.then(() => this.rename(doc, stem, fmt, msg.com, msg.to, post));
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
  private async apply(doc: vscode.TextDocument, stem: string, fmt: Format, intent: Intent, post: (msg: unknown) => void) {
    const old = doc.getText();
    let next: string;
    try {
      next = applyIntent(stem, old, intent, fmt);
    } catch (e) {
      void vscode.window.showErrorMessage(`Interface editor: ${(e as Error).message}`);
      return;
    }
    const edit = minimalEdit(old, next);
    if (!edit) return;
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.text);
    if (!(await vscode.workspace.applyEdit(we))) return;
    const before = new Set(parseIf(stem, old, fmt).coms.map((c) => c.name));
    const added = parseIf(stem, next, fmt).coms.map((c) => c.name).filter((n) => !before.has(n));
    if (added.length) post({ type: "select", names: added });
  }

  /**
   * Appends a `[clientscript,<name>](component $com)` stub to the area's `scripts/<stem>.cs2` (made if
   * missing), points the hook at it with `event_com` (keeping its trigger list) and opens the stub.
   */
  private async newScript(doc: vscode.TextDocument, stem: string, com: string, hook: string, scripts: ClientScript[], post: (msg: unknown) => void) {
    const name = await vscode.window.showInputBox({
      title: `New clientscript for ${com} ${hook}`,
      value: `${stem}_${com}_${hook.replace(/^on/, "")}`,
      validateInput: (v) => (!/^[A-Za-z0-9_]+$/.test(v) ? "letters, digits and _ only" : scripts.some((s) => s.name === v) ? `clientscript ${v} already exists` : undefined),
    });
    if (!name) return;
    // scripts/<area>/interfaces/<stem>.if3 -> scripts/<area>/scripts/<stem>.cs2
    const uri = vscode.Uri.file(join(dirname(dirname(doc.uri.fsPath)), "scripts", `${stem}.cs2`));
    const header = `[clientscript,${name}](component $com)`;
    const we = new vscode.WorkspaceEdit();
    if (existsSync(uri.fsPath)) {
      const cs2 = await vscode.workspace.openTextDocument(uri);
      const text = cs2.getText();
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const lead = text === "" ? "" : text.endsWith(eol) ? eol : eol + eol;
      we.insert(uri, cs2.positionAt(text.length), `${lead}${header}${eol}`);
    } else {
      we.createFile(uri, { contents: Buffer.from(`${header}\n`) });
    }
    if (!(await vscode.workspace.applyEdit(we))) return;
    const cs2 = await vscode.workspace.openTextDocument(uri);
    await cs2.save();
    let line = cs2.lineCount - 1;
    while (line > 0 && cs2.lineAt(line).text !== header) line--;
    const c = find(parseIf(stem, doc.getText(), "if3"), com);
    const old = c && get(c, hook);
    const triggers = old === undefined ? [] : parseHook(old).triggers;
    await this.apply(doc, stem, "if3", { kind: "hook", com, key: hook, hook: { script: name, args: ["event_com"], triggers } }, post);
    const at = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(cs2, { selection: new vscode.Range(at, at), viewColumn: vscode.ViewColumn.Beside });
  }

  /** Renames a component through the language server, which also updates scripts and interface.pack. */
  private async rename(doc: vscode.TextDocument, stem: string, fmt: Format, com: string, to: string, post: (msg: unknown) => void) {
    const c = find(parseIf(stem, doc.getText(), fmt), com);
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
}

/** Gives every component in `text` an id in interface.pack / .order and drops ids of components no longer there. */
export async function reconcileIdsOnDisk(root: string, stem: string, text: string) {
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
  <div id="stage"><div id="canvases"><canvas id="pixels"></canvas><canvas id="models"></canvas><canvas id="overlay"></canvas></div></div>
  <div id="side"></div>
</div>
<script nonce="${nonce}" src="${uri("main.js")}"></script>
</body>
</html>`;
}
