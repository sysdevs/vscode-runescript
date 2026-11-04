// Starts the runescript-lsp language server, if a binary can be found.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";
import { ALL_LANGS, CONFIG_EXTS } from "./languages";

const EXE = process.platform === "win32" ? "runescript-lsp.exe" : "runescript-lsp";

/** `runescript.server.path`, then the binary shipped in `bin/`, then `PATH`. */
function serverBinary(ctx: vscode.ExtensionContext): string | undefined {
  const configured = vscode.workspace.getConfiguration("runescript").get<string>("server.path");
  if (configured) return configured;
  const bundled = ctx.asAbsolutePath(path.join("bin", EXE));
  if (fs.existsSync(bundled)) return bundled;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, EXE);
    if (dir && fs.existsSync(p)) return p;
  }
  return undefined;
}

/** A `runescript.<key>` path setting, relative paths taken from the first workspace folder. */
export function settingPath(key: string): string {
  const p = vscode.workspace.getConfiguration("runescript").get<string>(key) ?? "";
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return p && root && !path.isAbsolute(p) ? path.join(root, p) : p;
}

/** The settings the server reads, resolved. */
function serverSettings() {
  const configWarnings = vscode.workspace.getConfiguration("runescript").get<boolean>("diagnostics.configWarnings") ?? true;
  return { configWarnings };
}

export function startClient(ctx: vscode.ExtensionContext): LanguageClient | undefined {
  const command = serverBinary(ctx);
  if (!command) return undefined;
  const server: ServerOptions = { command, args: [] };
  const client = new LanguageClient(
    "runescript",
    "RuneScript",
    server,
    {
      documentSelector: ALL_LANGS.map((language) => ({ scheme: "file", language })),
      initializationOptions: serverSettings(),
      synchronize: {
        fileEvents: vscode.workspace.createFileSystemWatcher(`**/*.{rs2,macro,cs2,${CONFIG_EXTS.join(",")}}`),
      },
    } satisfies LanguageClientOptions,
  );
  // The server reads its settings from didChangeConfiguration; send them resolved.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("runescript.diagnostics.configWarnings") && client.isRunning()) {
        client.sendNotification("workspace/didChangeConfiguration", { settings: serverSettings() });
      }
    }),
  );
  client.start();
  return client;
}
