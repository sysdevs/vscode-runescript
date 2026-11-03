import * as vscode from "vscode";
import { colours, rgb15Colours } from "./scan";

const hex2 = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
/** A 0-1 channel as 5 bits. */
const five = (v: number) => Math.min(31, Math.round(v * 31));

/** Config languages whose `recol#s/d` values are RGB15 (hitsplat and interface recolours are RGB24). */
const RGB15_LANGS = new Set(["runescript-npc", "runescript-obj", "runescript-loc", "runescript-idk", "runescript-spotanim"]);

export const colorProvider: vscode.DocumentColorProvider = {
  provideDocumentColors(doc) {
    const out = colours(doc.getText()).map((c) => {
      const n = parseInt(c.hex, 16);
      const color = new vscode.Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1);
      return new vscode.ColorInformation(new vscode.Range(c.line, c.start, c.line, c.end), color);
    });
    if (RGB15_LANGS.has(doc.languageId)) {
      for (const c of rgb15Colours(doc.getText())) {
        const color = new vscode.Color(((c.rgb15 >> 10) & 31) / 31, ((c.rgb15 >> 5) & 31) / 31, (c.rgb15 & 31) / 31, 1);
        out.push(new vscode.ColorInformation(new vscode.Range(c.line, c.start, c.line, c.end), color));
      }
    }
    return out;
  },
  provideColorPresentations(color, { document, range }) {
    // a decimal value is a recol (RGB15): write the picked colour back the same way
    if (/^\d+$/.test(document.getText(range))) {
      return [new vscode.ColorPresentation(String((five(color.red) << 10) | (five(color.green) << 5) | five(color.blue)))];
    }
    return [new vscode.ColorPresentation(`0x${hex2(color.red)}${hex2(color.green)}${hex2(color.blue)}`)];
  },
};
