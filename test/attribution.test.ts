import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, keccak256 } from "viem";
import { startTrace, withFill, withOrder } from "../src/sdk/strategies/index.ts";

const CORE = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const QUOTE = `0x${"33".repeat(32)}` as const;
const ORDER = `0x${"44".repeat(32)}` as const;
const FILL = `0x${"55".repeat(32)}` as const;

const input = {
  chainId: 1,
  core: CORE,
  account: ACCOUNT,
  strategyId: "lendQuote",
  quoteId: QUOTE,
  nonce: 7n,
} as const;

test("startTrace deterministically binds every attribution field", () => {
  const expected = keccak256(encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "string" },
      { type: "bytes32" },
      { type: "uint256" },
    ],
    [1n, CORE, ACCOUNT, "lendQuote", QUOTE, 7n],
  ));

  assert.deepEqual(startTrace(input), {
    strategyId: "lendQuote",
    account: ACCOUNT,
    quoteId: QUOTE,
    intentId: expected,
  });
  assert.equal(startTrace(input).intentId, expected);

  const alternatives = [
    { ...input, chainId: 2 },
    { ...input, core: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const },
    { ...input, account: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const },
    { ...input, strategyId: "borrowQuote" },
    { ...input, quoteId: `0x${"cc".repeat(32)}` as const },
    { ...input, nonce: 8n },
  ];
  for (const alternative of alternatives) {
    assert.notEqual(startTrace(alternative).intentId, expected);
  }
});

test("trace links strategy through fill without changing or mutating prior identifiers", () => {
  const intent = startTrace(input);
  const intentSnapshot = { ...intent };
  const ordered = withOrder(intent, ORDER);
  const orderedSnapshot = { ...ordered };
  const filled = withFill(ordered, FILL);

  assert.notEqual(ordered, intent);
  assert.notEqual(filled, ordered);
  assert.deepEqual(intent, intentSnapshot);
  assert.deepEqual(ordered, orderedSnapshot);
  assert.deepEqual(filled, {
    strategyId: "lendQuote",
    account: ACCOUNT,
    quoteId: QUOTE,
    intentId: intent.intentId,
    orderId: ORDER,
    fillId: FILL,
  });
  assert.throws(() => withFill(intent, FILL), /orderId is required/);
});

test("startTrace rejects invalid attribution inputs", () => {
  for (const chainId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0n, -1n]) {
    assert.throws(() => startTrace({ ...input, chainId }), /chainId.*positive integer/i);
  }
  for (const nonce of [-1n, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => startTrace({ ...input, nonce }), /nonce.*non-negative integer/i);
  }
  assert.throws(() => startTrace({ ...input, core: "0x1234" as never }), /core.*address/i);
  assert.throws(() => startTrace({ ...input, account: "0x1234" as never }), /account.*address/i);
  assert.throws(() => startTrace({ ...input, strategyId: "" }), /strategyId.*nonempty/i);
  assert.throws(() => startTrace({ ...input, quoteId: "0x1234" as never }), /quoteId.*bytes32/i);
});

test("trace builders reject invalid execution identifiers", () => {
  const intent = startTrace(input);
  assert.throws(() => withOrder(intent, "0x1234" as never), /orderId.*bytes32/i);
  const ordered = withOrder(intent, ORDER);
  assert.throws(() => withFill(ordered, "0x1234" as never), /fillId.*bytes32/i);
});
