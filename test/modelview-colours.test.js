const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { rgb15Colours } = require("../out/features/scan.js");
const { rgb15ToHsl16, rgb15ForHsl16, rgb15ToRgb24, rgb24ToRgb15 } = require("../out/modelview/colour.js");
const { recolSlots, freeRecolSlot, keyEdits } = require("../out/modelview/controls.js");
const { Content } = require("../out/modelview/content.js");
const { blockAt } = require("../out/modelview/npc.js");
const { buildObj } = require("../out/modelview/obj.js");

const CONTENT = process.env.RS2_CONTENT;

test("rgb15Colours finds recol#s/d values only", () => {
  const text = "recol1s=15855\nrecol12d = 8354 // bronze\nrecol1s=40000\ncolour=0x444444\nretex1s=wall\n";
  assert.deepEqual(rgb15Colours(text), [
    { line: 0, start: 8, end: 13, rgb15: 15855 },
    { line: 1, start: 11, end: 15, rgb15: 8354 },
  ]);
});

test("rgb15ForHsl16 inverts rgb15ToHsl16 where it can", () => {
  for (const rgb of [0, 15855, 8354, 2340, 4226, 32767, 12345]) {
    const hsl = rgb15ToHsl16(rgb);
    assert.equal(rgb15ToHsl16(rgb15ForHsl16(hsl)), hsl);
  }
  const reachable = new Set(Array.from({ length: 32768 }, (_, i) => rgb15ToHsl16(i)));
  const unreachable = Array.from({ length: 65536 }, (_, i) => i).find((h) => !reachable.has(h));
  assert.equal(rgb15ForHsl16(unreachable), undefined);
  assert.equal(rgb24ToRgb15(rgb15ToRgb24(12345)), 12345);
});

test("recolSlots pairs halves; freeRecolSlot skips recol and retex slots", () => {
  const lines = [["recol2d", "5"], ["recol1s", "1"], ["recol1d", "2"], ["retex3s", "wall"], ["recol4s", ""]];
  assert.deepEqual(recolSlots(lines), [{ slot: 1, s: 1, d: 2 }, { slot: 2, d: 5 }]);
  // recol4s has no value but its line exists: reusing slot 4 would duplicate the key
  assert.equal(freeRecolSlot(lines), 5);
  assert.equal(freeRecolSlot(Array.from({ length: 9 }, (_, i) => [`recol${i + 1}s`, "0"])), undefined);
});

test("keyEdits joins insertions at the same place and removes lines", () => {
  const text = ["[a]", "model=x", "recol1s=1", "recol1d=2", "", "[b]"];
  const add = keyEdits(text, 0, 5, [["recol2s", 7], ["recol2d", 7]]);
  assert.equal(add.length, 1);
  assert.equal(add[0].text, "\nrecol2s=7\nrecol2d=7");
  const remove = keyEdits(text, 0, 5, [["recol1s", undefined], ["recol1d", undefined]]);
  assert.deepEqual(remove.map((e) => [e.from, e.to]), [[[2, 0], [3, 0]], [[3, 0], [4, 0]]]);
});

test("faceSource keeps the colours before the block's recolours", { skip: !CONTENT }, () => {
  const text = readFileSync(join(CONTENT, "scripts", "skill_combat", "configs", "melee", "swords.obj"), "latin1");
  const block = blockAt(text, text.split(/\r?\n/).indexOf("[bronze_sword]") + 1);
  const scene = buildObj(new Content(CONTENT), block.lines);
  assert.equal(scene.faceSource.length, scene.faces);
  // recol1s=15855 (HSL 61) is replaced on screen, but the eyedropper still sees the source
  assert.ok(scene.faceSource.includes(rgb15ToHsl16(15855)));
  assert.ok(!scene.faceSource.includes(rgb15ToHsl16(8354)));
});
