import { expect, it } from 'vitest';
import { getPrompt, promptId, PROMPTS, TASK_TYPES } from '@/prompts';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/model-client';

it('every task type has a template and every id is unique', () => {
  for (const task of TASK_TYPES) expect(getPrompt(task)).not.toBeNull();
  const ids = PROMPTS.map(promptId); expect(new Set(ids).size).toBe(ids.length);
  for (const p of PROMPTS) expect(p.version).toMatch(/^v\d+$/);
});

it('system prompts are a fixed prefix: the input only ever appears in the user message', () => {
  for (const p of PROMPTS) {
    const user = p.render('UNIQUE-INPUT-MARKER');
    expect(user).toContain('UNIQUE-INPUT-MARKER'); expect(p.system).not.toContain('UNIQUE-INPUT-MARKER');
    expect(p.maxOutputTokens).toBeGreaterThan(0);
  }
});

it('resolves requested versions and rejects ones from another task', () => {
  expect(getPrompt('classify', 'classify@v1')?.output).toBe('json');
  expect(getPrompt('classify', 'summarize@v1')).toBeNull(); expect(getPrompt('classify', 'classify@v9')).toBeNull();
});

it('chat keeps the original RouteWise prompt and passes input through unchanged', () => {
  const chat = getPrompt('chat')!;
  expect(chat.system).toBe(DEFAULT_SYSTEM_PROMPT); expect(chat.render('hello?')).toBe('hello?'); expect(chat.maxOutputTokens).toBe(1000);
});
