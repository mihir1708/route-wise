import { beforeEach,expect,it,vi } from 'vitest';
import type { NextApiRequest,NextApiResponse } from 'next';
const mocks=vi.hoisted(()=>({protect:vi.fn(),rpc:vi.fn(),getCurrentMonthUsage:vi.fn()}));
vi.mock('@/lib/access',()=>({protect:mocks.protect}));
vi.mock('@/lib/supabase',()=>({supabaseAdmin:{rpc:mocks.rpc}}));
vi.mock('@/lib/budget-tracker',()=>({getCurrentMonthUsage:mocks.getCurrentMonthUsage}));
import handler from '@/pages/api/admin/stats';
beforeEach(()=>{vi.clearAllMocks();mocks.protect.mockReturnValue(true);mocks.getCurrentMonthUsage.mockResolvedValue({budget_limit:250,total_cost:0.123456});mocks.rpc.mockResolvedValue({data:{total_requests:1},error:null});});
it('uses bounded SQL aggregates and the actual configured budget',async()=>{
 const res={status:vi.fn().mockReturnThis(),json:vi.fn()} as unknown as NextApiResponse;
 await handler({method:'GET'} as NextApiRequest,res);
 expect(mocks.rpc).toHaveBeenCalledWith('request_stats',expect.objectContaining({p_start:expect.stringMatching(/T00:00:00.000Z$/)}));
 expect(res.json).toHaveBeenCalledWith(expect.objectContaining({budget_limit:250,accounted_spend:0.123456}));
});
it('does not access data when authorization fails',async()=>{
 mocks.protect.mockReturnValue(false);await handler({method:'GET'} as NextApiRequest,{} as NextApiResponse);expect(mocks.rpc).not.toHaveBeenCalled();
});
