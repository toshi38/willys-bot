import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseSek } from "./client.ts";

test("amounts are read as willys.se writes them", () => {
  assert.equal(parseSek("1 412,15 kr"), 1412.15);
  assert.equal(parseSek("1 554,97 kr"), 1554.97);
  assert.equal(parseSek("−31,79 kr"), -31.79);
  assert.equal(parseSek("59,90"), 59.9);
  assert.equal(parseSek("12 kr/st"), 12);
  assert.equal(parseSek(""), null);
  assert.equal(parseSek(undefined), null);
});
