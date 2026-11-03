// "Preview model" above every config block that names a model (npc/idk `model#`/`head#`, obj
// `model`/`manwear`/..., loc `model`..`model5`, spotanim `model`); opens the model preview on it.
import * as vscode from "vscode";

export const modelLensProvider: vscode.CodeLensProvider = {
  provideCodeLenses(doc) {
    const lenses: vscode.CodeLens[] = [];
    let header = -1;
    let hasModel = false;
    const flush = () => {
      if (header < 0 || !hasModel) return;
      lenses.push(
        new vscode.CodeLens(new vscode.Range(header, 0, header, 0), {
          title: "$(open-preview) Preview model",
          command: "runescript.modelPreview",
          arguments: [doc.uri, header],
        }),
      );
    };
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      if (/^\s*\[[^\]]+\]/.test(text)) {
        flush();
        header = i;
        hasModel = false;
      } else if (/^\s*(model\d*|head\d+|manwear|womanwear|manhead|womanhead)\s*=/.test(text)) hasModel = true;
    }
    flush();
    return lenses;
  },
};
