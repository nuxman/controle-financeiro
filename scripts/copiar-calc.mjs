// Copia js/calc.js para a Edge Function (o deploy do Supabase só empacota o que está em supabase/functions).
// Rode depois de mexer em js/calc.js: npm run copiar-calc. O teste tests/whatsapp.test.mjs falha se as duas cópias divergirem.
import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../js/calc.js', import.meta.url), new URL('../supabase/functions/_shared/calc.js', import.meta.url));
console.log('js/calc.js → supabase/functions/_shared/calc.js');
