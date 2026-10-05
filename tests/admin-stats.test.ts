import { beforeEach,expect,it,vi } from 'vitest';
import type { NextApiRequest,NextApiResponse } from 'next';
const mocks=vi.hoisted(()=>({protect:vi.fn(),rpc:vi.fn(),getCurrentMonthUsage:vi.fn(),getTenantAdmission:vi.fn()}));
vi.mock('@/lib/access',()=>({protect:mocks.protect}));
vi.mock('@/lib/supabase',()=>({supabaseAdmin:{rpc:mocks.rpc}}));
vi.mock('@/lib/budget-tracker',()=>({getCurrentMonthUsage:mocks.getCurrentMonthUsage,getTenantAdmission:mocks.getTenantAdmission,getCurrentMonth:()=>'2026-10'}));
import handler from '@/pages/api/admin/stats';
import { dashboardRates,dashboardWindow } from '@/lib/dashboard';
const TENANT='00000000-0000-4000-8000-0000000000e1';
const response=()=>({status:vi.fn().mockReturnThis(),json:vi.fn()}) as unknown as NextApiResponse & {status:ReturnType<typeof vi.fn>;json:ReturnType<typeof vi.fn>};
beforeEach(()=>{
 vi.clearAllMocks();mocks.protect.mockReturnValue(true);
 mocks.getCurrentMonthUsage.mockResolvedValue({budget_limit:250,total_cost:0.123456});
 mocks.getTenantAdmission.mockResolvedValue({tenantSpent:0.4,tenantBudget:1,globalSpent:2,globalLimit:250});
 mocks.rpc.mockResolvedValue({data:{tenants:[{id:TENANT,name:'demo'}],summary:{requests:1}},error:null});
});
it('covers whole UTC days ending today',()=>{
 const {start,end}=dashboardWindow(7,new Date('2026-10-05T16:30:00Z'));
 expect(start.toISOString()).toBe('2026-09-29T00:00:00.000Z');expect(end.toISOString()).toBe('2026-10-06T00:00:00.000Z');
});
it('divides each rate by the requests it can apply to',()=>{
 const r=dashboardRates({requests:40,succeeded:30,cost_usd:0.6,provider_requests:20,cache_hits:10,fallbacks:2,escalations:1,rate_limited:4,
  budget_rejected:0,unsettled:0,unknown_usage:0,p50_ms:1,p95_ms:2});
 expect(r).toEqual({success:0.75,cacheHit:0.25,fallback:0.1,escalation:0.05,rateLimited:0.1,costPerSuccess:0.02});
 expect(dashboardRates({requests:0,succeeded:0,cost_usd:0,provider_requests:0,cache_hits:0,fallbacks:0,escalations:0,rate_limited:0,
  budget_rejected:0,unsettled:0,unknown_usage:0,p50_ms:null,p95_ms:null}).fallback).toBeNull();
});
it('reads SQL aggregates for the window and the global budget',async()=>{
 const res=response();
 await handler({method:'GET',query:{}} as unknown as NextApiRequest,res);
 expect(mocks.rpc).toHaveBeenCalledWith('gateway_dashboard',expect.objectContaining({p_start:expect.stringMatching(/T00:00:00.000Z$/),p_tenant:null}));
 expect(res.json).toHaveBeenCalledWith(expect.objectContaining({days:7,budget:{scope:'global',month:'2026-10',limit:250,spent:0.123456}}));
});
it('filters by tenant and shows that tenant budget',async()=>{
 const res=response();
 await handler({method:'GET',query:{days:'30',tenant:TENANT}} as unknown as NextApiRequest,res);
 expect(mocks.rpc).toHaveBeenCalledWith('gateway_dashboard',expect.objectContaining({p_tenant:TENANT}));
 expect(mocks.getTenantAdmission).toHaveBeenCalledWith(TENANT);
 expect(res.json).toHaveBeenCalledWith(expect.objectContaining({days:30,tenant:TENANT,budget:{scope:'tenant',month:'2026-10',limit:1,spent:0.4}}));
});
it('rejects bad ranges, malformed and unknown tenants',async()=>{
 for (const query of [{days:'90'},{tenant:'x; drop'}]) {
  const res=response();await handler({method:'GET',query} as unknown as NextApiRequest,res);expect(res.status).toHaveBeenCalledWith(400);
 }
 expect(mocks.rpc).not.toHaveBeenCalled();
 const res=response();
 await handler({method:'GET',query:{tenant:'00000000-0000-4000-8000-0000000000ff'}} as unknown as NextApiRequest,res);
 expect(res.status).toHaveBeenCalledWith(404);
});
it('does not access data when authorization fails',async()=>{
 mocks.protect.mockReturnValue(false);await handler({method:'GET',query:{}} as NextApiRequest,{} as NextApiResponse);expect(mocks.rpc).not.toHaveBeenCalled();
});
