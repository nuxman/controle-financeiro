-- =====================================================================
-- Controle Financeiro — migração 003 (lançamentos pelo WhatsApp)
--
-- Rode no SQL Editor DEPOIS do schema.sql e do 002_evolucao.sql. Pode rodar de novo sem erro.
-- Não contém dado pessoal: o seu telefone é cadastrado à parte (veja o README).
-- =====================================================================

-- ---------- Quem pode falar com o bot ----------
-- Só a Edge Function (service role) lê esta tabela: sem policy para authenticated, e anon sem permissão.
create table if not exists public.whatsapp_vinculos (
  telefone_e164 text primary key check (telefone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now()
);

-- ---------- Mensagens já recebidas (a Meta reenvia: o wamid repetido é ignorado) ----------
-- Guarda só o id da mensagem e a hora, nunca o texto nem o telefone. Também serve para o limite por hora.
create table if not exists public.whatsapp_mensagens (
  id         bigint generated always as identity primary key,
  wamid      text not null unique check (char_length(wamid) between 1 and 200),
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_mensagens_user_hora on public.whatsapp_mensagens (user_id, created_at);

do $$
declare t text;
begin
  foreach t in array array['whatsapp_vinculos','whatsapp_mensagens'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists dono on public.%I', t);   -- de propósito: nenhuma policy
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('drop trigger if exists trava_dono on public.%I', t);
    execute format('create trigger trava_dono before update on public.%I for each row execute function public.bloquear_troca_dono()', t);
  end loop;
end $$;

-- ---------- De onde veio cada lançamento ----------
-- origem: app | whatsapp | importacao. wamid: id da mensagem do WhatsApp que criou a linha (para o "desfazer").
do $$
declare t text;
begin
  foreach t in array array['lancamentos','parcelas'] loop
    execute format('alter table public.%I add column if not exists origem text not null default ''app''', t);
    execute format('alter table public.%I add column if not exists wamid text', t);
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_origem_check');
    execute format('alter table public.%I add constraint %I check (origem in (''app'', ''whatsapp'', ''importacao''))', t, t || '_origem_check');
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_wamid_check');
    execute format('alter table public.%I add constraint %I check (wamid is null or (origem = ''whatsapp'' and char_length(wamid) <= 200))', t, t || '_wamid_check');
    execute format('create unique index if not exists %I on public.%I (wamid) where wamid is not null', t || '_wamid_unico', t);
    execute format('create index if not exists %I on public.%I (user_id, origem, created_at)', t || '_user_origem', t);
    -- Linhas que vieram de importação de PDF (o app não manda a origem: o gatilho abaixo preenche).
    execute format('update public.%I set origem = ''importacao'' where importacao_id is not null and origem = ''app''', t);
  end loop;
end $$;

create or replace function public.origem_importacao() returns trigger
language plpgsql as $$
begin
  if new.importacao_id is not null and new.origem = 'app' then new.origem := 'importacao'; end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['lancamentos','parcelas'] loop
    execute format('drop trigger if exists origem_importacao on public.%I', t);
    execute format('create trigger origem_importacao before insert on public.%I for each row execute function public.origem_importacao()', t);
  end loop;
end $$;

-- ---------- Total gasto por mês (para o bot não ler lançamento por lançamento) ----------
-- security invoker: roda com o papel de quem chama. O bot chama com a chave secreta e passa SEMPRE o user_id do vínculo.
-- Só o service_role pode executar (anon e authenticated não), e a consulta filtra por p_user.
create or replace function public.gastos_por_mes(p_user uuid, p_desde date)
returns table (mes date, total numeric)
language sql stable security invoker set search_path = ''
as $$
  select date_trunc('month', l.data)::date as mes, sum(l.valor) as total
  from public.lancamentos l
  where l.user_id = p_user and l.data >= p_desde
  group by 1
  order by 1
$$;
revoke all on function public.gastos_por_mes(uuid, date) from public, anon, authenticated;
grant execute on function public.gastos_por_mes(uuid, date) to service_role;
