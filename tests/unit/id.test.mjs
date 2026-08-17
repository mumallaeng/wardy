import assert from "node:assert/strict";
import test from "node:test";

import { randomUuid } from "../../apps/js/id.ts";

test("randomUuid uses the browser native implementation when available", () => {
  const expected = "11111111-2222-4333-8444-555555555555";
  const cryptoApi = {
    randomUUID: () => expected,
    getRandomValues: () => { throw new Error("fallback should not run"); },
  };

  assert.equal(randomUuid(cryptoApi), expected);
});

test("randomUuid falls back to RFC 4122 v4 bytes on insecure LAN origins", () => {
  const source = Uint8Array.from({ length: 16 }, (_, index) => index);
  const cryptoApi = {
    getRandomValues(target) {
      target.set(source);
      return target;
    },
  };

  assert.equal(randomUuid(cryptoApi), "00010203-0405-4607-8809-0a0b0c0d0e0f");
});
