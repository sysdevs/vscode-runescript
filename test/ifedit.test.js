const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join, basename } = require("node:path");
const { parseIf, get, num, find } = require("../out/ifedit/parse.js");

const CONTENT = process.env.RS2_CONTENT;
const noContent = !CONTENT;

/** Every Content `.if` file as [stem, text], walked bytewise like the packer. */
function contentIfs() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".if")) out.push([basename(name, ".if"), readFileSync(p, "latin1")]);
    }
  };
  walk(join(CONTENT, "scripts"));
  return out;
}

const IF = "[a]\ntype=layer\nwidth=100\n\n[b]\ntype=rect\nlayer=a\nx=5\nx=7\n\n[c]\ntype=text\nx = 3\n";

test("parseIf builds coms, tree and last-wins keys", () => {
  const m = parseIf("t", IF);
  assert.deepEqual(m.coms.map((c) => c.name), ["a", "b", "c"]);
  assert.deepEqual(m.children.get(""), ["a", "c"]);
  assert.deepEqual(m.children.get("a"), ["b"]);
  assert.equal(num(find(m, "b"), "x"), 7);
  assert.equal(get(find(m, "c"), "x"), undefined); // key is "x " — the packer ignores it
  assert.ok(m.warnings.some((w) => w.line === 12)); // "x = 3"
  assert.ok(m.warnings.some((w) => w.line === 8)); // duplicate x
});

test("num follows the packer int grammar", () => {
  const m = parseIf("t", "[a]\nx=-0x10\ny=12a\n");
  assert.equal(num(find(m, "a"), "x"), -16);
  assert.equal(num(find(m, "a"), "y"), 0);
  assert.ok(m.warnings.some((w) => w.line === 2));
});

test("layer= before any header goes to the root and moves nothing", () => {
  const m = parseIf("t", "layer=a\n[a]\ntype=layer\n");
  assert.deepEqual(m.children.get(""), ["a"]);
  assert.deepEqual(m.children.get("a") ?? [], []);
  assert.equal(get(m.root, "layer"), "a");
});

test("trailing spaces in a text value are content, not a warning", () => {
  assert.deepEqual(parseIf("t", "[a]\ntext=store. \n").warnings, []);
});

test("layer= naming a missing component warns", () => {
  const m = parseIf("t", "[a]\nlayer=nope\n");
  assert.ok(m.warnings.some((w) => w.line === 1));
});

test("CRLF text keeps its eol", () => {
  const m = parseIf("t", "[a]\r\nx=1\r\n");
  assert.equal(m.eol, "\r\n");
  assert.equal(num(find(m, "a"), "x"), 1);
});

test("round trip over Content", { skip: noContent }, () => {
  const files = contentIfs();
  assert.ok(files.length >= 197, `${files.length} .if files`);
  let coms = 0;
  for (const [stem, text] of files) {
    const m = parseIf(stem, text);
    assert.equal(m.lines.join(m.eol), text, stem);
    const headers = text.split("\n").filter((l) => l.startsWith("[")).length;
    assert.equal(m.coms.length, headers, stem);
    coms += headers;
    // every component reachable exactly once from the root
    const seen = [];
    const visit = (p) => (m.children.get(p) ?? []).forEach((c) => (seen.push(c), visit(c)));
    visit("");
    assert.equal(seen.length, m.coms.length, stem);
  }
  assert.ok(coms >= 10787, `${coms} components`);
});

const { applyIntent, minimalEdit, nextComName } = require("../out/ifedit/edits.js");

const block = (text, name) => {
  const m = parseIf("t", text);
  const c = find(m, name);
  return m.lines.slice(c.header, c.end);
};

test("set rewrites the last duplicate and drops the earlier", () => {
  const out = applyIntent("t", IF, { kind: "set", com: "b", key: "x", value: "9" });
  assert.deepEqual(block(out, "b"), ["[b]", "type=rect", "layer=a", "x=9"]);
});

test("set inserts in KEY_ORDER position", () => {
  const out = applyIntent("t", "[c]\ntype=text\nx=1\nwidth=5\n", { kind: "set", com: "c", key: "y", value: "4" });
  assert.equal(out, "[c]\ntype=text\nx=1\ny=4\nwidth=5\n");
});

test("set of a non-layout key appends to the block", () => {
  const out = applyIntent("t", "[c]\ntype=text\nx=1\n\n[d]\n", { kind: "set", com: "c", key: "font", value: "p12_full" });
  assert.equal(out, "[c]\ntype=text\nx=1\nfont=p12_full\n\n[d]\n");
});

test("set on the root writes before the first header", () => {
  const out = applyIntent("t", "[a]\nx=1\n", { kind: "set", com: "", key: "type", value: "overlay" });
  assert.equal(out, "type=overlay\n[a]\nx=1\n");
});

test("set null deletes every occurrence", () => {
  const out = applyIntent("t", IF, { kind: "set", com: "b", key: "x", value: null });
  assert.deepEqual(block(out, "b"), ["[b]", "type=rect", "layer=a"]);
});

test("add appends a block with layer after type", () => {
  const keys = [["type", "graphic"], ["x", "1"], ["y", "2"], ["graphic", "invback,0"]];
  const out = applyIntent("t", IF, { kind: "add", com: "d", parent: "a", keys });
  assert.ok(out.endsWith("x = 3\n\n[d]\ntype=graphic\nlayer=a\nx=1\ny=2\ngraphic=invback,0\n"));
  assert.deepEqual(parseIf("t", out).children.get("a"), ["b", "d"]);
});

test("delete removes descendants", () => {
  const del = { kind: "delete", com: "a" };
  const out = applyIntent("t", IF, del);
  assert.equal(out, "[c]\ntype=text\nx = 3\n");
});

test("reorder moves z-order and reparents", () => {
  const out = applyIntent("t", IF, { kind: "reorder", com: "c", parent: "a", before: "b" });
  const m = parseIf("t", out);
  assert.deepEqual(m.children.get("a"), ["c", "b"]);
  assert.deepEqual(m.children.get(""), ["a"]);
  assert.deepEqual(m.warnings.filter((w) => w.message.includes("layer")), []);
});

test("reorder to the root drops layer= and goes last", () => {
  const out = applyIntent("t", IF, { kind: "reorder", com: "b", parent: "", before: null });
  const m = parseIf("t", out);
  assert.deepEqual(m.children.get(""), ["a", "c", "b"]);
  assert.equal(get(find(m, "b"), "layer"), undefined);
});

test("batch folds intents", () => {
  const out = applyIntent("t", IF, { kind: "batch", intents: [
    { kind: "set", com: "a", key: "x", value: "3" },
    { kind: "set", com: "a", key: "y", value: "4" },
  ] });
  assert.deepEqual(block(out, "a"), ["[a]", "type=layer", "x=3", "y=4", "width=100"]);
});

test("minimalEdit touches only changed lines", () => {
  const out = applyIntent("t", IF, { kind: "set", com: "b", key: "x", value: "9" });
  const e = minimalEdit(IF, out);
  assert.equal(IF.slice(0, e.start) + e.text + IF.slice(e.end), out);
  assert.equal(IF.slice(e.start, e.end), "x=5\nx=7\n");
  assert.equal(minimalEdit(IF, IF), null);
});

test("minimalEdit at end of file without trailing newline", () => {
  const e = minimalEdit("a\nb", "a\nc");
  assert.deepEqual(e, { start: 2, end: 3, text: "c" });
});

test("CRLF preserved", () => {
  const crlf = IF.replace(/\n/g, "\r\n");
  const out = applyIntent("t", crlf, { kind: "set", com: "b", key: "x", value: "9" });
  assert.ok(!/[^\r]\n/.test(out));
  assert.deepEqual(block(out, "b"), ["[b]", "type=rect", "layer=a", "x=9"]);
});

test("nextComName follows com_N", () => {
  assert.equal(nextComName(parseIf("t", "[com_3]\n[com_10]\n[x]\n")), "com_11");
  assert.equal(nextComName(parseIf("t", "")), "com_0");
});

test("no-op round trip over Content", { skip: noContent }, () => {
  for (const [stem, text] of contentIfs()) assert.equal(applyIntent(stem, text, { kind: "batch", intents: [] }), text, stem);
});

const { addIds, removeIds } = require("../out/ifedit/edits.js");
const PACK = "0=a\n1=a:x\n2=b\n3=b:y\n";
const ORDER = "0\n1\n2\n3\n";

test("addIds inserts after the interface's group", () => {
  const r = addIds(PACK, ORDER, "a", ["z"]);
  assert.equal(r.pack, "0=a\n1=a:x\n2=b\n3=b:y\n4=a:z\n");
  assert.equal(r.order, "0\n1\n4\n2\n3\n");
  assert.equal(addIds(PACK, ORDER, "b", ["q", "r"]).order, "0\n1\n2\n3\n4\n5\n");
});

test("addIds then removeIds restores both byte for byte", () => {
  const r = addIds(PACK, ORDER, "a", ["z", "w"]);
  const back = removeIds(r.pack, r.order, "a", ["z", "w"]);
  assert.equal(back.pack, PACK);
  assert.equal(back.order, ORDER);
});

test("addIds rejects duplicates", () => {
  assert.throws(() => addIds(PACK, ORDER, "a", ["x"]), /already/);
});

test("real pack round trip", { skip: noContent }, () => {
  const pack = readFileSync(join(CONTENT, "pack/interface.pack"), "latin1");
  const order = readFileSync(join(CONTENT, "pack/interface.order"), "latin1");
  const r = addIds(pack, order, "bank_main", ["zz_test"]);
  assert.notEqual(r.order, order);
  const back = removeIds(r.pack, r.order, "bank_main", ["zz_test"]);
  assert.equal(back.pack, pack);
  assert.equal(back.order, order);
});

const { NEW_COM } = require("../out/ifedit/schema.js");

test("NEW_COM entries are valid", () => {
  assert.deepEqual(Object.keys(NEW_COM).sort(), ["graphic", "inv", "invtext", "layer", "model", "rect", "text"]);
  for (const [type, keys] of Object.entries(NEW_COM)) {
    const out = applyIntent("t", "", { kind: "add", com: "n", parent: "", keys });
    const m = parseIf("t", out);
    assert.deepEqual(m.warnings, [], type);
    assert.equal(get(find(m, "n"), "type"), type);
  }
});

const { fieldsFor, schemaData } = require("../out/ifedit/schema.js");

test("fieldsFor follows what the packer writes", () => {
  const text = fieldsFor("text", undefined);
  for (const k of ["font", "center", "shadowed", "text", "activetext", "colour", "overcolour"]) assert.ok(text.includes(k), k);
  assert.ok(!text.includes("option"));
  assert.ok(fieldsFor("graphic", "normal").includes("option"));
  assert.ok(!fieldsFor("graphic", "close").includes("option"));
  for (const k of ["actionverb", "action", "actiontarget"]) assert.ok(fieldsFor("rect", "target").includes(k), k);
  const inv = fieldsFor("inv", undefined);
  for (const k of ["actiontarget", "option5", "slot20", "draggable", "margin"]) assert.ok(inv.includes(k), k);
  assert.ok(fieldsFor("layer", undefined).includes("scroll"));
  assert.ok(fieldsFor("model", undefined).includes("activeanim"));
  for (const k of ["x", "y", "width", "height", "buttontype", "clientcode", "overlayer"]) assert.ok(fieldsFor("rect", undefined).includes(k), k);
});

test("schemaData is plain data with a field table", () => {
  const d = schemaData();
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  assert.deepEqual(d.FIELDS.inv[""], fieldsFor("inv", undefined));
  assert.deepEqual(d.FIELDS.rect.target, fieldsFor("rect", "target"));
  assert.equal(d.BUTTON_DEFAULT_OPTION.pause, "Continue");
});

const { readConditions, writeConditions } = require("../out/ifedit/schema.js");
const getter = (text, name) => (k) => get(find(parseIf("t", text), name), k);
const scriptKeys = (text, name) => find(parseIf("t", text), name).keys.map((k) => k.key).filter((k) => /^script\d(op\d+)?$/.test(k));
const rewrite = (text, name, conds) => applyIntent("t", text, { kind: "batch", intents: writeConditions(name, conds, scriptKeys(text, name)) });

const COND = "[c]\ntype=text\nscript1=eq,1\nscript1op1=pushvar,bank_x\nscript2=gt,0\nscript2op1=inv_count,inventory:inv,coins\nscript2op2=subtract\n";

test("readConditions reads cmp, value and ops", () => {
  assert.deepEqual(readConditions(getter(COND, "c")), [
    { cmp: "eq", value: "1", ops: [["pushvar", "bank_x"]] },
    { cmp: "gt", value: "0", ops: [["inv_count", "inventory:inv", "coins"], ["subtract"]] },
  ]);
});

test("empty scriptNop1= round trips", () => {
  const t = "[c]\nscript1=eq,0\nscript1op1=\n";
  const conds = readConditions(getter(t, "c"));
  assert.deepEqual(conds, [{ cmp: "eq", value: "0", ops: [] }]);
  assert.equal(rewrite(t, "c", conds), t);
});

test("removing condition 1 renumbers condition 2", () => {
  const conds = readConditions(getter(COND, "c")).slice(1);
  const out = rewrite(COND, "c", conds);
  assert.deepEqual(scriptKeys(out, "c"), ["script1", "script1op1", "script1op2"]);
  assert.deepEqual(readConditions(getter(out, "c")), conds);
});

test("conditions round trip over Content", { skip: noContent }, () => {
  for (const [stem, text] of contentIfs()) {
    const m = parseIf(stem, text);
    let out = text;
    for (const c of m.coms) {
      if (!c.keys.some((k) => /^script\d/.test(k.key))) continue;
      const g = (k) => get(c, k);
      out = applyIntent(stem, out, { kind: "batch", intents: writeConditions(c.name, readConditions(g), scriptKeys(out, c.name).length ? c.keys.map((k) => k.key).filter((k) => /^script\d(op\d+)?$/.test(k)) : []) });
    }
    assert.equal(out, text, stem);
  }
});

test("a script without a comparison stays without one", () => {
  const t = "[c]\nscript1op1=runenergy\n";
  assert.deepEqual(readConditions(getter(t, "c")), [{ cmp: null, value: "", ops: [["runenergy"]] }]);
  assert.equal(rewrite(t, "c", readConditions(getter(t, "c"))), t);
});

test("conditions intent rewrites a component's scripts", () => {
  const conds = [{ cmp: "lt", value: "5", ops: [["stat_level", "magic"]] }];
  const out = applyIntent("t", COND, { kind: "conditions", com: "c", conds });
  assert.deepEqual(readConditions(getter(out, "c")), conds);
  assert.deepEqual(scriptKeys(out, "c"), ["script1", "script1op1"]);
});

test("buildFrame sends each component's conditions", () => {
  const { buildFrame } = require("../out/ifedit/session.js");
  const { Assets } = require("../out/ifedit/assets.js");
  const f = buildFrame("t", COND, new Assets("none"), { area: "main", active: false, mouse: null, showHidden: false, scroll: {}, vars: [], hidden: [] });
  assert.equal(f.coms[0].conds.length, 2);
});

test("a comparison after a script without one is refused", () => {
  const conds = [{ cmp: "eq", value: "1", ops: [["runenergy"]] }, { cmp: null, value: "", ops: [["runweight"]] }, { cmp: "eq", value: "1", ops: [["runenergy"]] }];
  assert.throws(() => writeConditions("c", conds, []), /comparison/);
  assert.equal(writeConditions("c", conds.slice(0, 2), []).filter((i) => /^script\d$/.test(i.key)).length, 1);
});

const { reconcileIds } = require("../out/ifedit/edits.js");

test("reconcileIds makes the pack follow the saved .if", () => {
  const r = reconcileIds(PACK, ORDER, "a", ["x", "z"]);
  assert.equal(r.pack, "0=a\n1=a:x\n2=b\n3=b:y\n4=a:z\n");
  assert.equal(r.order, "0\n1\n4\n2\n3\n");
  const gone = reconcileIds(PACK, ORDER, "a", []);
  assert.equal(gone.pack, "0=a\n2=b\n3=b:y\n");
  assert.equal(gone.order, "0\n2\n3\n");
  assert.deepEqual(reconcileIds(PACK, ORDER, "a", ["x"]), { pack: PACK, order: ORDER });
});

// ---- layers panel intents ----

const { copyText } = require("../out/ifedit/edits.js");
const { boxOf } = require("../out/ifedit/parse.js");
const LAYERS = "[a]\ntype=layer\nx=10\ny=10\nwidth=100\nheight=100\n\n[b]\ntype=rect\nlayer=a\nx=5\ny=5\nwidth=10\nheight=10\n\n[c]\ntype=rect\nx=50\ny=60\nwidth=20\nheight=10\n\n[d]\ntype=text\nx=30\ny=40\nwidth=10\nheight=5\n";
/** Absolute (x, y) of a component: its x/y plus every ancestor's. */
const abs = (text, name) => {
  const m = parseIf("t", text);
  const parent = (n) => [...m.children.entries()].find(([, kids]) => kids.includes(n))?.[0] ?? "";
  let [x, y] = [0, 0];
  for (let n = name; n !== ""; n = parent(n)) (x += num(find(m, n), "x")), (y += num(find(m, n), "y"));
  return [x, y];
};

test("boxOf gives pixel sizes, counting inventory cells", () => {
  const m = parseIf("t", "[i]\ntype=inv\nwidth=4\nheight=7\nmargin=10,4\n\n[t]\ntype=invtext\nwidth=2\nheight=3\nmargin=5,1\n\n[r]\ntype=rect\nwidth=9\nheight=8\n");
  assert.deepEqual(boxOf(find(m, "i")), { w: 4 * 42 - 10, h: 7 * 36 - 4 });
  assert.deepEqual(boxOf(find(m, "t")), { w: 240, h: 39 });
  assert.deepEqual(boxOf(find(m, "r")), { w: 9, h: 8 });
});

test("duplicate copies a subtree with fresh names right above the original", () => {
  const out = applyIntent("t", LAYERS, { kind: "duplicate", coms: ["a"] });
  const m = parseIf("t", out);
  assert.deepEqual(m.children.get(""), ["a", "com_0", "c", "d"]);
  assert.deepEqual(m.children.get("com_0"), ["com_1"]);
  assert.deepEqual(find(m, "com_1").keys.map((k) => `${k.key}=${k.value}`), ["type=rect", "layer=com_0", "x=5", "y=5", "width=10", "height=10"]);
  assert.ok(out.startsWith(LAYERS.slice(0, LAYERS.indexOf("[c]"))), "original lines untouched before the copy");
  assert.deepEqual(m.warnings, []);
});

test("group wraps siblings in a layer at their bounding box, keeping positions", () => {
  const out = applyIntent("t", LAYERS, { kind: "group", coms: ["c", "d"], name: "g" });
  const m = parseIf("t", out);
  assert.deepEqual(m.children.get(""), ["a", "g"]);
  assert.deepEqual(m.children.get("g"), ["c", "d"]);
  assert.deepEqual(["x", "y", "width", "height"].map((k) => num(find(m, "g"), k)), [30, 40, 40, 30]);
  assert.deepEqual(abs(out, "c"), [50, 60]);
  assert.deepEqual(abs(out, "d"), [30, 40]);
  assert.deepEqual(m.warnings, []);
});

test("group inside a layer stays in that layer", () => {
  const m = parseIf("t", applyIntent("t", LAYERS, { kind: "group", coms: ["b"], name: "g" }));
  assert.deepEqual(m.children.get("a"), ["g"]);
  assert.deepEqual(m.children.get("g"), ["b"]);
});

test("group refuses components from different layers", () => {
  assert.throws(() => applyIntent("t", LAYERS, { kind: "group", coms: ["b", "c"], name: "g" }), /same layer/);
});

test("ungroup moves children up in the layer's place and keeps positions", () => {
  const out = applyIntent("t", LAYERS, { kind: "ungroup", com: "a" });
  const m = parseIf("t", out);
  assert.deepEqual(m.children.get(""), ["b", "c", "d"]);
  assert.equal(find(m, "a"), undefined);
  assert.deepEqual(abs(out, "b"), [15, 15]);
  const back = applyIntent("t", applyIntent("t", LAYERS, { kind: "group", coms: ["c", "d"], name: "g" }), { kind: "ungroup", com: "g" });
  assert.deepEqual([abs(back, "c"), abs(back, "d")], [[50, 60], [30, 40]]);
});

test("copyText is the exact block text of whole subtrees", () => {
  assert.equal(copyText("t", LAYERS, ["a"]), "[a]\ntype=layer\nx=10\ny=10\nwidth=100\nheight=100\n\n[b]\ntype=rect\nlayer=a\nx=5\ny=5\nwidth=10\nheight=10\n");
  assert.equal(copyText("t", LAYERS, ["b", "a"]), copyText("t", LAYERS, ["a"]), "a child of a copied layer is not copied twice");
});

test("paste renames clashes, remaps layers and lands in the target", () => {
  const out = applyIntent("t", LAYERS, { kind: "paste", text: copyText("t", LAYERS, ["a"]), parent: "" });
  const m = parseIf("t", out);
  assert.deepEqual(m.children.get(""), ["a", "c", "d", "com_0"]);
  assert.deepEqual(m.children.get("com_0"), ["com_1"]);
  assert.equal(get(find(m, "com_0"), "layer"), undefined);
  const into = parseIf("t", applyIntent("t", LAYERS, { kind: "paste", text: "[zz]\ntype=rect\nlayer=gone\nx=1\n", parent: "a" }));
  assert.deepEqual(into.children.get("a"), ["b", "zz"]);
  assert.deepEqual(into.warnings, []);
});

test("paste into another file keeps names that are free there", () => {
  const out = applyIntent("u", "[x]\ntype=rect\n", { kind: "paste", text: copyText("t", LAYERS, ["c"]), parent: "" });
  assert.equal(out, "[x]\ntype=rect\n\n[c]\ntype=rect\nx=50\ny=60\nwidth=20\nheight=10\n");
});

test("addIds gives a new interface its own id and group", () => {
  const r = addIds(PACK, ORDER, "c", ["x", "y"]);
  assert.equal(r.pack, PACK + "4=c\n5=c:x\n6=c:y\n");
  assert.equal(r.order, ORDER + "4\n5\n6\n");
  assert.deepEqual(reconcileIds(PACK, ORDER, "c", ["x", "y"]), r);
  assert.deepEqual(reconcileIds(PACK, ORDER, "c", []), { pack: PACK + "4=c\n", order: ORDER + "4\n" });
});
