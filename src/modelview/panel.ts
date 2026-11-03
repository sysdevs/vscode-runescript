// The model preview panel: one webview beside the editor that follows the config block under
// the cursor (npc, obj, loc, idk, spotanim). The host builds the scene (npc.ts, obj.ts, ...);
// the webview (media/modelview/main.js) only draws it and reports the chosen seq and view.
import * as vscode from "vscode";
import { settingPath } from "../client";
import { contentRootOf } from "../ifedit/provider";
import { Content } from "./content";
import { rgb15ForHsl16 } from "./colour";
import { clampFor, controlsFor, freeRecolSlot, keyEdits, recolSlots, withValue } from "./controls";
import { buildIdk } from "./idk";
import { buildLoc } from "./loc";
import { blockAt, BuildOptions, buildNpc } from "./npc";
import { buildObj } from "./obj";
import { Lines, Scene } from "./scene";
import { buildSpotanim } from "./spotanim";

/** The scene builder for each config language the preview handles. */
export const BUILDERS: Record<string, (content: Content, lines: Lines, opts: BuildOptions) => Scene> = {
  "runescript-npc": buildNpc,
  "runescript-obj": buildObj,
  "runescript-loc": buildLoc,
  "runescript-idk": buildIdk,
  "runescript-spotanim": buildSpotanim,
};

export class ModelPreview {
  private static current: ModelPreview | undefined;

  private readonly contents = new Map<string, Content>();
  private shown = "";
  private blockName = "";
  /** the dropdown's choice for the current block; undefined = its readyanim */
  private seq: string | undefined;
  /** the view dropdown's choice (kept across blocks; a block without it shows its first view) */
  private view: string | undefined;
  private pending: NodeJS.Timeout | undefined;
  /** values of sliders being dragged (undefined: key removed), shown before they are written */
  private readonly overrides = new Map<string, number | undefined>();
  /** a block picked from a CodeLens; cleared when the cursor moves */
  private pinned: { uri: string; line: number } | undefined;
  /** the block shown last, rebuilt when nothing else picks one */
  private last: { uri: string; line: number } | undefined;
  private readonly subs: vscode.Disposable[] = [];

  /** Opens (or reveals) the preview; `uri`/`line` pick the block to show instead of the cursor's. */
  static show(ctx: vscode.ExtensionContext, uri?: vscode.Uri, line?: number) {
    const pinned = uri && line !== undefined ? { uri: uri.toString(), line } : undefined;
    if (ModelPreview.current) {
      ModelPreview.current.pinned = pinned;
      ModelPreview.current.panel.reveal(vscode.ViewColumn.Beside, true);
      ModelPreview.current.update(true);
      return;
    }
    const media = vscode.Uri.joinPath(ctx.extensionUri, "media", "modelview");
    const panel = vscode.window.createWebviewPanel("runescript.modelPreview", "Model Preview", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    panel.webview.html = html(panel.webview, media);
    ModelPreview.current = new ModelPreview(panel);
    ModelPreview.current.pinned = pinned;
  }

  private constructor(private readonly panel: vscode.WebviewPanel) {
    const later = () => this.schedule();
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(later),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.pinned = undefined;
        later();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        // the shown file too: slider edits land while focus is in the preview
        if (e.document === vscode.window.activeTextEditor?.document || e.document.uri.toString() === this.last?.uri) later();
      }),
      panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === "ready") this.update(true);
        else if (msg.type === "seq") {
          this.seq = msg.seq;
          this.update(true);
        } else if (msg.type === "view") {
          this.view = msg.view;
          this.update(true);
        } else if (msg.type === "preview") {
          // a slider being dragged: rebuild with the value, the file is untouched until release
          const at = this.resolve();
          if (!at) return;
          this.overrides.set(msg.key, msg.value === null ? undefined : clampFor(at.doc.languageId, msg.key, msg.value));
          this.update(true);
        } else if (msg.type === "set") {
          void this.setKeys([[msg.key, msg.value === null ? undefined : msg.value]]);
        } else if (msg.type === "setKeys") {
          void this.setKeys((msg.changes as [string, number | null][]).map(([k, v]) => [k, v === null ? undefined : v]));
        } else if (msg.type === "pick") {
          void this.pick(msg.hsl, msg.slot);
        }
      }),
    );
    panel.onDidDispose(() => {
      clearTimeout(this.pending);
      this.subs.forEach((d) => d.dispose());
      ModelPreview.current = undefined;
    });
  }

  private schedule() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.update(false), 150);
  }

  private post(msg: unknown) {
    void this.panel.webview.postMessage(msg);
  }

  /**
   * The document and line to show: a CodeLens pick, else the cursor in a config editor, else the
   * last block shown (focus is in the preview itself while its controls are used, so there is no
   * active editor).
   */
  private resolve(): { doc: vscode.TextDocument; line: number; source: { uri: string; line: number } } | undefined {
    const editor = vscode.window.activeTextEditor;
    const cursor = editor && BUILDERS[editor.document.languageId] ? { uri: editor.document.uri.toString(), line: editor.selection.active.line } : undefined;
    const source = this.pinned ?? cursor ?? this.last;
    const doc = source && vscode.workspace.textDocuments.find((d) => d.uri.toString() === source.uri);
    if (!source || !doc || doc.isClosed || !BUILDERS[doc.languageId]) return undefined;
    return { doc, line: source.line, source };
  }

  /** Writes keys into the shown block as one undoable edit; an undefined value removes the key. */
  private async setKeys(changes: [string, number | undefined][]) {
    const at = this.resolve();
    if (!at) return;
    const block = blockAt(at.doc.getText(), at.line);
    if (!block) return;
    const lang = at.doc.languageId;
    const clamped = changes.map(([k, v]): [string, number | undefined] => [k, v === undefined ? undefined : clampFor(lang, k, v)]);
    const eol = at.doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const lines = Array.from({ length: at.doc.lineCount }, (_, i) => at.doc.lineAt(i).text);
    const edits = keyEdits(lines, block.start, block.end, clamped, eol);
    for (const [k] of changes) this.overrides.delete(k);
    if (edits.length === 0) return this.update(true);
    const we = new vscode.WorkspaceEdit();
    for (const e of edits) we.replace(at.doc.uri, new vscode.Range(...e.from, ...e.to), e.text);
    await vscode.workspace.applyEdit(we);
  }

  /**
   * The eyedropper: a face's pre-recolour colour (HSL16) becomes `recol<slot>s`, or with no slot
   * a new slot whose destination starts equal to it (so nothing changes until it is picked).
   */
  private async pick(hsl: number, slot?: number) {
    const rgb = rgb15ForHsl16(hsl);
    if (rgb === undefined) {
      this.post({ type: "message", message: `No RGB15 value converts to that face's colour (HSL ${hsl}), so a recol cannot match it.` });
      return;
    }
    if (slot) return this.setKeys([[`recol${slot}s`, rgb]]);
    const at = this.resolve();
    const block = at && blockAt(at.doc.getText(), at.line);
    if (!block) return;
    const free = freeRecolSlot(block.lines);
    if (free === undefined) {
      this.post({ type: "message", message: "All nine recolour slots (recol1-9, shared with retex) are used." });
      return;
    }
    await this.setKeys([[`recol${free}s`, rgb], [`recol${free}d`, rgb]]);
  }

  /** Rebuilds when the block text, seq, view or a dragged value changed (or `force`); other editors leave the last model up. */
  private update(force: boolean) {
    const at = this.resolve();
    if (!at) return;
    const { doc, line } = at;
    const build = BUILDERS[doc.languageId];
    this.last = at.source;
    const root = settingPath("contentRoot") || contentRootOf(doc.uri.fsPath);
    if (!root) {
      this.post({ type: "message", message: "No Content root (a folder with pack/interface.pack) above this file; set runescript.contentRoot." });
      return;
    }
    const block = blockAt(doc.getText(), line);
    if (!block) {
      this.post({ type: "message", message: "Put the cursor in a config block." });
      return;
    }
    if (block.name !== this.blockName) {
      this.blockName = block.name;
      this.seq = undefined;
      this.overrides.clear();
    }
    let lines = block.lines;
    for (const [k, v] of this.overrides) lines = withValue(lines, k, v);
    const key = `${root}\n${doc.languageId}\n${this.seq ?? "\u0000"}\n${this.view}\n${JSON.stringify([...this.overrides])}\n${block.text}`;
    if (!force && key === this.shown) return;
    this.shown = key;

    let content = this.contents.get(root);
    if (!content) {
      this.contents.set(root, (content = new Content(root)));
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "{models/**,textures/**,**/*.seq,**/*.param,pack/anim.pack,pack/texture.pack}"));
      const reload = () => {
        content!.invalidate();
        this.update(true);
      };
      this.subs.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload));
    }
    try {
      const scene = build(content, lines, { seq: this.seq, view: this.view });
      const controls = controlsFor(doc.languageId, lines, scene.view);
      this.panel.title = `Model: ${block.name}`;
      this.post({ type: "scene", name: block.name, scene, controls, recols: recolSlots(lines) });
    } catch (e) {
      this.post({ type: "message", message: `${block.name}: ${(e as Error).message}` });
    }
  }
}

function html(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join("");
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri("modelview.css")}" rel="stylesheet">
<title>Model Preview</title>
</head>
<body>
<div id="toolbar">
  <span id="title">Model Preview</span>
  <select id="viewpick" title="View" hidden></select>
  <select id="seq" title="Animation" hidden></select>
  <button id="play">Pause</button>
  <span id="status"></span>
</div>
<div id="stage"><canvas id="view"></canvas><div id="message" class="info">Put the cursor in a config block.</div><div id="labels"></div><div id="iconframe" hidden></div></div>
<div id="controls" hidden></div>
<div id="colours" hidden></div>
<script nonce="${nonce}" src="${uri("main.js")}"></script>
</body>
</html>`;
}
