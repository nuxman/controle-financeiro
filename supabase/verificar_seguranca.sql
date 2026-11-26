-- Rode no SQL Editor depois do schema.sql. Toda linha deve mostrar rls = true e policies >= 1.
select c.relname as tabela,
       c.relrowsecurity as rls,
       c.relforcerowsecurity as rls_forcado,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
       has_table_privilege('anon', c.oid, 'select') as anon_pode_ler
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;
-- Esperado: rls = true, policies = 1, anon_pode_ler = false em todas.
