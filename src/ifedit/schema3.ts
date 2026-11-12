// What the IF3 packer (ares-gameserver src/pack/interface3.rs) accepts, as data for the editor.

export const TYPES = ["layer", "rectangle", "text", "graphic", "model", "tooltip", "line", "circle", "inputfield"];

const COMMON = ["x", "y", "width", "height", "xmode", "ymode", "widthmode", "heightmode", "layer", "hide", "clientcode"];
/** Ops and targeting, shown in their own section. */
export const OP_KEYS = ["opbase", ...Array.from({ length: 10 }, (_, i) => `op${i + 1}`), "transmitop", "targetmask", "targetverb", "dragdeadzone", "dragdeadtime", "dragrenderbehaviour"];

const TYPE_KEYS: Record<string, string[]> = {
  layer: ["scrollwidth", "scrollheight", "noclickthrough", "objops", "objuse", "objswap"],
  tooltip: ["text", "textfont"],
  circle: ["colour", "fill", "trans", "linewid", "arcstart", "arcend"],
  inputfield: ["text", "textfont", "textalignh", "textalignv", "textshadow", "colour", "placeholdertext", "placeholdertextcolour",
    "selectcolour", "selectbgcolour", "linecountlimit", "linewidthlimit", "linewrappingwidth", "wrapmode", "submitmode", "acceptmode", "focusable"],
  rectangle: ["colour", "fill", "trans"],
  text: ["text", "textfont", "textalignh", "textalignv", "textlineheight", "textshadow", "colour"],
  graphic: ["graphic", "tiling", "trans", "outline", "graphicshadow", "vflip", "hflip"],
  model: ["model", "modelanim", "modelzoom", "modelangle", "modelorigin", "modelorthog", "modelobjwidth", "modelobjheight"],
  line: ["colour", "linewid", "linedirection"],
};

/** Hook keys in record slot order; the three transmit hooks also take a `{…}` trigger list. */
export const HOOKS = ["onload", "onmouseover", "onmouseleave", "onvartransmit", "oninvtransmit", "onstattransmit", "ontimer",
  "onop", "onmouserepeat", "onclick", "onrelease", "onhold", "ondrag", "ondragcomplete", "onscrollwheel"];
/** When each hook runs (Content/docs/cs2/hooks.md). */
export const HOOK_INFO: Record<string, string> = {
  onload: "when the interface opens", onmouseover: "when the mouse enters", onmouseleave: "when the mouse leaves",
  onvartransmit: "when a listed var changes", oninvtransmit: "when a listed inv changes", onstattransmit: "when a listed stat changes",
  ontimer: "every client cycle", onop: "when an op is chosen", onmouserepeat: "every cycle the mouse is over it", onclick: "on mouse press",
  onrelease: "on mouse release", onhold: "every cycle it is held", ondrag: "while dragged", ondragcomplete: "when a drag ends", onscrollwheel: "on mouse wheel",
};
/** `event_*` placeholders by the parameter type they fit (ares-compiler runescript/loaders.rs). */
export const EVENTS: Record<string, string[]> = {
  component: ["event_com", "event_com2"],
  int: ["event_mousex", "event_mousey", "event_op", "event_comsubid", "event_comsubid2", "event_keycode", "event_keychar"],
  string: ["event_opbase"],
};
/** Transmit hook -> the picker lists its trigger names come from. */
export const TRIGGERS: Record<string, string[]> = { onvartransmit: ["varp", "varbit", "varc"], oninvtransmit: ["inv"], onstattransmit: ["stat"] };

export const ENUMS: Record<string, string[]> = {
  xmode: ["abs_left", "abs_centre", "abs_right", "rel_left", "rel_centre", "rel_right"],
  ymode: ["abs_top", "abs_centre", "abs_bottom", "rel_top", "rel_centre", "rel_bottom"],
  widthmode: ["abs", "minus", "rel"],
  heightmode: ["abs", "minus", "rel"],
  textalignh: ["left", "centre", "right"],
  textalignv: ["top", "centre", "bottom"],
  textfont: ["p11_full", "p12_full", "b12_full", "q8_full"],
  focusable: ["yes", "no"],
};
export const BOOLS = ["hide", "noclickthrough", "objops", "objuse", "objswap", "fill", "textshadow", "tiling", "vflip", "hflip", "modelorthog", "linedirection", "dragrenderbehaviour"];
export const NUMBERS = ["x", "y", "width", "height", "clientcode", "scrollwidth", "scrollheight", "trans", "linewid", "arcstart", "arcend", "linecountlimit", "linewidthlimit",
  "linewrappingwidth", "wrapmode", "submitmode", "acceptmode", "textlineheight", "outline", "modelzoom", "modelobjwidth", "modelobjheight", "dragdeadzone", "dragdeadtime"];
export const COLOURS = ["colour", "placeholdertextcolour", "selectcolour", "selectbgcolour", "graphicshadow"];
export const TARGETS = ["obj", "npc", "loc", "player", "com"];

/** Layout keys in the order the editor writes them; other keys go after them. */
export const KEY_ORDER = ["type", "x", "y", "width", "height", "xmode", "ymode", "widthmode", "heightmode", "layer"];

/** Keys a new component starts with (x and y are added where it is dropped). */
export const NEW_COM: Record<string, [string, string][]> = {
  rectangle: [["type", "rectangle"], ["width", "32"], ["height", "32"], ["colour", "0xff981f"], ["fill", "yes"]],
  text: [["type", "text"], ["width", "100"], ["height", "12"], ["textfont", "p12_full"], ["colour", "0xff981f"], ["textshadow", "yes"], ["text", "Text"]],
  graphic: [["type", "graphic"], ["width", "32"], ["height", "32"]],
  layer: [["type", "layer"], ["width", "100"], ["height", "100"]],
  model: [["type", "model"], ["width", "32"], ["height", "32"], ["modelzoom", "1000"]],
  line: [["type", "line"], ["width", "32"], ["height", "0"], ["colour", "0xff981f"]],
  circle: [["type", "circle"], ["width", "32"], ["height", "32"], ["colour", "0xff981f"], ["fill", "yes"]],
  inputfield: [["type", "inputfield"], ["width", "120"], ["height", "14"], ["textfont", "p11_full"], ["colour", "0xffffff"], ["placeholdertext", "Type here..."], ["placeholdertextcolour", "0x808080"]],
  tooltip: [["type", "tooltip"], ["width", "32"], ["height", "32"], ["text", "Tooltip"]],
};

/** The keys interface3.rs packs for this type (hooks and param aside). */
export function fieldsFor(type: string): string[] {
  return [...COMMON, ...(TYPE_KEYS[type] ?? []), ...OP_KEYS];
}

/** The schema as plain data for the webview. */
export function schemaData() {
  const FIELDS: Record<string, Record<string, string[]>> = {};
  for (const t of TYPES) FIELDS[t] = { "": fieldsFor(t) };
  // the draw tools' component types
  const DRAW = { rect: "rectangle", text: "text", layer: "layer" };
  return { format: "if3", NEW_COM, KEY_ORDER, TYPES, FIELDS, HOOKS, HOOK_INFO, EVENTS, TRIGGERS, ENUMS, BOOLS, NUMBERS, COLOURS, TARGETS, OP_KEYS, DRAW, FONTS: ENUMS.textfont };
}
