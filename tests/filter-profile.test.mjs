import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JSDOM } from "jsdom";

for (const page of ["../index.html", "../web/index.html"]) test(`${page}: filtering keeps profile in sync`, () => {
  const source = readFileSync(new URL(page, import.meta.url), "utf8");
  const start = source.indexOf("const currentGroupFilter =");
  const end = source.indexOf("// ---------- 图表工具 ----------", start);
  assert.ok(start >= 0 && end > start);
  const dom = new JSDOM(`<select id="group-filter"><option value="__all__">全部分组</option><option value="公司">公司</option></select><select id="tag-filter"><option value="__all__">全部标签</option><option value="科技">科技</option></select><select id="channel"><option value="youtube:mkbhd">MKBHD</option><option value="youtube:game">[YT] 矩阵游戏1</option></select>`);
  const selected = dom.window.document.getElementById("channel");
  const rendered = [];
  const context = {
    document: dom.window.document,
    Option: dom.window.Option,
    $: (id) => dom.window.document.getElementById(id),
    channelKeys: ["youtube:mkbhd", "youtube:game"],
    channels: {
      "youtube:mkbhd": { platform: "youtube", handle: "mkbhd", info: { name: "MKBHD", group: "科技", tags: ["科技"] } },
      "youtube:game": { platform: "youtube", handle: "game", info: { alias: "矩阵游戏1", group: "公司", tags: [] } },
    },
    authAllows: () => true,
    currentKey: "youtube:mkbhd",
    renderChannel: (key) => { rendered.push(key); context.currentKey = key; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  selected.value = "youtube:mkbhd";
  dom.window.document.getElementById("group-filter").value = "公司";
  dom.window.document.getElementById("group-filter").onchange();
  assert.equal(selected.value, "youtube:game");
  assert.deepEqual(rendered, ["youtube:game"]);
  rendered.length = 0;
  dom.window.document.getElementById("tag-filter").onchange();
  assert.deepEqual(rendered, []);
  dom.window.document.getElementById("group-filter").value = "__all__";
  dom.window.document.getElementById("tag-filter").value = "科技";
  dom.window.document.getElementById("tag-filter").onchange();
  assert.equal(selected.value, "youtube:mkbhd");
  assert.deepEqual(rendered, ["youtube:mkbhd"]);
});
