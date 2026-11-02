# Changelog

## 0.1.0

- Syntax highlighting for `.rs2` and all config formats.
- Outline, folding, colour decorators, go to definition.

## 0.1.1

- One language per config extension, each with its own badge icon.

## 0.2.0

- Language server (`runescript-lsp`): diagnostics, hover, definition, references, completion, signature help.
- Settings `runescript.symbolsPath`, `runescript.server.path`, `runescript.trace.server`; command `RuneScript: Restart Language Server`.

## 0.2.1

- `runescript.symbolsPath` docs point at `ares-rs/data/symbols.json`, which a dev-mode server now writes.

## 0.3.0

- Typed completion: call arguments and `def_<type> $x =` list config names and locals of the expected type.
- Rename (F2) for locals, procs, labels, constants and config names, including `[name]` lines, config values and the `.pack` line that keeps the id.
- Highlight of the symbol under the cursor, workspace symbol search (Ctrl+T), parameter-name inlay hints.
- Config files: key and value completion, warnings for unknown keys, bad values and unknown names,
  go to definition and references through config values, sprite and texture previews on hover.

## 0.3.1

- The language server analyzes on a background thread: hover, completion and the rest answer at once
  during a pass, and editor requests no longer postpone re-analysis (diagnostics after an edit took
  as long as the cursor kept moving; now about a second on Content). Inlay hints refresh after each pass.

## 0.4.0

- Errors appear about 0.1 s after an edit (was about 1 s on Content): an edit to a script body is
  re-checked alone (about 10 ms) instead of re-analyzing the whole workspace. Full passes, off the
  main thread, run only on start-up, changed script headers, new or deleted scripts and a new
  `symbols.json`, and parse only scripts whose text changed.
- Pass timings are logged to the RuneScript output panel.

## 0.4.1

- Editing a config file re-checks only that file (a `.pack` edit still re-checks every config).
- Positions are looked up through a per-file line index: inlay hints, references and highlights on long
  files are 10-40x faster.
- The editor sends only the changed range on each keystroke instead of the whole file.
- Completion lists over 200 items are narrowed by the word typed and refreshed as it grows
  (an obj argument was 4,400 items / 400 KB per keystroke; now 200 / 17 KB).

## 0.5.0

- Interface editor for `.if` files: live pixel-exact preview, drag and drop, tree, palettes (components,
  sprites, fonts, colours), inspector with options and scripts editors. `.if` files open in it by default;
  "Open as Text" switches to the text editor and back.
  Saving the file gives new components ids in `interface.pack` / `interface.order` and drops deleted ones.
- Language server: warnings on `.if` lines the packer misreads (indentation, spaces around `=`, `//`
  comments, lines without `=`, duplicate keys).

## 0.6.0

- Interface editor layers panel: every component is a row in draw order with `type=layer` components as
  collapsible groups; eye (hide in the preview only, Alt-click to solo) and lock per row, remembered per
  file; thumbnails; search; Ctrl/Shift-click and canvas marquee multi-select (drag, nudge and delete act on
  all, outlined with marching ants); New layer, Group / Ungroup (Ctrl+G / Ctrl+Shift+G, positions kept), Duplicate (Ctrl+D), copy and
  paste (Ctrl+C / Ctrl+V, also between `.if` files); double-click or F2 to rename.
- Language server: interface components can be renamed (`[com]` header, `layer=` / `overlayer=` values,
  script references, `.if` script operands and the `interface.pack` line, which keeps its id).
- Resizable layers and side panels (drag the splitter, double-click to reset).

## 0.7.0

- Interface editor toolbox beside the preview:
  - Move (V): drag moves the selection from anywhere; pressing an unselected component picks it first.
  - Select (M): click, or drag a box that selects what it touches (Alt: only what is fully inside).
  - Hand (H, or hold Space) pans; Zoom (Z) clicks in, Alt-click out, keeping the pixel under the mouse;
    Ctrl+wheel zooms in any tool; zoom goes up to 8x.
  - Rect (R), Text (T), Layer (L): drag a box to create that component at that size, inside the layer under
    the mouse.
  - Eyedropper (I): takes a preview colour into the focused colour field or the selection's colour (Alt:
    hover colour).
  - Measure (U): drag for dx / dy / length; hover a component to see its gaps to the selection.
- The eye shortcut for the selection moved from H to Ctrl+Shift+H.

## 0.7.1

- The toolbox sits in a row above the preview, with matching outline icons grouped as navigate | draw |
  inspect.
- Select is the default tool (and what Esc returns to).

## 0.7.2

- Corner resize handles work with the Select tool too (they only worked with Move, which stopped being the
  default), are a little easier to grab, and show a resize cursor.
- Saving a brand-new `.if` (no `id=<interface>` line in `interface.pack` yet) now gives the interface its own id
  and group in `interface.order` too; before, the save reported "interface.pack has no interface" and wrote nothing.
- Selecting a component inside a layer also outlines that layer with darker marching ants.

## 0.8.0

- Smart guides: moving a component snaps its edges or centre to the edges and centres of its layer and of
  the other components in that layer (each axis on its own); resizing snaps the dragged edges the same way.
  Magenta guide lines show every snap, with the matched components outlined. A Snap toolbar toggle (on by
  default) turns it off.

## Unreleased

- Settings `runescript.interfaceEditor.openWith` (visual or text; writes `workbench.editorAssociations`),
  `runescript.interfaceEditor.zoom` / `gridSize` / `grid` / `smartGuides` (defaults for a newly opened editor),
  `runescript.contentRoot` (when the Content folder is not above the `.if`) and
  `runescript.diagnostics.configWarnings` (mute config-file warnings).
