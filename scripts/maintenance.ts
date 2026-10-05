import { supabaseAdmin } from '../lib/supabase';
async function main() {
  if(process.env.ROUTEWISE_MAINTENANCE!=='1') throw new Error('Set ROUTEWISE_MAINTENANCE=1 to apply documented retention');
  const {error}=await supabaseAdmin.rpc('maintain_retention');if(error)throw new Error('Retention maintenance failed');console.log('Retention maintenance completed');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
