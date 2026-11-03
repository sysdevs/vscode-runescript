const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { rgb15ToHsl16, colourTable } = require("../out/modelview/colour.js");
const { decodeOb2, merge, light } = require("../out/modelview/ob2.js");
const { Content } = require("../out/modelview/content.js");
const { blockAt, npcSeqs, buildNpc } = require("../out/modelview/npc.js");

const CONTENT = process.env.RS2_CONTENT;
const noContent = !CONTENT;

const NPC = "// comment\n[a]\nmodel1=x\n\n[b]\nreadyanim=r\nwalkanim=w1,w2,w3,w4 // four\nmodel1=y\n";

test("blockAt finds the block around a line", () => {
  assert.equal(blockAt(NPC, 0), undefined);
  assert.equal(blockAt(NPC, 3).name, "a");
  const b = blockAt(NPC, 7);
  assert.equal(b.name, "b");
  assert.deepEqual(b.lines, [["readyanim", "r"], ["walkanim", "w1,w2,w3,w4"], ["model1", "y"]]);
});

test("npcSeqs lists readyanim, walkanim entries, then seq params", () => {
  const seqs = (lines, params) => npcSeqs(lines, params).map((c) => `${c.key}:${c.seq}`);
  assert.deepEqual(seqs(blockAt(NPC, 5).lines), ["readyanim:r", "walkanim:w1", "walkanim:w2", "walkanim:w3", "walkanim:w4"]);
  assert.deepEqual(seqs([["walkanim", "w"], ["readyanim", "w"]]), ["readyanim:w"]);
  const lines = [["param", "attack_anim,a"], ["param", "attack_sound,s"], ["param", "defend_anim, d"], ["readyanim", "r"]];
  assert.deepEqual(seqs(lines, new Set(["attack_anim", "defend_anim"])), ["readyanim:r", "attack_anim:a", "defend_anim:d"]);
});

test("rgb15ToHsl16 matches face colours configs recolour", () => {
  // bronze_sword recol1s=15855 is a face colour of inv_shortsword; [man] recol1s=2340 of man_legs_basic
  assert.equal(rgb15ToHsl16(15855), 61);
  assert.equal(rgb15ToHsl16(2340), 25238);
  assert.equal(rgb15ToHsl16(0), 0);
  assert.equal(rgb15ToHsl16(32767), 127);
});

test("colourTable is the client's (lightness 0 is black)", () => {
  const t = colourTable();
  assert.equal(t.length, 65536);
  assert.equal(t[0], 0);
  assert.ok(t[127] > 0xf00000);
});

/** A one-triangle model: 3 points, 1 face of type 1 (three new indices). */
function triangle(colour) {
  const bytes = [
    7, 7, 7, // vertex flags: x, y and z deltas
    1, // face order
    0x40, 0x41, 0x41, // face indices 0, +1, +1
    colour >> 8, colour & 0xff,
    0x40, 0x4a, 0x40, // x: 0, 10, 0
    0x40, 0x40, 0x4a, // y: 0, 0, 10
    0x40, 0x40, 0x40, // z: 0, 0, 0
    // trailer
    0, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 3, 0, 3, 0, 3,
  ];
  return new Uint8Array(bytes);
}

test("decodeOb2 reads points, faces and colours", () => {
  const m = decodeOb2(triangle(1234));
  assert.equal(m.numPoints, 3);
  assert.deepEqual([...m.pointX], [0, 10, 10]);
  assert.deepEqual([...m.pointY], [0, 0, 10]);
  assert.deepEqual([m.faceA[0], m.faceB[0], m.faceC[0]], [0, 1, 2]);
  assert.deepEqual([...m.faceColour], [1234]);
  assert.throws(() => decodeOb2(new Uint8Array(4)));
});

test("merge shares points at equal coordinates", () => {
  const m = merge([decodeOb2(triangle(1)), decodeOb2(triangle(2))]);
  assert.equal(m.numPoints, 3);
  assert.equal(m.numFaces, 2);
  assert.deepEqual([...m.faceColour], [1, 2]);
  const { colA } = light(m, 64, 850, -30, -50, -30);
  assert.equal(colA.length, 2);
});

test("real models decode", { skip: noContent }, () => {
  const m = decodeOb2(readFileSync(join(CONTENT, "models", "chathead", "dwarf_chat_model0.ob2")));
  assert.equal(m.numPoints, 176);
  assert.equal(m.numFaces, 327);
});

test("[man] builds merged, recoloured and animated", { skip: noContent }, () => {
  const content = new Content(CONTENT);
  const text = readFileSync(join(CONTENT, "scripts", "_unpack", "225", "all.npc"), "latin1");
  const lines = text.split(/\r?\n/);
  const block = blockAt(text, lines.indexOf("[man]") + 1);
  assert.equal(block.name, "man");

  const ready = buildNpc(content, block.lines);
  assert.deepEqual(ready.warnings, []);
  assert.equal(ready.seq, "human_ready");
  assert.equal(ready.frames.length, content.seq("human_ready").frames.length);
  assert.ok(ready.frames.length > 1);
  assert.notDeepEqual(ready.frames[0], ready.frames[1]);
  assert.equal(ready.colours.length, ready.frames.length);
  assert.equal(ready.colours[0].length, ready.faces * 12);

  const still = buildNpc(content, block.lines, { seq: "" });
  assert.equal(still.frames.length, 1);
  assert.equal(still.faces, ready.faces);

  const warriorText = readFileSync(join(CONTENT, "scripts", "areas", "area_alkharid", "configs", "alkharid.npc"), "latin1");
  const warrior = blockAt(warriorText, warriorText.split(/\r?\n/).indexOf("[al_kharid_warrior]") + 1);
  const seqs = npcSeqs(warrior.lines, content.seqParams());
  assert.ok(seqs.some((c) => c.key === "attack_anim" && c.seq === "human_sword_slash"));
  assert.ok(seqs.some((c) => c.key === "defend_anim" && c.seq === "human_sword_def"));
  const attack = buildNpc(content, warrior.lines, { seq: "human_sword_slash" });
  assert.deepEqual(attack.warnings, []);
  assert.equal(attack.frames.length, content.seq("human_sword_slash").frames.length);

  const bad = buildNpc(content, [["model1", "no_such_model"], ["readyanim", "no_such_seq"]]);
  assert.deepEqual(bad.warnings, ["unknown model no_such_model"]);
  assert.equal(bad.frames.length, 0);
});
