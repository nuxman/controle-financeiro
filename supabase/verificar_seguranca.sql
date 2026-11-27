-- Rode no SQL Editor depois do schema.sql e do 002_evolucao.sql.
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
-- Esperado em TODAS as linhas: rls = true, rls_forcado = true, policies = 1, anon_pode_ler = false, trava_dono = true.
-- Tabelas esperadas: compromissos, config, contas, importacoes, lancamentos, limites, parcelas, receitas.

-- A migração 002 foi aplicada? (deve listar 4 linhas)
select table_name, column_name from information_schema.columns
where table_schema = 'public' and column_name = 'importacao_id' order by 1;

-- Contas em moeda estrangeira (002): as 4 colunas e as regras devem existir.
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'contas'
     and column_name in ('moeda', 'quantidade', 'cotacao', 'cotacao_em')) as colunas_moeda_esperado_4,
  (select count(*) from pg_constraint where conrelid = 'public.contas'::regclass
     and conname in ('contas_moeda_check', 'contas_quantidade_check', 'contas_cotacao_check', 'contas_estrangeira_check')) as regras_moeda_esperado_4;
