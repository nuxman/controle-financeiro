# Controle Financeiro

Consultor financeiro pessoal: mostra se você está bem, quanto pode gastar hoje sem faltar dinheiro nos próximos meses, e simula o efeito de uma compra (à vista ou parcelada) antes de você decidir.

- **Front-end:** HTML + JavaScript puro, publicado no GitHub Pages. Sem bibliotecas externas.
- **Dados e login:** Supabase (PostgreSQL + Auth), protegido por Row Level Security.

## Como o app calcula

1. Você informa o mês em que o controle começa e o saldo das contas-correntes nesse dia.
2. Cadastra receitas (salário, 13º, bônus), contas fixas, compromissos pontuais (faturas já fechadas) e parcelas em andamento.
3. A cada mês, o app soma: receitas − contas − parcelas − poupança − gastos (reais nos meses passados e no atual, previstos nos futuros).
4. **Disponível no mês** = o menor saldo previsto daqui para frente. Se um mês futuro vai ficar no vermelho, a sobra de hoje é reservada para ele.
5. **Pode gastar hoje** = disponível ÷ dias que faltam no mês.

Compras no crédito contam no mês em que você compra (não quando a fatura chega). Compras parceladas pesam em cada mês da parcela.

## Instalação

### 1. Supabase (projeto separado do app de remédios)
1. Em supabase.com, crie um **novo projeto** só para este app. Assim, um problema num app não expõe os dados do outro.
2. **SQL Editor** → cole e rode `supabase/schema.sql`.
3. Rode `supabase/verificar_seguranca.sql`. Todas as linhas devem mostrar `rls = true`, `policies = 1` e `anon_pode_ler = false`.
4. **Authentication → Sign In / Providers → Email:** desligue **"Allow new users to sign up"**.
5. **Authentication → Users → Add user:** crie o seu usuário com uma senha forte (12+ caracteres) e marque "Auto Confirm".
6. (Opcional) Rode o seu arquivo de dados pessoais no SQL Editor. **Esse arquivo nunca vai para o GitHub.**
7. **Authentication → URL Configuration:** em Site URL, coloque `https://SEU-USUARIO.github.io/controle-financeiro/`.

### 2. Configurar o app
Em **Project Settings → API** (ou **API Keys**), copie a **Project URL** e a chave **anon / publishable** para `js/config.js`.

> A chave anon/publishable é pública por definição: quem protege os dados é o RLS.
> **Nunca** use a `service_role` / `secret`. O app se recusa a abrir se detectar uma.

### 3. GitHub Pages
1. Envie os arquivos para o repositório.
2. **Settings → Pages:** Source = *Deploy from a branch*, branch `main`, pasta `/ (root)`.
3. **Settings → Code security:** ative **Secret scanning** e **Push protection**.

## Segurança

| Risco | Proteção |
|---|---|
| Outra pessoa ler seus dados (IDOR) | RLS em todas as tabelas (`user_id = auth.uid()`), RLS forçado, `anon` sem permissão, gatilho impede trocar o dono de uma linha |
| Alguém criar conta e entrar | Cadastro público desligado; o usuário é criado no painel |
| Vazar segredo no repositório | Só URL + chave anon no código; `.gitignore` bloqueia `.env`, `*.sql` pessoais, CSV, PDF e planilhas; push protection do GitHub |
| XSS (texto malicioso numa descrição) | Nenhum dado vira HTML (só `textContent`); CSP bloqueia scripts de fora e scripts inline |
| Código de terceiros comprometido (CDN) | Nenhuma biblioteca externa; cliente Supabase próprio em `js/supa.js` |
| Clickjacking | O app não abre dentro de `<iframe>` de outro site |
| Valores absurdos | `CHECK` no banco (valor > 0, limites de tamanho, mês sempre dia 1) |
| CSRF | Não se aplica: a autenticação vai no cabeçalho `Authorization`, não em cookie |

**Limitações conhecidas**
- O token de sessão fica no `localStorage` (para não pedir login toda hora no celular). Se um XSS acontecer, ele pode ser lido. A CSP reduz esse risco, mas não o elimina.
- O GitHub Pages não permite cabeçalhos HTTP próprios, então a CSP vai por `<meta>`, e `frame-ancestors` não funciona por esse meio. Há uma checagem em JavaScript no lugar.
- O plano gratuito do Supabase pausa o projeto após um período sem uso.

## Testes
```
node --test tests/*.test.mjs
```

## Próximas etapas
- Resumo diário por e-mail/Telegram (Supabase Edge Function + agendamento)
- Importação de CSV das faturas e extratos
- Revisão mensal automática e metas
- Lançamento pelo WhatsApp
