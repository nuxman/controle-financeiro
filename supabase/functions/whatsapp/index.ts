// Edge Function do WhatsApp. Publicar com: supabase functions deploy whatsapp --no-verify-jwt
// (a Meta não manda JWT: a porta de entrada é a assinatura X-Hub-Signature-256, validada em bot.js).
// Toda a lógica está em bot.js (testada com node --test).
import { criarHandler, enviarWhatsApp, restSupabase } from './bot.js';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const nomes = ['WHATSAPP_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'GRAPH_API_VERSION'];
const env = Object.fromEntries(nomes.map((k) => [k, Deno.env.get(k) ?? '']));

Deno.serve(criarHandler({
  env,
  // SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetadas pelo próprio Supabase.
  rest: restSupabase(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''),
  enviar: enviarWhatsApp(env),
  agora: () => new Date(),
  emSegundoPlano: (p) => EdgeRuntime.waitUntil(p),
}));
