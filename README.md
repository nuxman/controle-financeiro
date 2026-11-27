# Controle Financeiro

Consultor financeiro pessoal: mostra se você está bem, quanto pode gastar hoje sem faltar dinheiro nos próximos meses, e simula o efeito de uma compra (à vista ou parcelada) antes de você decidir.

- **Front-end:** HTML + JavaScript puro, publicado no GitHub Pages. Única biblioteca: pdf.js, copiado em `vendor/pdfjs/` (sem CDN).
- **Dados e login:** Supabase (PostgreSQL + Auth), protegido por Row Level Security.

## Como o app calcula

1. Você informa o mês em que o controle começa e o saldo das contas-correntes nesse dia.
2. Cadastra receitas (salário, 13º, bônus), contas fixas, compromissos pontuais (faturas já fechadas) e parcelas em andamento.
3. A cada mês, o app soma: receitas − contas − parcelas − poupança − gastos (reais nos meses passados e no atual, previstos nos futuros).
4. **Disponível no mês** = o menor saldo previsto daqui para frente. Se um mês futuro vai ficar no vermelho, a sobra de hoje é reservada para ele.
5. **Pode gastar hoje** = disponível ÷ dias que faltam no mês.

6. **Indicadores** (comprometimento, parcelas, poupança, reserva) usam a **média dos próximos 3 meses**: receitas e contas recorrentes, parcelas e o gasto variável previsto. Assim, uma parcela que acaba no mês que vem ou um 13º não distorcem o retrato.

Em **Preferências**, o botão **Usar a soma das contas-correntes em reais** preenche o saldo inicial (contas em USD/BTC, reservas e investimentos ficam de fora). Em **Contas**, **editar** muda nome, tipo, moeda e quantidade; **saldo** atualiza só o saldo (ou a cotação, em USD/BTC).

Compras no crédito contam no mês em que você compra (não quando a fatura chega). Compras parceladas pesam em cada mês da parcela.

## Instalação

### 1. Supabase (projeto separado do app de remédios)
1. Em supabase.com, crie um **novo projeto** só para este app. Assim, um problema num app não expõe os dados do outro.
2. **SQL Editor** → cole e rode `supabase/schema.sql` e depois `supabase/002_evolucao.sql` (importação de PDFs e contas em outra moeda; pode rodar de novo sem erro).
   Para lançar pelo WhatsApp, rode também `supabase/003_whatsapp.sql` (veja [Lançar pelo WhatsApp](#lançar-pelo-whatsapp)).
3. Rode `supabase/verificar_seguranca.sql`. Todas as linhas devem mostrar `rls = true`, `rls_forcado = true`, `policies = 1`, `anon_pode_ler = false` e `trava_dono = true`.
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

## Contas em dólar e bitcoin

Em **Cadastros → Contas**, escolha a moeda (BRL, USD ou BTC). Para USD/BTC informe só a **quantidade** e a **cotação em R$**: o saldo em reais é quantidade × cotação. Essas contas são sempre do tipo **investimento**, por isso não entram no saldo inicial nem no disponível (só na reserva). O botão **saldo** de uma conta em USD/BTC pede a nova cotação; **Atualizar cotação** busca as duas na AwesomeAPI (veja a CSP).

Para bitcoin (ex.: carteira Tangem) o app guarda **só a quantidade**. Nunca digite seed phrase, chave privada nem PIN, e o app não consulta endereço de carteira em blockchain.

## Importar PDF (aba Importar)

Faturas do **Bradesco** e do **Nubank** e contracheque do **TJRO**. Escolha o arquivo e o tipo (ou deixe "Detectar pelo texto").

**O que fica só no navegador:** o PDF, o texto extraído dele e a senha do PDF. A leitura é feita pelo [pdf.js](https://mozilla.github.io/pdf.js/) copiado em `vendor/pdfjs/` (versão fixa, licença Apache-2.0 junto), carregado do próprio site. Nada disso é enviado a servidor nem a serviço de IA. Só vão para o Supabase as linhas que você confirmar na tela de revisão, mais um registro em `importacoes` com o **hash SHA-256** do texto (não o texto), o tipo, a competência e os totais.

**Como funciona**
1. O app soma os lançamentos lidos e compara com o total da fatura (tolerância de R$ 0,05). O **saldo anterior** e os pagamentos entram só nessa conferência, nunca como gasto (a fatura *aberta* do app do Bradesco soma a fatura anterior não paga). Se não bater, mostra a diferença e não importa.
2. Na revisão, cada linha mostra o que vai acontecer:
   - compra à vista → gasto (`lancamentos`, meio crédito) no dia da compra;
   - parcelada `(k/n)` → a parcela k entra no valor da fatura; as `n − k` restantes viram uma linha em `parcelas` a partir do mês seguinte ao vencimento (ou atualizam a que já existe com mesma descrição, valor e cartão);
   - compras antes do início do controle e créditos/estornos → entram no valor da fatura;
   - a fatura → compromisso pontual no mês do vencimento (desmarque se já foi paga).
3. Lançamentos parecidos (mesmo valor ±R$ 0,01, até 2 dias de diferença) aparecem destacados; você escolhe, linha a linha, qual manter.
4. O mesmo arquivo (mesmo hash) não pode ser importado duas vezes. Para desfazer uma importação, apague a linha dela em `importacoes` no Supabase: o que ela criou é apagado junto (`on delete cascade`). Atualizações feitas em parcelas que já existiam não são desfeitas.

### Contracheque (TJRO / eGesp)

Só a **página 1** é extraída (as páginas 2 e 3, com memória de cálculo e dependentes, nem são lidas), e a leitura para em "Dependentes I.R.". Nome, CPF, PIS, matrícula, banco, agência e conta não são lidos nem guardados: o leitor pega só a referência, a tabela de rubricas, os totais e a margem.

- Remuneração ou desconto é decidido pela **coluna** em que o valor está, não pelo nome da rubrica.
- Conferências (±R$ 0,05): soma das remunerações = Total Bruto, soma dos descontos = Total de Descontos, bruto − descontos = líquido. Se não bater, não importa.
- Classificação (ajustável em `REGRAS`, em `js/import/contracheque.js`): **pontual** (começa com DIF., DEV., ATUALIZAÇÃO MONETÁRIA, RESTITUIÇÃO, EXERCÍCIO ANTERIOR, ou contém 13, NATALINA, FÉRIAS, 1/3, ABONO), **consignado** (EMPRESTIMO/CONSIGNA com prazo n/m) e **todo mês** (o resto).
- Líquido que se repete = líquido − remunerações pontuais + descontos pontuais + IR estimado das pontuais, onde IR = (pontuais tributáveis − previdência pontual) × alíquota do IRRF. A conta aparece na tela.
- Na confirmação: a receita recorrente "Salário (líquido)" passa a valer o novo valor a partir do mês seguinte (a antiga termina no mês do contracheque); 13º/férias/abono viram receita pontual (líquido estimado); cada consignado vira uma receita recorrente "Fim de consignado" a partir do mês seguinte à última parcela, que representa o aumento do líquido. **Consignados nunca viram compromisso.** Plano de saúde e margem aparecem só como informação.

PDF com senha: o app pede a senha num campo de senha, usa só para abrir o arquivo e esquece.

## Segurança

| Risco | Proteção |
|---|---|
| Outra pessoa ler seus dados (IDOR) | RLS em todas as tabelas (`user_id = auth.uid()`), RLS forçado, `anon` sem permissão, gatilho impede trocar o dono de uma linha |
| Alguém criar conta e entrar | Cadastro público desligado; o usuário é criado no painel |
| Vazar segredo no repositório | Só URL + chave anon no código; `.gitignore` bloqueia `.env`, `*.sql` pessoais, CSV, PDF e planilhas; push protection do GitHub |
| XSS (texto malicioso numa descrição) | Nenhum dado vira HTML (só `textContent`); CSP bloqueia scripts de fora e scripts inline |
| PDF malicioso ou vazamento do conteúdo | PDF lido só no navegador; pdf.js local com `isEvalSupported: false`, sem fontes embutidas, sem XFA; texto extraído tratado como não confiável (validação + `CHECK` no banco); limite de 10 MB |
| Código de terceiros comprometido (CDN) | Nenhuma biblioteca externa; cliente Supabase próprio em `js/supa.js` |
| Clickjacking | O app não abre dentro de `<iframe>` de outro site |
| Valores absurdos | `CHECK` no banco (valor > 0, limites de tamanho, mês sempre dia 1) |
| CSRF | Não se aplica: a autenticação vai no cabeçalho `Authorization`, não em cookie |
| Alguém usar o bot do WhatsApp ou forjar o webhook | Assinatura HMAC da Meta conferida em tempo constante; só números em `whatsapp_vinculos`, os demais ignorados em silêncio; toda consulta filtrada por `user_id`; limite de 30/hora; segredos só em `supabase secrets` |

**CSP** (`<meta>` no `index.html`): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https://*.supabase.co https://economia.awesomeapi.com.br; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
- `connect-src … https://economia.awesomeapi.com.br`: só para o botão opcional **Atualizar cotação** (dólar e bitcoin). Escolhida por ser uma única API pública brasileira, sem chave, com CORS aberto, que devolve USD-BRL e BTC-BRL numa só chamada (`/json/last/USD-BRL,BTC-BRL`). A requisição não leva nenhum dado seu (sem cookies, sem referrer, sem quantidade). Se ela falhar, a cotação manual continua funcionando. Para não usar, apague esse domínio da CSP: o botão passa a avisar que não conseguiu e segue o manual.
- `worker-src 'self'`: o pdf.js lê o PDF num Web Worker (`vendor/pdfjs/pdf.worker.min.mjs`), carregado do próprio site. Nenhum outro acréscimo foi necessário: o pdf.js não faz requisição de rede porque recebe os bytes do arquivo direto.

**Limitações conhecidas**
- O token de sessão fica no `localStorage` (para não pedir login toda hora no celular). Se um XSS acontecer, ele pode ser lido. A CSP reduz esse risco, mas não o elimina.
- O GitHub Pages não permite cabeçalhos HTTP próprios, então a CSP vai por `<meta>`, e `frame-ancestors` não funciona por esse meio. Há uma checagem em JavaScript no lugar.
- O plano gratuito do Supabase pausa o projeto após um período sem uso.

## Lançar pelo WhatsApp

Mande uma mensagem para o número do bot e o gasto entra no app; a resposta traz quanto ainda pode gastar hoje.

| Mensagem | O que faz |
|---|---|
| `45 mercado`, `30 uber pix`, `120 farmácia crédito`, `600 tênis 3x` | Registra como o lançamento rápido do app (mesmo parser, `parseRapido`). Parcelado vira uma linha em **parcelas**. Responde `✓ R$ 45,00 · Mercado · débito. Disponível hoje: R$ X (limite do dia R$ Y).` |
| `hoje` | Gasto do dia, disponível hoje e disponível até o fim do mês |
| `semana` | Gasto dos últimos 7 dias, 5 maiores categorias |
| `desfazer` | Apaga o **último** lançamento feito pelo WhatsApp, se tiver menos de 15 minutos |
| `ajuda` | Lista os comandos |

Usa só a **API oficial da Meta** (WhatsApp Business Cloud API), recebida por uma Supabase Edge Function (`supabase/functions/whatsapp`). Nada de whatsapp-web.js, Baileys ou similares: violam os termos e o número pode ser banido. Nenhuma IA interpreta as mensagens.

**Segurança do bot**
- A função é publicada **sem JWT** (a Meta não manda um). A única porta de entrada é a assinatura `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com o App Secret), conferida em tempo constante antes de ler o JSON. Sem ela ou errada: `401`.
- Só números cadastrados em `whatsapp_vinculos` são atendidos. Qualquer outro é ignorado **em silêncio** (o bot nem responde).
- A função usa a service role (ignora o RLS), por isso todo acesso passa por `doUsuario()` em `bot.js`, que põe `user_id = <do vínculo>` em toda consulta, inserção e exclusão (há teste para isso).
- A Meta reenvia mensagens: o `wamid` de cada uma é gravado em `whatsapp_mensagens` (único), e a repetida não grava nada.
- No máximo 30 mensagens por hora por número; acima disso, avisa uma vez e ignora.
- Logs só com o tipo do evento e os 4 últimos dígitos do telefone: nunca o texto da mensagem.
- Para o resumo, o bot não lê lançamento por lançamento (o PostgREST devolve no máximo 1000 linhas): soma por mês no banco com `gastos_por_mes(p_user, p_desde)` (`security invoker`, só `service_role` executa) e lê só as linhas do dia.
- Os lançamentos ganham `origem = 'whatsapp'` e o `wamid`. Na importação de fatura, um lançamento parecido que veio do WhatsApp aparece como "(via WhatsApp)".

`supabase/functions/_shared/calc.js` é **cópia** de `js/calc.js` (o deploy só empacota o que está em `supabase/functions`). Depois de mexer em `js/calc.js`, rode `npm run copiar-calc`; o teste falha se as duas estiverem diferentes.

### Configuração passo a passo

Você vai precisar do [Supabase CLI](https://supabase.com/docs/guides/cli) instalado e logado (`supabase login`, `supabase link --project-ref SEU-PROJECT-REF`).

**1. App na Meta**
1. Entre em [developers.facebook.com](https://developers.facebook.com/) com sua conta do Facebook e aceite os termos de desenvolvedor.
2. **Meus apps → Criar app**. No caso de uso, escolha **Outro → Business** (ou a opção que fala em "Conectar-se com clientes pelo WhatsApp"). *Tela:* uma lista de casos de uso com ícones; o WhatsApp aparece com o logo verde.
3. Dê um nome (ex.: `controle-financeiro-bot`) e vincule a um **portfólio empresarial** (Business Manager). Se não tiver um, a tela oferece criar.
4. No painel do app, em **Adicionar produtos**, clique em **Configurar** no card do **WhatsApp**. *Tela:* aparece o menu lateral **WhatsApp → Configuração da API** (API Setup).

**2. Número do bot**
- **Para começar: número de teste da Meta.** Em **WhatsApp → Configuração da API**, a Meta já criou um número de teste (campo **De / From**). No campo **Para / To**, clique em **Gerenciar lista de números** e adicione o seu celular; você recebe um código no WhatsApp para confirmar. *Tela:* abaixo dos campos aparecem o **Phone number ID** e o **WhatsApp Business Account ID**: copie o **Phone number ID** (vai virar `WHATSAPP_PHONE_NUMBER_ID`).
- **Limitações do número de teste:** só envia para os números da lista de destinatários (até 5, segundo o painel: confira o que aparece no seu), não pode trocar o nome de exibição, não serve para uso real com terceiros, e a Meta pode limitar o volume. Para uso pessoal com o seu próprio celular, ele já resolve.
- **Para passar a um número próprio:** use um chip que **não esteja** com o app WhatsApp nem o WhatsApp Business (se já estiver, apague a conta do WhatsApp naquele número antes: *Configurações → Conta → Apagar conta*; a Meta recusa números em uso). Em **WhatsApp → Configuração da API → Adicionar número de telefone**, informe o nome de exibição (passa por aprovação), confirme por SMS ou ligação e defina o **PIN de verificação em duas etapas** (guarde-o no seu gerenciador de senhas). Depois, registre o número na Cloud API (o painel mostra o botão ou o comando `POST /{PHONE_NUMBER_ID}/register` com o PIN). Troque `WHATSAPP_PHONE_NUMBER_ID` pelo ID do número novo e cadastre o vínculo de novo se o **seu** celular mudar (o vínculo é o número de quem manda, não o do bot).

**3. Token permanente (System User)**
O token que aparece em **Configuração da API** expira em 24 horas e não serve.
1. Abra [business.facebook.com/settings](https://business.facebook.com/settings) → **Usuários → Usuários do sistema → Adicionar**. Nome: `bot-whatsapp`, função **Funcionário** (não Admin).
2. Com ele selecionado, **Atribuir ativos**: escolha **Apps → o seu app** com controle total *e* **Contas do WhatsApp → a sua conta** (necessário para o token enxergar o número).
3. **Gerar novo token**: escolha o app, validade **Nunca**, e marque **somente** `whatsapp_business_messaging`. *Tela:* uma lista de caixas de permissão; deixe todas as outras desmarcadas (o bot só envia mensagens).
4. Copie o token (começa com `EAA…`). Ele aparece **uma única vez**. Não salve em arquivo do projeto, não cole em chat nem em issue.
5. Em **Meus apps → seu app → Configurações do app → Básico**, clique em **Mostrar** no **Chave secreta do app** (App Secret): é o `WHATSAPP_APP_SECRET`.

**4. Publicar a função e os segredos**
Invente um verify token longo e aleatório (ex.: saída de `openssl rand -hex 32`). Rode no terminal, na pasta do projeto, trocando os valores (os comandos ficam no histórico do shell; se preferir, use `supabase secrets set --env-file` apontando para um arquivo **fora** do repositório ou para `supabase/functions/.env`, que está no `.gitignore`, e apague-o depois):
```
supabase secrets set WHATSAPP_TOKEN=EAA... WHATSAPP_APP_SECRET=... WHATSAPP_VERIFY_TOKEN=... WHATSAPP_PHONE_NUMBER_ID=... GRAPH_API_VERSION=v23.0
supabase functions deploy whatsapp --no-verify-jwt
```
`GRAPH_API_VERSION`: use a versão mostrada nos exemplos de **Configuração da API** (formato `vNN.0`).

**Qual chave do Supabase vai onde**
| Chave | Onde fica | Observação |
|---|---|---|
| `sb_publishable_…` (ou `anon` legada) | `js/config.js` (navegador) | Pública. O bot **recusa** essa chave. |
| `sb_secret_…` (nova) | Nenhum segredo a definir: o Supabase injeta em `SUPABASE_SECRET_KEYS` | O bot usa a chave chamada `default` (ou a primeira) e manda **só** no cabeçalho `apikey`. |
| `service_role` JWT (legada, `eyJ…`) | Nenhum segredo a definir: o Supabase injeta em `SUPABASE_SERVICE_ROLE_KEY` | Usada só se não houver chave nova; vai em `apikey` e `Authorization: Bearer`. |

`SUPABASE_URL`, `SUPABASE_SECRET_KEYS` e `SUPABASE_SERVICE_ROLE_KEY` já existem na função: **não** coloque nenhuma delas em `supabase secrets set` nem em arquivo. Se quiser uma chave secreta só para o bot (para poder revogá-la sem afetar o resto), crie em **Project Settings → API Keys → Secret keys** e apague a `default` antiga só depois de conferir que o bot respondeu.
A URL da função fica `https://SEU-PROJECT-REF.supabase.co/functions/v1/whatsapp`.

**5. Webhook**
1. **WhatsApp → Configuração** (Configuration) → **Webhook → Editar**. *Tela:* dois campos, **URL de callback** e **Verificar token**.
2. Cole a URL da função e o mesmo `WHATSAPP_VERIFY_TOKEN`. Clique **Verificar e salvar**: a Meta faz um GET e a função devolve o `hub.challenge` (se der erro, confira o token e se o deploy foi com `--no-verify-jwt`).
3. Em **Campos do webhook**, clique em **Gerenciar** e **assine só `messages`**.
4. Para sair do modo de desenvolvimento não é preciso nada: o app pode ficar em modo **Desenvolvimento** para uso pessoal.

**6. Banco e vínculo**
1. No SQL Editor do Supabase, rode `supabase/003_whatsapp.sql` e depois `supabase/verificar_seguranca.sql` (as tabelas `whatsapp_*` devem mostrar `policies = 0` e nenhum acesso de `anon`/`authenticated`).
2. Cadastre o **seu** celular (formato E.164: `+`, país, DDD, número, sem espaços). Rode no SQL Editor, sem salvar o arquivo no repositório:
```sql
insert into public.whatsapp_vinculos (telefone_e164, user_id)
select '+55DDDNUMERO', id from auth.users where email = 'SEU-EMAIL';
```
3. Mande `ajuda` para o número do bot. Se nada voltar: **Edge Functions → whatsapp → Logs** mostra eventos como `assinatura_invalida`, `numero_nao_vinculado` (com os 4 últimos dígitos, para conferir o número cadastrado) ou `erro_interno`.

Para revogar: apague a linha em `whatsapp_vinculos`; para cortar de vez, gere um novo token no System User (o antigo deixa de valer) ou remova o webhook.

**7. Custos** (conferido em 27/11/2026 em [developers.facebook.com/docs/whatsapp/pricing](https://developers.facebook.com/docs/whatsapp/pricing) e [updates-to-pricing](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing))
- Mensagens que **você** manda para o bot não são cobradas.
- As **respostas** do bot dentro da janela de 24 horas depois da sua mensagem são *mensagens de serviço*. Desde **1º/10/2026** elas são cobradas, com **cota gratuita de 1.000 mensagens entregues por mês, por número do bot** (zera todo mês, não acumula). Com o limite de 30/hora e uso pessoal, dá para ficar dentro da cota.
- Sem forma de pagamento cadastrada na conta do WhatsApp, a Meta **bloqueia** as respostas depois das 1.000 do mês (não cobra).
- Mensagens **iniciadas pelo bot** fora da janela de 24h (ex.: resumo diário) exigem *template* aprovado e são cobradas por mensagem (categoria utilidade). Por isso o resumo diário não faz parte desta etapa.
- Os preços mudam: confira as páginas acima antes de cadastrar pagamento.

## Versão
A versão aparece no rodapé do app. A cada mudança publicada, aumente o número em `js/versao.js` **e** em `versao.json` (o teste `tests/versao.test.mjs` confere que são iguais): MENOR para funcionalidade nova, CORREÇÃO para conserto.
Se o navegador estiver com arquivos antigos em cache, o rodapé mostra o botão "Nova versão disponível: atualizar".

## Testes
```
node --test tests/*.test.mjs
```

## Próximas etapas
- Resumo diário por e-mail/Telegram (Supabase Edge Function + agendamento)
- Importação de extratos (CSV/OFX)
- Revisão mensal automática e metas
- Lançamento pelo WhatsApp por foto de comprovante / QR code da NFC-e
