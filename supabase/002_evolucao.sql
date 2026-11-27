-- =====================================================================
-- Controle Financeiro — migração 002 (importação de PDFs)
--
-- Rode no SQL Editor DEPOIS do schema.sql. Pode rodar de novo sem erro.
-- Não contém dado pessoal.
-- =====================================================================

-- ---------- Importações (uma linha por PDF importado) ----------
-- Guarda só o resumo: hash do texto extraído (para não importar duas vezes), tipo, competência e totais.
-- O PDF e o texto dele nunca saem do navegador.
create table if not exists public.importacoes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  hash            text not null check (hash ~ '^[0-9a-f]{64}$'),
  tipo            text not null check (tipo in ('fatura_bradesco', 'fatura_nubank', 'contracheque')),
  competencia     date not null check (extract(day from competencia) = 1),
  total           numeric(12,2) check (total is null or total between -10000000 and 10000000),               -- fatura
  total_bruto     numeric(12,2) check (total_bruto is null or total_bruto between 0 and 10000000),           -- contracheque
  total_descontos numeric(12,2) check (total_descontos is null or total_descontos between 0 and 10000000),   -- contracheque
  liquido         numeric(12,2) check (liquido is null or liquido between -10000000 and 10000000),           -- contracheque
  created_at      timestamptz not null default now(),
  unique (user_id, hash)
);

-- De qual importação veio cada linha. Apagar a importação apaga as linhas que ela CRIOU (desfazer).
alter table public.lancamentos  add column if not exists importacao_id uuid references public.importacoes(id) on delete cascade;
alter table public.parcelas     add column if not exists importacao_id uuid references public.importacoes(id) on delete cascade;
alter table public.compromissos add column if not exists importacao_id uuid references public.importacoes(id) on delete cascade;
alter table public.receitas     add column if not exists importacao_id uuid references public.importacoes(id) on delete cascade;

-- ---------- RLS, igual ao schema.sql ----------
do $$
declare t text;
begin
  foreach t in array array['importacoes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists dono on public.%I', t);
    execute format(
      'create policy dono on public.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop trigger if exists trava_dono on public.%I', t);
    execute format('create trigger trava_dono before update on public.%I for each row execute function public.bloquear_troca_dono()', t);
  end loop;
end $$;

-- ---------- Contas em outra moeda (Etapa 3) ----------
-- `saldo` continua sendo o valor em R$ (= quantidade × cotação, calculado no app), para o resto do app não mudar.
-- Só a QUANTIDADE é guardada: nunca seed phrase, chave privada, PIN ou endereço de carteira.
alter table public.contas add column if not exists moeda      text not null default 'BRL';
alter table public.contas add column if not exists quantidade numeric(24,8);
alter table public.contas add column if not exists cotacao    numeric(18,6);
alter table public.contas add column if not exists cotacao_em date;
alter table public.contas drop constraint if exists contas_moeda_check;
alter table public.contas add constraint contas_moeda_check check (moeda in ('BRL', 'USD', 'BTC'));
alter table public.contas drop constraint if exists contas_quantidade_check;
alter table public.contas add constraint contas_quantidade_check check (quantidade is null or quantidade between 0 and 1000000000);
alter table public.contas drop constraint if exists contas_cotacao_check;
alter table public.contas add constraint contas_cotacao_check check (cotacao is null or (cotacao > 0 and cotacao < 100000000));
-- Moeda estrangeira = investimento, com quantidade e cotação (nunca entra no saldo inicial nem no disponível).
alter table public.contas drop constraint if exists contas_estrangeira_check;
alter table public.contas add constraint contas_estrangeira_check check (moeda = 'BRL' or (tipo = 'investimento' and quantidade is not null and cotacao is not null));
