const test = require("node:test");
const assert = require("node:assert/strict");
const { controlsFor, clampFor, keyEdit, withValue } = require("../out/modelview/controls.js");

/** Applies a keyEdit to text lines (single-line or line-joining edits). */
function apply(lines, e) {
  const text = lines.join("\n");
  const offset = ([l, c]) => lines.slice(0, l).reduce((n, s) => n + s.length + 1, 0) + c;
  return (text.slice(0, offset(e.from)) + e.text + text.slice(offset(e.to))).split("\n");
}

test("controlsFor lists a type's keys for the view, with values and defaults", () => {
  const lines = [["model", "x"], ["2dzoom", "1200"], ["2dxof", "65534"], ["2dxan", "9999"]];
  const icon = controlsFor("runescript-obj", lines, "inventory");
  const by = Object.fromEntries(icon.map((c) => [c.key, c]));
  assert.deepEqual(Object.keys(by), ["2dzoom", "2dxan", "2dyan", "2dzan", "2dxof", "2dyof", "resizex", "resizey", "resizez", "ambient", "contrast"]);
  assert.equal(by["2dzoom"].value, 1200);
  assert.equal(by["2dzoom"].set, true);
  assert.equal(by["2dxof"].value, -2, "the unsigned spelling of a signed 16-bit value");
  assert.equal(by["2dxan"].value, 2047, "clamped to the sine table");
  assert.equal(by["2dyan"].set, false);
  assert.equal(by["resizex"].value, 128);
  // the 2d keys only matter to the icon
  assert.ok(!controlsFor("runescript-obj", lines, "ground").some((c) => c.key === "2dzoom"));
  assert.deepEqual(controlsFor("runescript-obj", lines, "manwear"), []);
  assert.deepEqual(controlsFor("runescript-idk", lines, "body"), []);
});

test("the slider span widens to the value; clampFor keeps keys in range", () => {
  const [zoom] = controlsFor("runescript-obj", [["2dzoom", "9000"]], "inventory");
  assert.equal(zoom.hi, 9000);
  assert.equal(clampFor("runescript-obj", "2dzoom", 70000), 65535);
  assert.equal(clampFor("runescript-obj", "2dyof", -40000), -32768);
  assert.equal(clampFor("runescript-loc", "ambient", -5), 0);
  assert.equal(clampFor("runescript-spotanim", "angle", 90.4), 90);
});

const BLOCK = ["[a]", "model=x", "2dzoom=1000 // close", "", "[b]", "2dzoom=5"];

test("keyEdit rewrites the value and keeps a trailing comment", () => {
  const e = keyEdit(BLOCK, 0, 4, "2dzoom", 1500);
  assert.deepEqual(apply(BLOCK, e), ["[a]", "model=x", "2dzoom=1500 // close", "", "[b]", "2dzoom=5"]);
});

test("keyEdit adds a missing key after the block's last non-blank line", () => {
  const e = keyEdit(BLOCK, 0, 4, "2dxan", 64);
  assert.deepEqual(apply(BLOCK, e), ["[a]", "model=x", "2dzoom=1000 // close", "2dxan=64", "", "[b]", "2dzoom=5"]);
  assert.equal(keyEdit(BLOCK, 0, 4, "2dxan", 64, "\r\n").text, "\r\n2dxan=64");
});

test("keyEdit removes a key's line, and does nothing for a missing one", () => {
  assert.deepEqual(apply(BLOCK, keyEdit(BLOCK, 0, 4, "2dzoom", undefined)), ["[a]", "model=x", "", "[b]", "2dzoom=5"]);
  // the last line of the text has no line after it to join onto
  assert.deepEqual(apply(BLOCK, keyEdit(BLOCK, 4, 6, "2dzoom", undefined)), ["[a]", "model=x", "2dzoom=1000 // close", "", "[b]"]);
  assert.equal(keyEdit(BLOCK, 0, 4, "2dxan", undefined), undefined);
});

test("withValue replaces or removes a key in block lines", () => {
  const lines = [["a", "1"], ["b", "2"], ["a", "3"]];
  assert.deepEqual(withValue(lines, "a", 9), [["b", "2"], ["a", "9"]]);
  assert.deepEqual(withValue(lines, "a", undefined), [["b", "2"]]);
});
