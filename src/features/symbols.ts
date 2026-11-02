import * as vscode from "vscode";
import { SCRIPT_LANGS } from "../languages";
import { lines, scriptHeaders, sections } from "./scan";

interface Block { name: string; line: number; kind: vscode.SymbolKind; }

function blocks(doc: vscode.TextDocument): Block[] {
  const text = doc.getText();
  if (SCRIPT_LANGS.includes(doc.languageId)) {
    return scriptHeaders(text).map((h) => ({ name: `[${h.trigger},${h.subject}]`, line: h.line, kind: vscode.SymbolKind.Function }));
  }
  return sections(text).map((s) => ({
    name: s.name,
    line: s.line,
    kind: s.name.startsWith("^") ? vscode.SymbolKind.Constant : vscode.SymbolKind.Object,
  }));
}

/** Each block runs from its header to the line before the next one, trailing blank lines excluded. */
function ranges(doc: vscode.TextDocument): (Block & { end: number })[] {
  const all = lines(doc.getText());
  const bs = blocks(doc);
  return bs.map((b, i) => {
    let end = (i + 1 < bs.length ? bs[i + 1].line : all.length) - 1;
    while (end > b.line && all[end].trim() === "") end--;
    return { ...b, end };
  });
}

export const symbolProvider: vscode.DocumentSymbolProvider = {
  provideDocumentSymbols(doc) {
    return ranges(doc).map((b) => {
      const range = new vscode.Range(b.line, 0, b.end, doc.lineAt(b.end).text.length);
      return new vscode.DocumentSymbol(b.name, "", b.kind, range, doc.lineAt(b.line).range);
    });
  },
};

export const foldingProvider: vscode.FoldingRangeProvider = {
  provideFoldingRanges(doc) {
    return ranges(doc).filter((b) => b.end > b.line).map((b) => new vscode.FoldingRange(b.line, b.end));
  },
};
