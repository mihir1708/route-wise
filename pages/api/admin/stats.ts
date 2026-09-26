import type { NextApiRequest, NextApiResponse } from 'next';
import { protect } from '@/lib/access';
import { supabaseAdmin } from '@/lib/supabase';
import { getCurrentMonthUsage } from '@/lib/budget-tracker';
export default async function handler(req:NextApiRequest,res:NextApiResponse) {
  if(!protect(req,res,'admin')) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  try {
    const now=new Date(); const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
    const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
    const budget=await getCurrentMonthUsage();
    const {data,error}=await supabaseAdmin.rpc('request_stats',{p_start:start.toISOString(),p_end:end.toISOString()});
    if(error || !data) throw new Error('Stats unavailable');
    return res.status(200).json({...data,window_start:start.toISOString(),window_end:end.toISOString(),
      budget_limit:budget.budget_limit,accounted_spend:budget.total_cost,budget_remaining:Math.max(0,budget.budget_limit-budget.total_cost)});
  } catch { return res.status(503).json({error:'Statistics unavailable'}); }
}
