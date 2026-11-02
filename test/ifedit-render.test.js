const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { decodePng, encodePng } = require("../out/ifedit/png.js");
const { Assets, FONT_NAMES } = require("../out/ifedit/assets.js");

const CONTENT = process.env.RS2_CONTENT;
const noContent = !CONTENT;

test("png round trip", () => {
  const rgba = new Uint8Array([255, 0, 255, 255, 0, 0, 0, 255]);
  const img = decodePng(encodePng(2, 1, rgba));
  assert.equal(img.width, 2);
  assert.equal(img.height, 1);
  assert.deepEqual([...img.rgba], [...rgba]);
});

test("png rejects what it does not decode", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")));
});

test("content sprites decode", { skip: noContent }, () => {
  const a = new Assets(CONTENT);
  for (const name of a.sheetNames()) if (name !== "hitmarks - Copy") assert.ok(a.sheet(name), name);
});

test("steelborder2 tiles", { skip: noContent }, () => {
  const a = new Assets(CONTENT);
  const img = decodePng(readFileSync(join(CONTENT, "sprites/steelborder2.png")));
  const s = a.sheet("steelborder2");
  assert.equal(s.tileW, 36);
  assert.equal(s.tileH, 36);
  assert.equal(s.tiles.length, (img.width / 36) * (img.height / 36));
  const t = a.sprite("steelborder2,1");
  assert.ok(t);
  assert.equal(t.owi, 36);
  assert.ok(t.xof + t.wi <= 36 && t.yof + t.hi <= 36);
});

test("tile pixels: magenta is 0, black is 1", { skip: noContent }, () => {
  const a = new Assets(CONTENT);
  const t = a.sprite("steelborder2,0");
  assert.ok(!t.pixels.includes(0xff00ff));
  for (const s of a.sheetNames()) for (const tile of a.sheet(s)?.tiles ?? []) assert.ok(!tile.pixels.includes(0xff00ff), s);
});

test("missing sprites are undefined", { skip: noContent }, () => {
  const a = new Assets(CONTENT);
  assert.equal(a.sprite("nope,0"), undefined);
  assert.equal(a.sprite("steelborder2,999"), undefined);
  assert.equal(a.sprite("steelborder2"), undefined);
});

test("sprite spec splits on the last comma", { skip: noContent }, () => {
  const a = new Assets(CONTENT);
  a.sheet = (name) => (name === "a,b" ? { tiles: ["hit"] } : undefined);
  assert.equal(a.sprite("a,b,0"), "hit");
});

test("font metrics", { skip: noContent }, () => {
  const a = new Assets(CONTENT);
  FONT_NAMES.forEach((name, id) => {
    const f = a.font(id);
    assert.ok(f.height >= 8 && f.height <= 20, name);
    assert.equal(f.advance[32], f.advance[name === "q8_full" ? 73 : 105], name);
    assert.ok(f.advance[65] > 0, name);
    assert.ok(f.mask[65].some((v) => v !== 0), name);
  });
  assert.equal(a.font(4), undefined);
});


const { parseIf } = require("../out/ifedit/parse.js");
const { render } = require("../out/ifedit/render.js");

const STATE = { area: "main", active: false, mouse: null, showHidden: false, scroll: {}, vars: ["0", "0", "0", "0", "0"], hidden: [] };
const NO_ASSETS = new Assets("does-not-exist");
const draw = (text, state = {}) => render(parseIf("t", text), NO_ASSETS, { ...STATE, ...state });
const px = (r, x, y) => r.pixels[x + y * r.width];

test("rect fill and outline", () => {
  const fill = draw("[r]\ntype=rect\nx=1\ny=1\nwidth=3\nheight=2\ncolour=0xff0000\nfill=yes\n");
  assert.equal(fill.width, 512);
  assert.equal(fill.height, 334);
  assert.equal(px(fill, 1, 1), 0xff0000);
  assert.equal(px(fill, 3, 2), 0xff0000);
  assert.equal(fill.pixels.filter((p) => p !== 0).length, 6);
  const outline = draw("[r]\ntype=rect\nwidth=4\nheight=4\ncolour=0xff0000\n");
  assert.equal(outline.pixels.filter((p) => p !== 0).length, 12);
  assert.equal(px(outline, 1, 1), 0);
});

test("trans rect blends", () => {
  const r = draw("[r]\ntype=rect\nwidth=2\nheight=2\ncolour=0xff0000\nfill=yes\ntrans=128\n");
  assert.equal(px(r, 0, 0), 0x7f0000);
});

test("layer clips children", () => {
  const r = draw("[l]\ntype=layer\nx=20\ny=20\nwidth=10\nheight=10\n\n[r]\ntype=rect\nlayer=l\nx=-5\nwidth=10\nheight=10\nfill=yes\ncolour=0xffffff\n");
  for (let y = 0; y < r.height; y++) for (let x = 0; x < 20; x++) assert.equal(px(r, x, y), 0);
  assert.equal(px(r, 20, 20), 0xffffff);
  assert.equal(px(r, 24, 20), 0xffffff);
  assert.equal(px(r, 25, 20), 0);
  const box = r.boxes.find((b) => b.com === "r");
  assert.deepEqual([box.x, box.y, box.originX, box.originY, box.parent], [15, 20, 20, 20, "l"]);
});

test("hidden layer draws only with showHidden or through an overlayer trigger", () => {
  const IF = "[l]\ntype=layer\nhide=yes\nx=20\nwidth=10\nheight=10\n\n[r]\ntype=rect\nlayer=l\nwidth=5\nheight=5\nfill=yes\ncolour=0xffffff\n\n[t]\ntype=rect\nwidth=4\nheight=4\noverlayer=l\n";
  const lit = (r) => r.pixels.some((p) => p === 0xffffff);
  assert.ok(!lit(draw(IF)));
  assert.ok(draw(IF).boxes.some((b) => b.com === "l"));
  assert.ok(lit(draw(IF, { showHidden: true })));
  assert.ok(!lit(draw(IF, { mouse: [21, 1] })), "hovering the hidden layer itself does not reveal it");
  assert.ok(lit(draw(IF, { mouse: [1, 1] })), "hovering the trigger reveals its overlayer");
});

test("active colours need comparisons", () => {
  const IF = "[r]\ntype=rect\nwidth=1\nheight=1\nfill=yes\ncolour=0xff0000\nactivecolour=0x00ff00\n";
  assert.equal(px(draw(IF, { active: true }), 0, 0), 0xff0000);
  assert.equal(px(draw(IF + "script1op1=runenergy\n", { active: true }), 0, 0), 0xff0000, "a value-only script is never active");
  assert.equal(px(draw(IF + "script1=eq,1\nscript1op1=pushvar,x\n", { active: true }), 0, 0), 0x00ff00);
});

test("hover follows the client: last component under the mouse with an overcolour or overlayer", () => {
  const IF = "[r]\ntype=rect\nwidth=4\nheight=4\nfill=yes\ncolour=0xff0000\novercolour=0x0000ff\n\n[t]\ntype=rect\nwidth=2\nheight=2\n";
  assert.equal(px(draw(IF, { mouse: [1, 1] }), 3, 3), 0x0000ff, "t has no hover effect, so r under it still highlights");
  assert.equal(px(draw(IF, { mouse: [9, 9] }), 3, 3), 0xff0000);
  assert.equal(px(draw(IF.replace("height=2\n", "height=2\novercolour=0x00ff00\n"), { mouse: [1, 1] }), 3, 3), 0xff0000, "t now wins the hover");
});

test("bad number renders as 0", () => {
  const r = draw("[r]\ntype=rect\nx=12a\nwidth=1\nheight=1\nfill=yes\ncolour=0xffffff\n");
  assert.equal(px(r, 0, 0), 0xffffff);
});

test("area sizes", () => {
  assert.deepEqual([draw("", { area: "side" }).width, draw("", { area: "side" }).height], [190, 261]);
  assert.deepEqual([draw("", { area: "chat" }).width, draw("", { area: "chat" }).height], [479, 96]);
});

test("missing assets draw nothing and do not throw", () => {
  const r = draw("[g]\ntype=graphic\ngraphic=nope,0\n\n[t]\ntype=text\nfont=p12_full\ntext=hi\n\n[i]\ntype=inv\nwidth=2\nheight=2\nslot1=nope,0\n");
  assert.ok(r.pixels.every((p) => p === 0));
  assert.equal(r.boxes.length, 3);
});

test("inv and invtext boxes are cell grids", () => {
  const r = draw("[i]\ntype=inv\nwidth=4\nheight=7\nmargin=10,4\n\n[t]\ntype=invtext\nwidth=2\nheight=3\nmargin=5,1\n");
  const i = r.boxes.find((b) => b.com === "i");
  assert.deepEqual([i.w, i.h], [4 * 42 - 10, 7 * 36 - 4]);
  const t = r.boxes.find((b) => b.com === "t");
  assert.deepEqual([t.w, t.h], [2 * 120, 3 * 13]);
});

// Pixel snapshots of real interfaces; BLESS=1 rewrites them.
const SNAPSHOTS = { bank_main: "main", shop_template: "main", inventory: "side", stats: "side", magic: "side", npcchat2: "chat" };
const { encodePng: enc } = require("../out/ifedit/png.js");
const { readdirSync, statSync } = require("node:fs");
function findIf(dir, stem) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const hit = findIf(p, stem);
      if (hit) return hit;
    } else if (name === `${stem}.if`) return p;
  }
}
for (const [stem, area] of Object.entries(SNAPSHOTS)) {
  test(`snapshot ${stem}`, { skip: noContent }, () => {
    const assets = new Assets(CONTENT);
    const r = render(parseIf(stem, readFileSync(findIf(join(CONTENT, "scripts"), stem), "latin1")), assets, { ...STATE, area });
    const rgba = new Uint8Array(r.width * r.height * 4);
    r.pixels.forEach((p, i) => rgba.set([(p >> 16) & 255, (p >> 8) & 255, p & 255, 255], i * 4));
    const png = enc(r.width, r.height, rgba);
    const file = join(__dirname, "ifedit", "snapshots", `${stem}.png`);
    if (process.env.BLESS) {
      mkdirSync(join(__dirname, "ifedit", "snapshots"), { recursive: true });
      writeFileSync(file, png);
    } else {
      assert.ok(existsSync(file), `${file} missing: run with BLESS=1`);
      assert.ok(readFileSync(file).equals(png), `${stem} differs from its snapshot`);
    }
  });
}

const { buildFrame, buildCatalog } = require("../out/ifedit/session.js");

test("buildFrame carries pixels, boxes, coms and tree", () => {
  const f = buildFrame("t", "[a]\ntype=layer\nwidth=10\nheight=10\n\n[b]\ntype=rect\nlayer=a\n", NO_ASSETS, STATE);
  assert.equal(f.type, "frame");
  assert.equal(f.rgba.length, 512 * 334 * 4);
  assert.deepEqual(f.tree, { "": ["a"], a: ["b"] });
  assert.deepEqual(f.coms[1], { name: "b", keys: [["type", "rect"], ["layer", "a"]], conds: [] });
  assert.equal(f.boxes.length, 2);
});

test("buildCatalog lists sheets, fonts and pack names", { skip: noContent }, () => {
  const c = buildCatalog(CONTENT, new Assets(CONTENT), "colour=0xff981f\ncolour=0xff981f\n");
  assert.ok(c.sheets.some((s) => s.name === "steelborder2" && s.tileW === 36));
  assert.equal(c.fonts.length, 4);
  assert.ok(c.lists.obj.length > 1000);
  assert.ok(c.lists.interface.every((n) => n.includes(":")));
  assert.deepEqual(c.colours, [0xff981f]);
});

test("hidden components and their children draw nothing and have no box", () => {
  const IF = "[l]\ntype=layer\nwidth=10\nheight=10\n\n[r]\ntype=rect\nlayer=l\nwidth=5\nheight=5\nfill=yes\ncolour=0xffffff\n";
  const r = draw(IF, { hidden: ["l"] });
  assert.ok(r.pixels.every((p) => p === 0));
  assert.deepEqual(r.boxes, []);
  assert.ok(draw(IF, { hidden: [] }).pixels.some((p) => p !== 0));
});

const { layout } = require("../out/ifedit/render.js");

test("layout places every component, drawn or not", () => {
  const IF = "[l]\ntype=layer\nhide=yes\nx=20\ny=10\nwidth=50\nheight=50\nscroll=200\n\n[r]\ntype=rect\nlayer=l\nx=5\ny=30\nwidth=4\nheight=3\n\n[i]\ntype=inv\nx=1\ny=2\nwidth=2\nheight=1\n";
  const at = (boxes, name) => { const b = boxes.find((b) => b.com === name); return b && [b.x, b.y, b.w, b.h]; };
  const model = parseIf("t", IF);
  const boxes = layout(model, { ...STATE, hidden: ["i"], scroll: { l: 20 } });
  assert.deepEqual(at(boxes, "l"), [20, 10, 50, 50]);
  assert.deepEqual(at(boxes, "r"), [25, 20, 4, 3], "inside a hide=yes layer, scrolled by 20");
  assert.deepEqual(at(boxes, "i"), [1, 2, 64, 32], "eye-hidden still has a place");
});
