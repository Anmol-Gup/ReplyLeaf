import { test } from "node:test";
import assert from "node:assert/strict";
import { leadDetailsSchema, parseRequirementLines, requirementLines } from "../lib/leads";

test("requirement lines: 'name: value' pairs; junk lines, empty sides and repeated names are skipped; capped", () => {
  assert.deepEqual(parseRequirementLines("platform: Shopify\n  payments :  card, UPI \nno colon here\n: no key\nkey only:\nPlatform: again"),
    [{ key: "platform", value: "Shopify" }, { key: "payments", value: "card, UPI" }]);
  assert.deepEqual(parseRequirementLines("url: https://x.test/a:b"), [{ key: "url", value: "https://x.test/a:b" }]); // only the first colon splits
  assert.equal(parseRequirementLines(Array.from({ length: 40 }, (_, i) => `k${i}: v`).join("\n")).length, 15);
  assert.equal(parseRequirementLines("a".repeat(200) + ": " + "b".repeat(500))[0].key.length, 60);
  assert.deepEqual(parseRequirementLines(""), []);
});

test("requirements round trip through the textarea", () => {
  const rows = [{ requirement_key: "platform", requirement_value: "Shopify" }, { requirement_key: "pages", requirement_value: "5" }];
  assert.deepEqual(parseRequirementLines(requirementLines(rows)), [{ key: "platform", value: "Shopify" }, { key: "pages", value: "5" }]);
});

test("lead details form: service and a real description are required, the rest is optional and trimmed", () => {
  const ok = leadDetailsSchema.safeParse({ id: "11111111-1111-4111-8111-111111111111", customer_name: "  Priya ", project_type: " Website ", description: " A single page portfolio ", budget: "", timeline: " 2 weeks ", requirements: "" });
  assert.equal(ok.success, true);
  if (ok.success) assert.deepEqual([ok.data.customer_name, ok.data.project_type, ok.data.description, ok.data.timeline], ["Priya", "Website", "A single page portfolio", "2 weeks"]);
  const base = { id: "11111111-1111-4111-8111-111111111111", customer_name: "", project_type: "Website", description: "A portfolio site", budget: "", timeline: "", requirements: "" };
  assert.equal(leadDetailsSchema.safeParse({ ...base, project_type: "   " }).success, false);
  assert.equal(leadDetailsSchema.safeParse({ ...base, description: "x" }).success, false);
  assert.equal(leadDetailsSchema.safeParse({ ...base, id: "not-a-uuid" }).success, false);
  assert.equal(leadDetailsSchema.safeParse({ ...base, budget: "x".repeat(101) }).success, false);
});
