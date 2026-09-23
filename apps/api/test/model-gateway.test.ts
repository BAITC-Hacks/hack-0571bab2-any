import assert from 'node:assert/strict';
import test from 'node:test';
import type { Product } from '../src/catalog.js';
import { createModelGateway } from '../src/modelGateway.js';

function modelResponse(output: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
    usage: { input_tokens: 30, output_tokens: 20 },
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

const candidate: Product = {
  id: '1', sku: 'SYN-1', name: 'Синтетический автомат', category: 'Автоматы',
  characteristics: { NOMINALNYY_TOK: '16 А', TORговая_Марка: 'Тест' },
  stock: { available: 4, status: 'in_stock' }, source: 'catalog_demo',
  certificateUrl: 'https://example.test/cert.pdf', price: { amount: '999', currency: 'KZT' },
};

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGMUSdnyn4GBgYEJRIAwACBIAi9YoxP3AAAAAElFTkSuQmCC', 'base64');

test('missing key returns a safe fallback and makes no request', async () => {
  let calls = 0;
  const gateway = createModelGateway({ fetchImpl: async () => { calls++; throw new Error('must not call'); } });
  assert.deepEqual(await gateway.answerWithCandidates({ message: 'Что это?', locale: 'ru', tier: 'light', candidates: [] }),
    { ok: false, reason: 'not_configured', text: null, referencedProductIds: [] });
  assert.equal(calls, 0);
});

test('light, balanced and deep requests use escalating models without sending secrets or unneeded fields', async () => {
  const bodies: Record<string, unknown>[] = [];
  const gateway = createModelGateway({ apiKey: 'synthetic-local-key', fetchImpl: async (_url, init) => {
    assert.equal(_url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return modelResponse({ text: 'Уточните нужное количество.', referenced_product_ids: ['1', 'invented'] });
  } });
  const input = { message: 'Нужен автомат для дома', locale: 'ru' as const, candidates: [candidate] };
  const light = await gateway.answerWithCandidates({ ...input, tier: 'light' });
  const balanced = await gateway.answerWithCandidates({ ...input, tier: 'balanced' });
  const deep = await gateway.answerWithCandidates({ ...input, tier: 'deep' });
  assert.equal(light.ok, true);
  assert.equal(balanced.ok, true);
  assert.equal(deep.ok, true);
  if (light.ok) {
    assert.equal(light.text, 'Уточните нужное количество.');
    assert.deepEqual(light.referencedProductIds, ['1']);
    assert.deepEqual(light.usage, { inputTokens: 30, outputTokens: 20 });
  }
  assert.equal(bodies[0]?.model, 'gpt-6-luna');
  assert.equal(bodies[1]?.model, 'gpt-6-sol');
  assert.equal(bodies[2]?.model, 'gpt-6-astra');
  assert.equal(bodies[0]?.store, false);
  assert.equal(bodies[0]?.background, false);
  assert.equal(bodies[0]?.max_output_tokens, 240);
  assert.equal(bodies[1]?.max_output_tokens, 500);
  assert.equal(bodies[2]?.max_output_tokens, 1_000);
  assert.deepEqual(bodies[2]?.reasoning, { effort: 'medium' });
  assert.equal('tools' in bodies[0]!, false);
  assert.equal('previous_response_id' in bodies[0]!, false);
  const serialized = JSON.stringify(bodies);
  assert.ok(serialized.includes('SYN-1'));
  assert.ok(!serialized.includes('cert.pdf'));
  assert.ok(!serialized.includes('999'));
  assert.ok(!serialized.includes('synthetic-local-key'));
});

test('photo observations are explicitly unverified and restricted to syntactically plausible clues', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const gateway = createModelGateway({ apiKey: 'synthetic-local-key', fetchImpl: async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return modelResponse({ skus: ['ABC-123', 'not a sku with spaces', 'ABC-123'], search_terms: ['автомат 16 А', 'щиток'] });
  } });
  const result = await gateway.analyzeImage({ buffer: tinyPng, mimeType: 'image/png', locale: 'kk' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.skus, ['ABC-123']);
    assert.deepEqual(result.searchTerms, ['автомат 16 А', 'щиток']);
  }
  assert.equal(requestBody?.model, 'gpt-6-sol');
  assert.equal(requestBody?.store, false);
  assert.equal(requestBody?.max_output_tokens, 240);
  assert.match(JSON.stringify(requestBody), /data:image\/png;base64,/u);
});

test('hard photo recognition uses Astra with supported reasoning effort', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const gateway = createModelGateway({ apiKey: 'synthetic-local-key', fetchImpl: async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return modelResponse({ skus: [], search_terms: [] });
  } });
  assert.equal((await gateway.analyzeImage({ buffer: tinyPng, mimeType: 'image/png', locale: 'ru',
    highAccuracy: true })).ok, true);
  assert.equal(requestBody?.model, 'gpt-6-astra');
  assert.deepEqual(requestBody?.reasoning, { effort: 'low' });
  assert.equal(requestBody?.max_output_tokens, 1_000);
});

test('invalid inputs and oversized output fail closed without exposing upstream messages', async () => {
  let calls = 0;
  const gateway = createModelGateway({ apiKey: 'synthetic-local-key', fetchImpl: async () => {
    calls++;
    return new Response('x'.repeat(30_000), { status: 200 });
  } });
  const invalidImage = await gateway.analyzeImage({ buffer: Buffer.from('not an image'), mimeType: 'image/png', locale: 'ru' });
  assert.deepEqual(invalidImage, { ok: false, reason: 'invalid_input', skus: [], searchTerms: [] });
  const invalidText = await gateway.answerWithCandidates({ message: 'x'.repeat(1201), locale: 'ru', tier: 'deep', candidates: [] });
  assert.equal(invalidText.ok, false);
  assert.equal(calls, 0);
  const badOutput = await gateway.answerWithCandidates({ message: 'Спросить', locale: 'ru', tier: 'light', candidates: [] });
  assert.deepEqual(badOutput, { ok: false, reason: 'invalid_response', text: null, referencedProductIds: [] });
  assert.equal(calls, 1);
});

test('429 and refused responses produce no customer-facing model text', async () => {
  const rateLimited = createModelGateway({ apiKey: 'synthetic-local-key', fetchImpl: async () => new Response('do not show', { status: 429 }) });
  const input = { message: 'Привет', locale: 'ru' as const, tier: 'light' as const, candidates: [] };
  assert.deepEqual(await rateLimited.answerWithCandidates(input),
    { ok: false, reason: 'rate_limited', text: null, referencedProductIds: [] });

  const refused = createModelGateway({ apiKey: 'synthetic-local-key', fetchImpl: async () => new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }],
  })) });
  assert.deepEqual(await refused.answerWithCandidates(input),
    { ok: false, reason: 'refused', text: null, referencedProductIds: [] });
});

test('concurrent model requests are capped instead of building an unbounded queue', async () => {
  const releases: Array<() => void> = [];
  const gateway = createModelGateway({ apiKey: 'synthetic-local-key', fetchImpl: async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return modelResponse({ text: 'Уточните артикул.', referenced_product_ids: [] });
  } });
  const input = { message: 'Привет', locale: 'ru' as const, tier: 'light' as const, candidates: [] };
  const first = gateway.answerWithCandidates(input);
  const second = gateway.answerWithCandidates(input);
  const third = await gateway.answerWithCandidates(input);
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.reason, 'busy');
  releases.forEach((release) => release());
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});
