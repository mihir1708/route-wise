import { expect, it } from 'vitest';
import { validateJsonOutput } from '@/lib/output-validation';
import { getPrompt } from '@/prompts';

const classify = getPrompt('classify')!.schema!;
const extract = getPrompt('extract')!.schema!;

it('accepts valid JSON, with or without a Markdown fence', () => {
  expect(validateJsonOutput('{"category":"billing","urgency":"high"}', classify)).toEqual({ ok: true, value: { category: 'billing', urgency: 'high' } });
  expect(validateJsonOutput('```json\n{"category":"other","urgency":"low"}\n```', classify).ok).toBe(true);
  expect(validateJsonOutput('{"order_id":"A1","product":null,"customer_email":null,"requested_action":"refund"}', extract).ok).toBe(true);
});

it.each([
  ['Sure! Here is the JSON', 'not valid JSON'],
  ['[]', 'root must be an object'],
  ['{"category":"billing"}', 'urgency is required'],
  ['{"category":"refunds","urgency":"low"}', 'category must be one of billing, technical, account, shipping, other'],
  ['{"category":"billing","urgency":"low","confidence":0.9}', 'confidence is not allowed'],
])('rejects %s', (text, error) => {
  expect(validateJsonOutput(text, classify)).toEqual({ ok: false, error });
});

it('enforces nullable string fields', () => {
  expect(validateJsonOutput('{"order_id":42,"product":null,"customer_email":null,"requested_action":null}', extract))
    .toEqual({ ok: false, error: 'order_id must be string or null' });
});

it('every JSON prompt declares a schema', () => {
  for (const task of ['classify', 'extract'] as const) expect(getPrompt(task)!.schema).toBeDefined();
});
