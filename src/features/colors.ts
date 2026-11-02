import * as vscode from "vscode";
import { colours } from "./scan";

const hex2 = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();

export const colorProvider: vscode.DocumentColorProvider = {
  provideDocumentColors(doc) {
    return colours(doc.getText()).map((c) => {
      const n = parseInt(c.hex, 16);
      const color = new vscode.Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1);
      return new vscode.ColorInformation(new vscode.Range(c.line, c.start, c.line, c.end), color);
    });
  },
  provideColorPresentations(color) {
    return [new vscode.ColorPresentation(`0x${hex2(color.red)}${hex2(color.green)}${hex2(color.blue)}`)];
  },
};
