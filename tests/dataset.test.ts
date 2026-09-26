import { expect, it } from 'vitest';
import data from '@/eval/datasets/starter-v1.json';
import { validateDataset } from '@/eval/schema';
it('validates starter cases without inventing human review', () => {
  const dataset = validateDataset(data); expect(dataset.cases.length).toBe(12);
  expect(dataset.cases.every(c => !c.reviewed)).toBe(true);
});
it('requires review provenance and unique IDs', () => {
  expect(() => validateDataset({ ...data, cases: [{ ...data.cases[0], reviewed: true }] })).toThrow('provenance');
  expect(() => validateDataset({ ...data, cases: [data.cases[0], data.cases[0]] })).toThrow();
});
