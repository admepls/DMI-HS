import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("portal assets link uses the current archive with one unambiguous href", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const link = html.match(/<a\b[^>]*>\s*Download assets\b/);
  assert.ok(link, "Portal assets link must exist");
  assert.equal((link[0].match(/\bhref\s*=/g) || []).length, 1);
  assert.ok(link[0].includes(
    'href="https://drive.google.com/file/d/1Cmf5eVVq14_sZ7eevV1roYvO_HcTo3D0/view?usp=sharing"'
  ));
  assert.ok(link[0].includes('rel="noopener noreferrer"'));
});
