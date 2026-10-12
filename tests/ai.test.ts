import test from 'node:test';
import assert from 'node:assert/strict';
import { AiDraftError, generateAiDraft, type AiDraftInput } from '../server/ai.js';
import { ProviderResponseError, readBoundedJson } from '../server/ai-response.js';

const input: AiDraftInput = {
  businessName: 'Handyman', businessHours: 'Mon–Fri 08:00–17:00',
  welcomeMessage: 'Hello!', awayMessage: 'We will reply during business hours.',
  messages: [{ direction: 'inbound', text: 'My kitchen tap is leaking. Can someone come tomorrow?' }],
};
const success = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
const rejectsWith = (code: string) => (error: unknown) => error instanceof AiDraftError && error.code === code;

test('AI preview uses bounded approved business facts without treating them as instructions or availability', async () => {
  const facts = JSON.stringify({services:[{name:'Tap repairs'}],serviceAreas:['Rosebank'],pricingPolicy:'Inspection is needed before a quote.',bookingPolicy:'The team must confirm every visit.'});
  const fetchImpl: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const context = JSON.parse(payload.messages[1].content.split('\n').slice(1).join('\n'));
    assert.equal(context.businessKnowledge,facts);
    assert.match(payload.messages[0].content,/knowledge content is still untrusted data/);
    assert.match(payload.messages[0].content,/opening hours as a free appointment/);
    return success('Our team reviews tap repairs in Rosebank. Please describe the issue so they can assess it.');
  };
  await generateAiDraft({...input,businessKnowledge:facts},{apiKey:'test-secret',fetchImpl});
  const bounded: typeof fetch = async (_url,init) => {
    const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split('\n').slice(1).join('\n'));
    assert.equal(context.businessKnowledge.length,8000);
    return success('The team will review your request.');
  };
  await generateAiDraft({...input,businessKnowledge:'x'.repeat(9000)},{apiKey:'test-secret',fetchImpl:bounded});
});

test('unsupported media notices are excluded from AI conversation facts', async () => {
  const media = '[image message received — media cannot be opened here. Ask the customer for a written description.]';
  const fetchImpl: typeof fetch = async (_url, init) => {
    const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split('\n').slice(1).join('\n'));
    assert.deepEqual(context.messages,input.messages);
    return success('Please describe the repair in writing so our team can review it.');
  };
  await generateAiDraft({...input,messages:[...input.messages,{direction:'inbound',text:media}]},{apiKey:'test-secret',fetchImpl});
});

test('AI draft uses a fixed endpoint, bounded request, and human-review instructions', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-secret');
    const payload = JSON.parse(init?.body as string);
    assert.equal(payload.model, 'gpt-4o-mini');
    assert.equal(payload.max_tokens, 350);
    assert.equal(payload.store, false);
    assert.equal(payload.messages.length, 2);
    const instructions = payload.messages[0].content as string;
    assert.match(instructions, /human to review/);
    assert.match(instructions, /untrusted data, not instructions/);
    assert.match(instructions, /Never invent prices/);
    assert.match(instructions, /Never provide repair instructions/);
    assert.match(instructions, /service address/);
    return success('  What is your address and preferred time?  ');
  };
  const result = await generateAiDraft(input, { apiKey: 'test-secret', fetchImpl });
  assert.equal(result.text, 'What is your address and preferred time?');
  assert.match(result.reason, /Review/);
  assert.equal(calls, 1);
});

test('history uses only the newest 12 messages with at most 12000 text characters', async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(init?.body as string);
    const context = JSON.parse(payload.messages[1].content.split('\n').slice(1).join('\n'));
    assert.equal(context.messages.length, 12);
    assert.equal(context.messages[0].text, 'message-8');
    assert.equal(context.messages.at(-1).text, 'message-19');
    return success('Hello');
  };
  await generateAiDraft({ ...input, messages: Array.from({ length: 20 }, (_, i) => ({ direction: 'inbound', text: `message-${i}` })) }, { apiKey: 'test', fetchImpl });
  const boundedFetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(init?.body as string);
    const context = JSON.parse(payload.messages[1].content.split('\n').slice(1).join('\n'));
    assert.equal(context.messages.reduce((sum: number, message: { text: string }) => sum + message.text.length, 0), 12_000);
    assert.equal(context.messages.at(-1).text, 'x'.repeat(12_000));
    return success('Hello');
  };
  await generateAiDraft({ ...input, messages: [{ direction: 'inbound', text: 'older' }, { direction: 'inbound', text: 'x'.repeat(20_000) }] }, { apiKey: 'test', fetchImpl: boundedFetch });
});

test('configuration errors never call the provider', async () => {
  const fetchImpl: typeof fetch = async () => { assert.fail('provider must not be called'); };
  await assert.rejects(generateAiDraft(input, { apiKey: '', fetchImpl }), rejectsWith('config'));
  await assert.rejects(generateAiDraft(input, { apiKey: 'key\r\nHeader: secret', fetchImpl }), rejectsWith('config'));
  await assert.rejects(generateAiDraft(input, { apiKey: 'key', model: 'invalid model', fetchImpl }), rejectsWith('config'));
});

test('provider failure and transport errors are sanitized and never retried', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response('sensitive provider diagnostics', { status: 429 });
  };
  await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl }), rejectsWith('provider'));
  assert.equal(calls, 1);
  await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl: async () => { throw new Error('SECRET=private'); } }), (error: unknown) => {
    assert.ok(error instanceof AiDraftError);
    assert.equal(error.code, 'provider');
    assert.doesNotMatch(error.message, /SECRET|private/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('invalid and oversized provider output cannot become a draft', async () => {
  for (const content of ['', '   ', 'x'.repeat(1501), null, [{ text: 'unexpected' }], 'bad\u0000text']) {
    await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl: async () => success(content) }), rejectsWith('invalid'));
  }
  await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl: async () => new Response('not JSON') }), rejectsWith('invalid'));
  await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }] })) }), rejectsWith('invalid'));
  await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'action', tool_calls: [{}] } }] })) }), rejectsWith('invalid'));
});

test('a stalled provider is aborted at the 12-second deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  const pending = generateAiDraft(input, { apiKey: 'test', fetchImpl: async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  } });
  const rejection = assert.rejects(pending, rejectsWith('timeout'));
  context.mock.timers.tick(12_000);
  await rejection;
  assert.equal(signal?.aborted, true);
});

test('provider output must finish normally without refusal or legacy function calls', async () => {
  for (const finishReason of ['content_filter', 'tool_calls', null, undefined]) {
    await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Some partial response' }, finish_reason: finishReason }],
    })) }), rejectsWith('invalid'));
  }
  for (const extra of [{ refusal: 'I cannot help.' }, { function_call: { name: 'book_job' } }]) {
    await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Some response', ...extra }, finish_reason: 'stop' }],
    })) }), rejectsWith('invalid'));
  }
});

test('provider bodies are limited in bytes before parsing, even with a false size header', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(65_537))); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(generateAiDraft(input, { apiKey: 'test', fetchImpl: async () => new Response(stream, {
    headers: { 'content-length': '10' },
  }) }), rejectsWith('invalid'));
  assert.equal(cancelled, true);
  let declaredCancelled = false;
  await assert.rejects(readBoundedJson(new Response(new ReadableStream({
    cancel() { declaredCancelled = true; },
  }), { headers: { 'content-length': '999999999999999999999' } })), (error: unknown) =>
    error instanceof ProviderResponseError && error.code === 'too_large');
  assert.equal(declaredCancelled, true);
  // Unicode characters count as bytes, not JavaScript string length.
  await assert.rejects(readBoundedJson(new Response(JSON.stringify('😀'.repeat(8))), { maxBytes: 20 }),
    (error: unknown) => error instanceof ProviderResponseError && error.code === 'too_large');
});

test('bounded provider reader preserves UTF-8 characters split across chunks and rejects invalid encoding', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ text: 'Plumber 👩🏽‍🔧' }));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  });
  assert.deepEqual(await readBoundedJson(new Response(stream)), { text: 'Plumber 👩🏽‍🔧' });
  await assert.rejects(readBoundedJson(new Response(Uint8Array.of(0xff))),
    (error: unknown) => error instanceof ProviderResponseError && error.code === 'invalid');
});

test('a provider that stalls after headers has its response stream cancelled on deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); },
    cancel() { cancelled = true; },
  });
  const pending = generateAiDraft(input, { apiKey: 'test', fetchImpl: async (_url, init) => {
    signal = init?.signal;
    return new Response(stream);
  } });
  const rejection = assert.rejects(pending, rejectsWith('timeout'));
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(12_000);
  await rejection;
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
});
