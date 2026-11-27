// Edge Function do WhatsApp. Publicar com: supabase functions deploy whatsapp --no-verify-jwt
// (a Meta não manda JWT: a porta de entrada é a assinatura X-Hub-Signature-256, validada em bot.js).
// Toda a lógica está em bot.js (testada com node --test).
import { chaveDoSupabase, criarHandler, enviarWhatsApp, restSupabase } from './bot.js';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const nomes = ['WHATSAPP_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'GRAPH_API_VERSION'];
const env = Object.fromEntries(nomes.map((k) => [k, Deno.env.get(k) ?? '']));

Deno.serve(criarHandler({
  env,
  // Injetadas pelo próprio Supabase: SUPABASE_URL e SUPABASE_SECRET_KEYS (chave nova sb_secret_)
  // ou SUPABASE_SERVICE_ROLE_KEY (JWT legado). Não defina nenhuma delas à mão.
  rest: restSupabase(Deno.env.get('SUPABASE_URL') ?? '',
    chaveDoSupabase(Deno.env.get('SUPABASE_SECRET_KEYS'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))),
  enviar: enviarWhatsApp(env),
  agora: () => new Date(),
  emSegundoPlano: (p) => EdgeRuntime.waitUntil(p),
}));
