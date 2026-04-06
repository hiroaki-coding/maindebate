import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../types';

export function getSupabaseClient(env: Env): SupabaseClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;
  
  if (!url || !key) {
    throw new Error('Supabase credentials not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY in .dev.vars');
  }
  
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
