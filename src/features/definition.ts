import * as vscode from "vscode";
import { candidates, scriptHeaders, scriptKey, sections, wordAt } from "./scan";
import { CONFIG_EXTS } from "../languages";

// .pack files are id=name lists, not definitions.
const GLOB = `**/*.{rs2,cs2,${CONFIG_EXTS.filter((e) => e !== "pack").join(",")}}`;

/**
 * Workspace index of definition sites, keyed by:
 *   `trigger,subject` for script headers, `name` for config sections, `^name` for constants,
 *   `iface:com` for interface components (and `iface` for the interface file itself).
 * ponytail: full re-scan of a file on every change, whole-workspace scan on first use.
 */
class Index {
  private byKey = new Map<string, vscode.Location[]>();
  private byFile = new Map<string, string[]>();
  private ready: Promise<void> | undefined;

  constructor(subs: vscode.Disposable[]) {
    const w = vscode.workspace.createFileSystemWatcher(GLOB);
    subs.push(w, w.onDidChange((u) => this.index(u)), w.onDidCreate((u) => this.index(u)), w.onDidDelete((u) => this.forget(u)));
  }

  async lookup(keys: string[]): Promise<vscode.Location[]> {
    this.ready ??= this.build();
    await this.ready;
    for (const k of keys) {
      const hit = this.byKey.get(k);
      if (hit?.length) return hit;
    }
    return [];
  }

  private async build() {
    const files = await vscode.workspace.findFiles(GLOB, "**/node_modules/**");
    await Promise.all(files.map((f) => this.index(f)));
  }

  private forget(uri: vscode.Uri) {
    const s = uri.toString();
    for (const k of this.byFile.get(s) ?? []) {
      const rest = (this.byKey.get(k) ?? []).filter((l) => l.uri.toString() !== s);
      rest.length ? this.byKey.set(k, rest) : this.byKey.delete(k);
    }
    this.byFile.delete(s);
  }

  private async index(uri: vscode.Uri) {
    this.forget(uri);
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      return;
    }
    const ext = uri.path.slice(uri.path.lastIndexOf(".") + 1);
    const stem = uri.path.slice(uri.path.lastIndexOf("/") + 1, uri.path.lastIndexOf("."));
    const entries: [string, number][] = [];
    if (ext === "rs2" || ext === "cs2") {
      for (const h of scriptHeaders(text)) entries.push([scriptKey(ext, h.trigger, h.subject), h.line]);
    } else {
      const iface = ext === "if" || ext === "if3";
      for (const s of sections(text)) entries.push([iface ? `${stem}:${s.name}` : s.name, s.line]);
      if (iface) entries.push([stem, 0]);
    }
    const keys: string[] = [];
    for (const [key, line] of entries) {
      keys.push(key);
      const list = this.byKey.get(key) ?? [];
      list.push(new vscode.Location(uri, new vscode.Position(line, 0)));
      this.byKey.set(key, list);
    }
    this.byFile.set(uri.toString(), keys);
  }
}

export function definitionProvider(subs: vscode.Disposable[]): vscode.DefinitionProvider {
  const index = new Index(subs);
  return {
    provideDefinition(doc, pos) {
      const w = wordAt(doc.lineAt(pos.line).text, pos.character);
      return w ? index.lookup(candidates(w.sigil, w.name, doc.uri.path.slice(doc.uri.path.lastIndexOf(".") + 1))) : [];
    },
  };
}
