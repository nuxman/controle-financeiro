-- =====================================================================
-- Controle Financeiro — esquema do banco (Supabase / PostgreSQL)
--
-- Rode este arquivo UMA vez no SQL Editor do projeto Supabase.
-- Ele não contém nenhum dado pessoal: pode ficar no repositório público.
--
-- Segurança:
--   * Toda tabela tem Row Level Security (RLS) ligado.
--   * Cada linha pertence a um usuário (user_id) e só ele lê/escreve.
--   * O papel "anon" (visitante sem login) não tem permissão nenhuma.
--   * Valores têm limites (CHECK) para barrar entrada absurda ou maliciosa.
-- =====================================================================

-- ---------- Contas e saldos (corrente, reserva, investimento) ----------
create table if not exists public.contas (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome          text not null check (char_length(nome) between 1 and 60),
  tipo          text not null check (tipo in ('corrente', 'reserva', 'investimento')),
  saldo         numeric(12,2) not null default 0 check (saldo between -10000000 and 100000000),
  atualizado_em date not null default current_date,
  created_at    timestamptz not null default now()
);

-- ---------- Receitas (salário recorrente ou entradas pontuais: 13º, bônus) ----------
create table if not exists public.receitas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  descricao   text not null check (char_length(descricao) between 1 and 80),
  valor       numeric(12,2) not null check (valor > 0 and valor < 10000000),
  recorrente  boolean not null default false,
  mes         date check (mes is null or extract(day from mes) = 1),   -- 1º dia do mês, para pontuais
  inicio      date check (inicio is null or extract(day from inicio) = 1), -- recorrente a partir de
  fim         date check (fim is null or extract(day from fim) = 1),       -- recorrente até (inclusive)
  created_at  timestamptz not null default now(),
  check (recorrente or mes is not null)
);

-- ---------- Compromissos (contas fixas mensais ou pagamentos pontuais) ----------
create table if not exists public.compromissos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  descricao   text not null check (char_length(descricao) between 1 and 80),
  categoria   text not null default 'Contas' check (char_length(categoria) between 1 and 40),
  valor       numeric(12,2) not null check (valor > 0 and valor < 10000000),
  recorrente  boolean not null default true,
  mes         date check (mes is null or extract(day from mes) = 1),
  inicio      date check (inicio is null or extract(day from inicio) = 1),
  fim         date check (fim is null or extract(day from fim) = 1),
  created_at  timestamptz not null default now(),
  check (recorrente or mes is not null)
);

-- ---------- Parcelas (compras parceladas: cada parcela pesa no seu mês) ----------
create table if not exists public.parcelas (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  descricao      text not null check (char_length(descricao) between 1 and 80),
  categoria      text not null default 'Compras' check (char_length(categoria) between 1 and 40),
  cartao         text check (cartao is null or char_length(cartao) <= 30),
  valor_parcela  numeric(12,2) not null check (valor_parcela > 0 and valor_parcela < 1000000),
  primeiro_mes   date not null check (extract(day from primeiro_mes) = 1), -- mês da 1ª parcela que ainda falta
  quantidade     int not null check (quantidade between 1 and 48),          -- parcelas que ainda faltam
  created_at     timestamptz not null default now()
);

-- ---------- Lançamentos do dia a dia ----------
create table if not exists public.lancamentos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data        date not null default current_date,
  valor       numeric(12,2) not null check (valor > 0 and valor < 1000000),
  categoria   text not null check (char_length(categoria) between 1 and 40),
  descricao   text check (descricao is null or char_length(descricao) <= 80),
  meio        text not null default 'debito' check (meio in ('debito', 'pix', 'dinheiro', 'credito')),
  created_at  timestamptz not null default now()
);
create index if not exists lancamentos_user_data on public.lancamentos (user_id, data);

-- ---------- Configuração pessoal (uma linha por usuário) ----------
create table if not exists public.config (
  user_id                 uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  meta_poupanca           numeric(12,2) not null default 0 check (meta_poupanca >= 0 and meta_poupanca < 10000000),
  gasto_variavel_previsto numeric(12,2) not null default 0 check (gasto_variavel_previsto >= 0 and gasto_variavel_previsto < 10000000),
  saldo_inicial           numeric(12,2) not null default 0 check (saldo_inicial between -10000000 and 100000000), -- dinheiro em conta corrente no início
  mes_inicio              date check (mes_inicio is null or extract(day from mes_inicio) = 1),                   -- mês em que o controle começa
  updated_at              timestamptz not null default now()
);

-- ---------- Limites de referência por categoria (opcional) ----------
create table if not exists public.limites (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  categoria     text not null check (char_length(categoria) between 1 and 40),
  limite_mensal numeric(12,2) not null check (limite_mensal > 0 and limite_mensal < 10000000),
  unique (user_id, categoria)
);

-- =====================================================================
-- Row Level Security: cada usuário só enxerga e altera as próprias linhas
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['contas','receitas','compromissos','parcelas','lancamentos','config','limites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists dono on public.%I', t);
    execute format(
      'create policy dono on public.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))', t);
    -- Visitante sem login não acessa nada; usuário logado só via RLS acima.
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- Impede que o user_id de uma linha seja trocado depois de criada.
create or replace function public.bloquear_troca_dono() returns trigger
language plpgsql as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id não pode ser alterado';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['contas','receitas','compromissos','parcelas','lancamentos','config','limites'] loop
    execute format('drop trigger if exists trava_dono on public.%I', t);
    execute format('create trigger trava_dono before update on public.%I for each row execute function public.bloquear_troca_dono()', t);
  end loop;
end $$;
