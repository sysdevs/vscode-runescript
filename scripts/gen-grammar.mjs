// Generates everything derived from two sources:
//   data/syntax.json (written by ares-compiler `cargo run --example dump_syntax`) -> trigger/type/keyword lists in the grammar
//   FILE_TYPES below -> package.json languages + grammars, per-type wrapper grammars, badge icons, src/languages.ts
// Idempotent: `npm run gen` runs it after regenerating syntax.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const write = (p, s) => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), s);
};
const writeJson = (p, v) => write(p, JSON.stringify(v, null, 2) + "\n");

const CATEGORY_COLOUR = {
  script: "#C0392B",
  entity: "#2E86C1",
  visual: "#8E44AD",
  var: "#D68910",
  data: "#229954",
  interface: "#17A589",
  meta: "#566573",
};

// ext, label, badge text, category. `rs2`, `macro` and `cs2` are script languages; every other row is a config language.
const FILE_TYPES = [
  ["rs2", "RuneScript", "RS", "script"],
  ["macro", "RuneScript Macro", "MAC", "script"],
  ["cs2", "Client script", "CS2", "script"],
  ["npc", "NPC", "NPC", "entity"],
  ["obj", "Object", "OBJ", "entity"],
  ["loc", "Location", "LOC", "entity"],
  ["idk", "Identity Kit", "IDK", "entity"],
  ["seq", "Sequence", "SEQ", "visual"],
  ["spotanim", "Spot Animation", "SPA", "visual"],
  ["mesanim", "Message Animation", "MES", "visual"],
  ["flo", "Floor", "FLO", "visual"],
  ["hitsplat", "Hitsplat", "HIT", "visual"],
  ["varp", "Player Variable", "VP", "var"],
  ["varbit", "Variable Bit", "VB", "var"],
  ["varn", "NPC Variable", "VN", "var"],
  ["varo", "Obj Variable", "VO", "var"],
  ["vars", "Shared Variable", "VS", "var"],
  ["varc", "Client variable", "VARC", "var"],
  ["inv", "Inventory", "INV", "data"],
  ["enum", "Enum", "ENM", "data"],
  ["struct", "Struct", "STR", "data"],
  ["param", "Param", "PRM", "data"],
  ["dbtable", "DB Table", "DBT", "data"],
  ["dbrow", "DB Row", "DBR", "data"],
  ["hunt", "Hunt", "HNT", "data"],
  ["if", "Interface", "IF", "interface"],
  ["if3", "Interface (IF3)", "IF3", "interface"],
  ["constant", "Constant", "^", "meta"],
  ["pack", "Pack", "PK", "meta"],
];
const SCRIPT_EXTS = ["rs2", "macro", "cs2"];
const CONFIG = FILE_TYPES.filter(([ext]) => !SCRIPT_EXTS.includes(ext));

// --- script grammar word lists ---
const data = read("data/syntax.json");
const grammarPath = "syntaxes/runescript.tmLanguage.json";
const grammar = read(grammarPath);
const alt = (words) => `\\b(?:${words.join("|")})\\b`;
grammar.repository.header.captures["2"].patterns[0].match = alt(data.triggers);
grammar.repository.keyword.patterns[0].match = alt(data.keywords);
grammar.repository["type-name"].match = `\\b(?:${data.types.join("|")})(?:array)?\\b`;
writeJson(grammarPath, grammar);

// --- icons: 16x16 badge, white text; font size shrinks for 3 letters ---
const icon = (abbr, category) => {
  const size = abbr.length >= 3 ? 6 : abbr.length === 2 ? 7.5 : 11;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <rect x="0.5" y="1.5" width="15" height="13" rx="2.5" fill="${CATEGORY_COLOUR[category]}"/>
  <text x="8" y="8" dy="0.35em" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#FFFFFF">${abbr.replace("&", "&amp;").replace("<", "&lt;")}</text>
</svg>
`;
};
for (const [ext, , abbr, category] of FILE_TYPES) write(`icons/${ext}.svg`, icon(abbr, category));
const iconRef = (ext) => ({ light: `./icons/${ext}.svg`, dark: `./icons/${ext}.svg` });

// --- per-type config grammars: copies of the shared template with their own scope ---
// (copies, not `include`, so they work without cross-grammar resolution; per-format rules go here later)
const template = read("syntaxes/config.tmLanguage.json");
for (const [ext, label] of CONFIG) {
  writeJson(`syntaxes/config/${ext}.tmLanguage.json`, {
    ...template,
    name: `RuneScript ${label}`,
    scopeName: `source.runescript-config.${ext}`,
  });
}

// --- package.json contributions ---
const pkg = read("package.json");
pkg.contributes.languages = [
  {
    id: "runescript",
    aliases: ["RuneScript"],
    extensions: [".rs2"],
    configuration: "./language-configuration/runescript.json",
    icon: iconRef("rs2"),
  },
  {
    id: "runescript-macro",
    aliases: ["RuneScript Macro"],
    extensions: [".macro"],
    configuration: "./language-configuration/runescript.json",
    icon: iconRef("macro"),
  },
  {
    id: "runescript-client",
    aliases: ["RuneScript Client Script"],
    extensions: [".cs2"],
    configuration: "./language-configuration/runescript.json",
    icon: iconRef("cs2"),
  },
  ...CONFIG.map(([ext, label]) => ({
    id: `runescript-${ext}`,
    aliases: [`RuneScript ${label}`],
    extensions: [`.${ext}`],
    configuration: "./language-configuration/config.json",
    icon: iconRef(ext),
  })),
];
pkg.contributes.grammars = [
  { language: "runescript", scopeName: "source.runescript", path: "./syntaxes/runescript.tmLanguage.json" },
  { language: "runescript-macro", scopeName: "source.runescript", path: "./syntaxes/runescript.tmLanguage.json" },
  { language: "runescript-client", scopeName: "source.runescript", path: "./syntaxes/runescript.tmLanguage.json" },
  ...CONFIG.map(([ext]) => ({
    language: `runescript-${ext}`,
    scopeName: `source.runescript-config.${ext}`,
    path: `./syntaxes/config/${ext}.tmLanguage.json`,
  })),
];
// VS Code (1.74+) derives onLanguage activation from contributes.languages; listing them is flagged as redundant.
delete pkg.activationEvents;
writeJson("package.json", pkg);

// --- src/languages.ts ---
const configExts = CONFIG.map(([ext]) => ext);
write(
  "src/languages.ts",
  `// Generated by scripts/gen-grammar.mjs; edit FILE_TYPES there.
export const SCRIPT_LANGS = ["runescript", "runescript-macro", "runescript-client"];
export const CONFIG_EXTS = ${JSON.stringify(configExts)};
export const CONFIG_LANGS = CONFIG_EXTS.map((e) => \`runescript-\${e}\`);
export const ALL_LANGS = [...SCRIPT_LANGS, ...CONFIG_LANGS];
`,
);

console.log(`generated: ${data.triggers.length} triggers, ${data.types.length} types, ${FILE_TYPES.length} file types`);
