// "New Interface…": copies a bundled template (templates/<area>.if) into an `interfaces`
// directory under the Content root, gives it interface.pack / .order ids and opens it
// in the visual editor on the template's preview area.
import { existsSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";
import * as vscode from "vscode";
import { settingPath } from "../client";
import { VIEW_TYPE, contentRootOf, reconcileIdsOnDisk } from "./provider";
import { Area } from "./render";

const KINDS: { label: string; area: Area }[] = [
  { label: "Main", area: "main" },
  { label: "Side tab", area: "side" },
  { label: "Chatbox", area: "chat" },
];

export async function newInterface(ctx: vscode.ExtensionContext, folder?: vscode.Uri) {
  let dir = folder?.fsPath ?? (vscode.window.activeTextEditor ? dirname(vscode.window.activeTextEditor.document.uri.fsPath) : undefined);
  if (!dir) {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Create Here" });
    if (!picked) return;
    dir = picked[0].fsPath;
  }
  const root = settingPath("contentRoot") || contentRootOf(join(dir, "x"));
  if (!root) {
    void vscode.window.showErrorMessage("New Interface: no Content root (a folder with pack/interface.pack) above this folder; set runescript.contentRoot.");
    return;
  }
  // the packer wants every .if inside an `interfaces` directory (or one level below it)
  if (basename(dir) !== "interfaces" && basename(dirname(dir)) !== "interfaces") dir = join(dir, "interfaces");

  const kind = await vscode.window.showQuickPick(KINDS, { placeHolder: "Interface type" });
  if (!kind) return;
  const names = new Set(
    readFileSync(join(root, "pack", "interface.pack"), "latin1")
      .split(/\r?\n/)
      .map((l) => l.slice(l.indexOf("=") + 1)),
  );
  const target = dir;
  const name = await vscode.window.showInputBox({
    prompt: `New ${kind.label.toLowerCase()} interface name`,
    validateInput: (v) =>
      !/^[a-z0-9_]+$/.test(v) ? "lowercase letters, digits and _ only"
      : names.has(v) ? `interface.pack already has ${v}`
      : existsSync(join(target, `${v}.if`)) ? `${v}.if already exists here`
      : undefined,
  });
  if (!name) return;

  const text = readFileSync(join(ctx.extensionUri.fsPath, "templates", `${kind.area}.if`), "latin1");
  const uri = vscode.Uri.file(join(dir, `${name}.if`));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "latin1"));
  await ctx.workspaceState.update(`ifedit.area:${uri.fsPath}`, kind.area);
  await reconcileIdsOnDisk(root, name, text);
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
}
