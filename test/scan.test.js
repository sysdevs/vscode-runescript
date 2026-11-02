const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { scriptHeaders, sections, colours, wordAt } = require("../out/features/scan.js");

const fixture = (name) => readFileSync(join(__dirname, "grammar", name), "utf8");

test("scriptHeaders finds every [trigger,subject] in border_gate.rs2", () => {
  const hs = scriptHeaders(fixture("border_gate.rs2"));
  assert.ok(hs.length >= 3);
  assert.deepEqual(hs[0], { trigger: "ai_timer", subject: "borderguard1", line: 0 });
  assert.ok(hs.some((h) => h.trigger === "label" && h.subject === "pass_toll_gate"));
});

test("sections reads [name] headers and ^constants", () => {
  assert.deepEqual(sections("// c\n[hans]\nop1=Talk-to\n\n[cook]\n"), [
    { name: "hans", line: 1 },
    { name: "cook", line: 4 },
  ]);
  assert.deepEqual(sections("^exact_north = 0\n^string_empty =\n"), [
    { name: "^exact_north", line: 0 },
    { name: "^string_empty", line: 1 },
  ]);
});

test("colours finds 0xRRGGBB only", () => {
  assert.deepEqual(colours("colour=0x444444\nx=0x12\n"), [{ line: 0, start: 7, end: 15, hex: "444444" }]);
});

test("wordAt returns the identifier and its sigil", () => {
  const line = "    ~chatplayer(\"<p,happy>Hi\"); @go(1); ^max; .%trade; $x; tanner:com_96";
  assert.deepEqual(wordAt(line, 6), { sigil: "~", name: "chatplayer", start: 5, end: 15 });
  assert.equal(wordAt(line, line.indexOf("go")).sigil, "@");
  assert.equal(wordAt(line, line.indexOf("max")).sigil, "^");
  assert.equal(wordAt(line, line.indexOf("trade")).sigil, "%");
  assert.equal(wordAt(line, line.indexOf("$x") + 1).sigil, "$");
  assert.deepEqual(wordAt(line, line.indexOf("com_96")).name, "tanner:com_96");
  assert.equal(wordAt(line, 2), undefined);
});
