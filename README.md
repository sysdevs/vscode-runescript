# RuneScript for VS Code

Language support for LostCity-style RuneScript: `.rs2` scripts and the config formats
(`.npc .obj .loc .seq .spotanim .varp .varbit .varn .varo .vars .inv .enum .struct .param .dbtable .dbrow
.idk .mesanim .flo .hunt .hitsplat .if .constant .pack`).

- Syntax highlighting (the grammar mirrors the lexer in `ares-compiler/src/lexer.rs`).
- A badge icon per file type (one language id per config extension).
- Outline, breadcrumbs and folding for `[trigger,subject]` scripts and `[name]` sections.
- Colour swatches for `0xRRGGBB` values in configs.
- A visual interface editor for `.if` files (opens by default, or as text with `runescript.interfaceEditor.openWith`; "Open as Text" or Reopen Editor With switch one file):
  a pixel-exact preview drawn with the client's own sprite, font and layout rules (models show as
  placeholders), drag to move and resize, a layers panel (draw order, nesting, show/hide and lock in the
  preview, solo, search, thumbnails, multi-select, group/ungroup, duplicate, copy/paste between files, rename),
  a toolbox (Move V, Select M, Hand H / Space, Zoom Z, draw Rect R / Text T / Layer L, Eyedropper I,
  Measure U), palettes for component
  types, sprites, fonts and colours, an inspector for keys, right-click options and scripts. New and deleted
  components get or lose their `pack/interface.pack` / `pack/interface.order` ids when the file is saved.
  "Open as Text" switches back.
- From the `runescript-lsp` language server (shipped in `bin/`):
  - compiler diagnostics as you type
  - hover with types, signatures and `// info:` docs
  - go to definition and find references for locals, procs, labels, commands, config names, constants and `iface:com`
  - completion after `~ @ $ % ^`, in `[trigger` headers, and of config names and locals where an argument or
    `def_<type>` initializer expects that type
  - signature help and parameter-name inlay hints
  - rename (F2) for locals, procs, labels, constants, config names and interface components (also their
    `[name]` line, config values naming them and the `.pack` line, so ids stay put)
  - highlight of the symbol under the cursor, workspace symbol search (Ctrl+T)
  - in config files: key and value completion, warnings for unknown keys, bad values and unknown names, go to
    definition and references through values, sprite and texture previews on hover

## Setup

Set `runescript.symbolsPath` to the ares server's `data/symbols.json`. Without it, only syntax
errors are reported. With Content and ares-gameserver side by side, in `Content/.vscode/settings.json`:

```json
"runescript.symbolsPath": "../ares-gameserver/data/symbols.json"
```

A dev-mode server (`production` off, `liveReload` on) writes that file at startup and after every
rebuild. Outside dev mode, run `ares-pack symbols` after `ares-pack build`.

| Setting | Meaning |
|---|---|
| `runescript.symbolsPath` | `symbols.json` for type checking. Relative paths start at the first workspace folder. |
| `runescript.server.path` | A `runescript-lsp` binary to use instead of the bundled one. |
| `runescript.trace.server` | Protocol tracing in the output panel. |
| `runescript.diagnostics.configWarnings` | Off mutes unknown-key, bad-value and unknown-name warnings in config files. |
| `runescript.contentRoot` | The Content folder for the interface editor, when it is not above the `.if` file. |
| `runescript.interfaceEditor.openWith` | `visual` or `text`; writes `workbench.editorAssociations["*.if"]` at the same scope. |
| `runescript.interfaceEditor.zoom`, `.gridSize`, `.grid`, `.smartGuides` | Starting zoom, grid spacing, grid snap and smart guides for a newly opened editor (a reopened panel keeps its own). |

Config checks and navigation work without `symbolsPath`; they follow the key table in
`runescript-lsp/src/config_keys.rs`, transcribed from the ares-gameserver config parsers.

`RuneScript: Restart Language Server` restarts the server. If no server binary is found,
go to definition falls back to a regex index.

## Develop

```
npm install
npm run gen       # regenerate data/syntax.json from ares-compiler + ares-shared, then grammars, icons, languages
npm test          # tsc, node --test, grammar snapshots
npm run snap      # re-record grammar snapshots after an intentional grammar change
npm run package   # builds ../runescript-lsp, copies it to bin/, writes the win32-x64 .vsix
```

`F5` opens an Extension Development Host on `../Content`. File types, their icons and
language ids come from `FILE_TYPES` in `scripts/gen-grammar.mjs`. Trigger and type names
come from the Rust crates, so rerun `npm run gen` after adding a trigger or var type.
