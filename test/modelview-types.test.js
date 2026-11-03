const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { decodeOb2, mirror, rotate90, resize, translate, copyPoints } = require("../out/modelview/ob2.js");
const { Content } = require("../out/modelview/content.js");
const { blockAt } = require("../out/modelview/npc.js");
const { buildObj, objViews } = require("../out/modelview/obj.js");
const { buildLoc, locModels } = require("../out/modelview/loc.js");
const { buildIdk, idkViews } = require("../out/modelview/idk.js");
const { buildSpotanim } = require("../out/modelview/spotanim.js");
const { recolours } = require("../out/modelview/scene.js");

const CONTENT = process.env.RS2_CONTENT;
const noContent = !CONTENT;

/** A one-triangle model at (0,0,0), (10,0,0), (10,10,0). */
function triangle() {
  return decodeOb2(new Uint8Array([7, 7, 7, 1, 0x40, 0x41, 0x41, 0, 5, 0x40, 0x4a, 0x40, 0x40, 0x40, 0x4a, 0x40, 0x40, 0x40, 0, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 3, 0, 3, 0, 3]));
}

test("ob2 ops follow the client's", () => {
  const m = triangle();
  mirror(m);
  assert.deepEqual([m.faceA[0], m.faceB[0], m.faceC[0]], [2, 1, 0]);
  const r = copyPoints(m);
  rotate90(r);
  assert.deepEqual([...r.pointX], [0, 0, 0]);
  assert.deepEqual([...r.pointZ], [0, -10, -10]);
  assert.deepEqual([...m.pointX], [0, 10, 10]);
  resize(m, 64, 256, 128);
  translate(m, 1, 2, 3);
  assert.deepEqual([...m.pointX], [1, 6, 6]);
  assert.deepEqual([...m.pointY], [2, 2, 22]);
});

test("locModels expands stems: centrepieces first, then by shape", () => {
  const have = new Set(["door_1", "door", "door_q", "post", "post_5"]);
  const got = locModels([["model", "door"], ["model2", "post"]], (n) => have.has(n));
  assert.deepEqual(got.map((p) => `${p.name}:${p.shape}`), ["door:10", "post:10", "door_1:0", "door_q:4", "post_5:9"]);
});

test("objViews and idkViews list what the block defines", () => {
  assert.deepEqual(objViews([["model", "a"], ["womanwear", "b,0"], ["manhead", "c"]]).map((v) => v.key), ["ground", "inventory", "womanwear", "manhead"]);
  assert.deepEqual(objViews([["manwear", "b,0"]]).map((v) => v.key), ["manwear"]);
  assert.deepEqual(idkViews([["head1", "h"], ["model1", "m"]]).map((v) => v.key), ["body", "head"]);
});

/** The block `[name]` from a Content config file. */
function block(rel, name) {
  const text = readFileSync(join(CONTENT, "scripts", ...rel.split("/")), "latin1");
  const b = blockAt(text, text.split(/\r?\n/).indexOf(`[${name}]`) + 1);
  assert.equal(b.name, name);
  return b.lines;
}

test("obj: ground, inventory icon and worn views", { skip: noContent }, () => {
  const content = new Content(CONTENT);
  const sword = block("skill_combat/configs/melee/swords.obj", "bronze_sword");
  const ground = buildObj(content, sword);
  assert.equal(ground.view, "ground");
  assert.deepEqual(ground.warnings, []);
  assert.equal(ground.faces, content.model("inv_shortsword").numFaces);
  // recol1s=15855 is a face colour of the model; after recolouring it is gone
  const [[s, d]] = recolours(content, sword);
  assert.ok(content.model("inv_shortsword").faceColour.includes(s));
  assert.notEqual(s, d);

  const icon = buildObj(content, sword, { view: "inventory" });
  assert.equal(icon.camera, "icon");
  assert.equal(icon.faces, ground.faces);
  for (let i = 2; i < icon.frames[0].length; i += 3) assert.ok(icon.frames[0][i] > 0, "icon points sit in front of the camera");

  const robe = block("areas/area_canifis/configs/canifis.obj", "wolfenrobetop_grey");
  const worn = buildObj(content, robe, { view: "manwear" });
  assert.deepEqual(worn.warnings, []);
  assert.equal(worn.faces, content.model("man_arms_longsleeves").numFaces + content.model("man_torso_basic").numFaces);
});

test("loc: shapes, retexture, merged centrepieces and per-frame lighting", { skip: noContent }, () => {
  const content = new Content(CONTENT);
  const doorLines = block("areas/areas_heroes_guild/configs/heroes_guild.loc", "herodoor_l");
  assert.deepEqual(locModels(doorLines, (n) => content.hasModel(n)).map((p) => `${p.name}:${p.shape}`), ["castle_doubledoorl_1:0"]);
  const door = buildLoc(content, doorLines);
  assert.deepEqual(door.warnings, []);
  assert.equal(door.parts.length, 0);
  // retex1s=wall → retex1d=door2 reaches the recolour slots as texture ids
  assert.ok(recolours(content, doorLines, true).some(([s, d]) => s === content.textureId("wall") && d === content.textureId("door2")));
  assert.ok(!recolours(content, doorLines).some(([s]) => s === content.textureId("wall")));

  const cogLines = block("quests/quest_horror/configs/quest_horror.loc", "horror_lighthouse_cog");
  const cog = buildLoc(content, cogLines);
  assert.deepEqual(cog.warnings, []);
  assert.equal(cog.faces, ["loc_4587", "loc_4587i2", "loc_4587i3"].reduce((n, m) => n + content.model(m).numFaces, 0));
  assert.equal(cog.seq, "horror_lighthouse_working");
  assert.ok(cog.frames.length > 1);
  assert.equal(cog.colours.length, cog.frames.length);
  assert.ok(cog.colours.some((c) => c.some((v, i) => v !== cog.colours[0][i])), "relit per frame");

  const wallLines = block("minigames/game_agilityarena/configs/agilityarena.loc", "agility_crumblywall2");
  const wall = buildLoc(content, wallLines);
  assert.equal(wall.parts.length, new Set(locModels(wallLines, (n) => content.hasModel(n)).map((p) => p.shape)).size);
  assert.ok(wall.parts.length > 1);
  assert.equal(wall.parts[0].label, "centrepiece");
});

test("idk: body and chathead", { skip: noContent }, () => {
  const content = new Content(CONTENT);
  const lines = block("player/configs/man.idk", "man_head_bald");
  const body = buildIdk(content, lines);
  assert.equal(body.view, "body");
  assert.equal(body.faces, content.model("man_head_bald").numFaces);
  const head = buildIdk(content, lines, { view: "head" });
  assert.equal(head.faces, content.model("chat_male_head_bald").numFaces);
});

test("spotanim: animated and resized", { skip: noContent }, () => {
  const content = new Content(CONTENT);
  const lines = block("_unpack/225/all.spotanim", "gunthix_claw");
  const s = buildSpotanim(content, lines);
  assert.deepEqual(s.warnings, []);
  assert.equal(s.seq, "gunthix_claw");
  assert.equal(s.frames.length, content.seq("gunthix_claw").frames.length);
  const full = buildSpotanim(content, lines.filter(([k]) => k !== "resizeh"));
  const width = (sc) => sc.bounds[3] - sc.bounds[0];
  assert.ok(width(s) < width(full), "resizeh=56 shrinks it");
});
