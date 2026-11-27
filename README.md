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

**CSP** (`<meta>` no `index.html`): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https://*.supabase.co https://economia.awesomeapi.com.br; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
- `connect-src … https://economia.awesomeapi.com.br`: só para o botão opcional **Atualizar cotação** (dólar e bitcoin). Escolhida por ser uma única API pública brasileira, sem chave, com CORS aberto, que devolve USD-BRL e BTC-BRL numa só chamada (`/json/last/USD-BRL,BTC-BRL`). A requisição não leva nenhum dado seu (sem cookies, sem referrer, sem quantidade). Se ela falhar, a cotação manual continua funcionando. Para não usar, apague esse domínio da CSP: o botão passa a avisar que não conseguiu e segue o manual.
- `worker-src 'self'`: o pdf.js lê o PDF num Web Worker (`vendor/pdfjs/pdf.worker.min.mjs`), carregado do próprio site. Nenhum outro acréscimo foi necessário: o pdf.js não faz requisição de rede porque recebe os bytes do arquivo direto.

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
- Importação de extratos (CSV/OFX)
- Revisão mensal automática e metas
- Lançamento pelo WhatsApp
