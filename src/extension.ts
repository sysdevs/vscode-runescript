// Wires the extension together: outline, folding and colours are local regex
// providers; diagnostics, hover, definition, references, completion and signature
// help come from the runescript-lsp server. Without a server binary the v1 regex
// go-to-definition stays as the fallback. `.if` and `.if3` files also open in the visual
// interface editor (src/ifedit); `.npc` blocks preview in the model preview (src/modelview).
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { startClient } from "./client";
import { colorProvider } from "./features/colors";
import { definitionProvider } from "./features/definition";
import { foldingProvider, symbolProvider } from "./features/symbols";
import { newInterface } from "./ifedit/newif";
import { IfEditorProvider, VIEW_TYPE } from "./ifedit/provider";
import { ALL_LANGS, CONFIG_LANGS } from "./languages";
import { modelLensProvider } from "./modelview/lens";
import { BUILDERS, ModelPreview } from "./modelview/panel";

let client: LanguageClient | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  const all = ALL_LANGS.map((language) => ({ language }));
  const config = CONFIG_LANGS.map((language) => ({ language }));
  ctx.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(all, symbolProvider),
    vscode.languages.registerFoldingRangeProvider(all, foldingProvider),
    vscode.languages.registerColorProvider(config, colorProvider),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new IfEditorProvider(ctx, () => client), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("runescript.ifOpenVisual", (uri?: vscode.Uri) => openWith(uri, VIEW_TYPE)),
    vscode.commands.registerCommand("runescript.ifOpenText", (uri?: vscode.Uri) => openWith(uri, "default")),
    vscode.commands.registerCommand("runescript.ifNew", (uri?: vscode.Uri) => newInterface(ctx, uri)),
    vscode.commands.registerCommand("runescript.modelPreview", (uri?: vscode.Uri, line?: number) => ModelPreview.show(ctx, uri, line)),
    vscode.languages.registerCodeLensProvider(Object.keys(BUILDERS).map((language) => ({ language })), modelLensProvider),
    vscode.commands.registerCommand("runescript.restartServer", async () => {
      if (client) {
        await client.restart();
      } else {
        client = startClient(ctx);
        if (!client) vscode.window.showWarningMessage("RuneScript: no runescript-lsp binary found (set runescript.server.path).");
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("runescript.interfaceEditor.openWith")) void syncOpenWith();
    }),
  );
  void syncOpenWith();
  client = startClient(ctx);
  if (!client) {
    ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(all, definitionProvider(ctx.subscriptions)));
  }
}

/** Reopens the active (or given) `.if`/`.if3` file in the visual editor or as text. */
function openWith(uri: vscode.Uri | undefined, viewType: string) {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
  const target = uri ?? tab?.uri;
  if (target) return vscode.commands.executeCommand("vscode.openWith", target, viewType);
}

/**
 * Mirrors `runescript.interfaceEditor.openWith` into `workbench.editorAssociations` (`*.if`, `*.if3`) at the
 * scope it is set in; VS Code does the routing. Left alone while the setting is unset.
 */
async function syncOpenWith() {
  const info = vscode.workspace.getConfiguration("runescript").inspect<string>("interfaceEditor.openWith");
  const value = info?.workspaceValue ?? info?.globalValue;
  if (value === undefined) return;
  const target = info?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const want = value === "text" ? "default" : VIEW_TYPE;
  const workbench = vscode.workspace.getConfiguration("workbench");
  const scoped = workbench.inspect<Record<string, string>>("editorAssociations");
  const assoc = (target === vscode.ConfigurationTarget.Workspace ? scoped?.workspaceValue : scoped?.globalValue) ?? {};
  if (assoc["*.if"] !== want || assoc["*.if3"] !== want) await workbench.update("editorAssociations", { ...assoc, "*.if": want, "*.if3": want }, target);
}

export function deactivate() {
  return client?.stop();
}
