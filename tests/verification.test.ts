import { afterEach, expect, it, vi } from 'vitest';
import { shouldVerify } from '@/lib/verification';
afterEach(()=>vi.unstubAllEnvs());
it('is disabled by default and requires explicit consent',()=>{
  vi.stubEnv('ROUTEWISE_VERIFICATION_ENABLED',''); expect(shouldVerify('id',true)).toBe(false);
  vi.stubEnv('ROUTEWISE_VERIFICATION_ENABLED','1'); vi.stubEnv('ROUTEWISE_VERIFICATION_SAMPLE_RATE','1');
  expect(shouldVerify('id',false)).toBe(false); expect(shouldVerify('id',true)).toBe(true);
});
it('samples deterministically and rejects invalid rates',()=>{
  vi.stubEnv('ROUTEWISE_VERIFICATION_ENABLED','1'); vi.stubEnv('ROUTEWISE_VERIFICATION_SAMPLE_RATE','0.15');
  expect(shouldVerify('stable',true)).toBe(shouldVerify('stable',true));
  vi.stubEnv('ROUTEWISE_VERIFICATION_SAMPLE_RATE','NaN'); expect(shouldVerify('id',true)).toBe(false);
});
