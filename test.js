import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://wfwppoueaokxsgiipqee.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indmd3Bwb3VlYW9reHNnaWlwcWVlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTEyODU4MSwiZXhwIjoyMDkwNzA0NTgxfQ.-zcBzK5m5yoWrHw8y4a4mA01cgO0wAh9cJOtq7gw7S0'
)

async function test() {
  const { data, error } = await supabase
    .from('users')
    .insert({
      firebase_uid: 'local_test_uid',
      display_name: 'ローカルテスト'
    })
    .select()

  if (error) {
    console.error('❌ ERROR:', error)
  } else {
    console.log('✅ SUCCESS:', data)
  }
}

test()