-- Rode no SQL Editor depois do schema.sql, do 002_evolucao.sql e (se usar o WhatsApp) do 003_whatsapp.sql.
select c.relname as tabela,
       c.relrowsecurity as rls,
       c.relforcerowsecurity as rls_forcado,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
       has_table_privilege('anon', c.oid, 'select') as anon_pode_ler,
       exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'trava_dono') as trava_dono
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;
-- Esperado em TODAS as linhas: rls = true, rls_forcado = true, policies = 1 (0 nas whatsapp_*, veja abaixo), anon_pode_ler = false, trava_dono = true.
-- Tabelas esperadas: compromissos, config, contas, importacoes, lancamentos, limites, parcelas, receitas (+ whatsapp_mensagens e whatsapp_vinculos depois do 003).

-- A migração 002 foi aplicada? (deve listar 4 linhas)
select table_name, column_name from information_schema.columns
where table_schema = 'public' and column_name = 'importacao_id' order by 1;

-- Contas em moeda estrangeira (002): as 4 colunas e as regras devem existir.
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'contas'
     and column_name in ('moeda', 'quantidade', 'cotacao', 'cotacao_em')) as colunas_moeda_esperado_4,
  (select count(*) from pg_constraint where conrelid = 'public.contas'::regclass
     and conname in ('contas_moeda_check', 'contas_quantidade_check', 'contas_cotacao_check', 'contas_estrangeira_check')) as regras_moeda_esperado_4;

-- WhatsApp (003): as duas tabelas aparecem na 1ª consulta com policies = 0 (de propósito: só a Edge Function,
-- com a service role, acessa). Elas devem ter rls = true, rls_forcado = true e NENHUM acesso de anon ou authenticated:
select c.relname as tabela, c.relrowsecurity as rls, c.relforcerowsecurity as rls_forcado,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies_esperado_0,
       has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon_esperado_false,
       has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as authenticated_esperado_false
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('whatsapp_vinculos', 'whatsapp_mensagens');

-- Colunas origem e wamid em lancamentos e parcelas (deve listar 4 linhas).
select table_name, column_name from information_schema.columns
where table_schema = 'public' and table_name in ('lancamentos', 'parcelas') and column_name in ('origem', 'wamid') order by 1, 2;

-- gastos_por_mes (003): só service_role executa; security invoker (prosecdef = false).
select p.prosecdef as security_definer_esperado_false,
       has_function_privilege('anon', p.oid, 'execute') as anon_esperado_false,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_esperado_false,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_esperado_true
from pg_proc p where p.oid = 'public.gastos_por_mes(uuid, date)'::regprocedure;
