// Configuração pública do Supabase.
//
// PODE ficar no repositório: a URL do projeto e a chave "anon" (ou "publishable").
// A proteção dos dados é feita pelo Row Level Security no banco, não por esconder esta chave.
//
// NUNCA coloque aqui: a chave "service_role" / "secret", a senha do banco, nem a connection string.
// O app se recusa a iniciar se detectar uma chave secreta.

export const SUPABASE_URL = 'https://klexiqohiwxsmzpabqkq.supabase.co';
export const SUPABASE_ANON_KEY = 'COLE-AQUI-A-CHAVE-ANON-OU-PUBLISHABLE';
