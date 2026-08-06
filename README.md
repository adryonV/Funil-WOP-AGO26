# Funil de Tráfego — WOP-AGO26 (Meta Ads)

Dashboard estático (GitHub Pages) que cruza **duas planilhas Google** e se reconstrói
sozinho **100% na nuvem** a cada 2 h. Nada roda no seu PC.

- **URL pública:** https://adryonv.github.io/Funil-WOP-AGO26/
- **Somente leitura** nas planilhas (export CSV/gviz) — nunca escreve nelas.

## Como funciona

1. `build.mjs` (Node, sem dependências) roda no GitHub Actions:
   - lê a planilha de **anúncios** (aba *Meta Ads*) e a de **compradores** (aba *29/08*);
   - atribui cada venda ao anúncio pelas UTMs
     (`utm_campaign`→campanha · `utm_medium`→conjunto · `utm_content`→anúncio);
   - grava `public/data.json` **agregado, sem PII** (nomes/e-mails/telefones ficam fora).
2. O gasto vai **cru (bruto)** no `data.json`; o dashboard multiplica por
   `meta.tax = 1.1385` **antes de todas as métricas** (CPM, CPC, CAC, ROAS, etc.).
3. `actions/deploy-pages` publica `public/` no GitHub Pages.
4. `index.html` busca `data.json?v=<BUILD_ID>&t=<timestamp>` com `cache:no-store`
   (**cache-bust** duplo) — o navegador sempre pega a versão nova.

## Valor da compra

A aba de compradores ainda **não tem coluna de valor**. O build **detecta
automaticamente** uma coluna chamada `Valor da Compra` / `Valor` / `Bruto` /
`Faturamento` assim que você adicionar. Enquanto não existir, cada venda é
precificada por `FALLBACK_TICKET` (topo do `build.mjs`, hoje `0`). Para ter
ROAS/receita já com um ticket fixo, mude `FALLBACK_TICKET` para o preço da oferta.

## Gatilhos do build

- `schedule` a cada 2 h (backup) · `workflow_dispatch` (botão manual) ·
  `repository_dispatch type=rebuild` (cron-job.org) · `push` na `main`.

### cron-job.org (a cada 2 h)

- **Method:** `POST`
- **URL:** `https://api.github.com/repos/adryonV/Funil-WOP-AGO26/dispatches`
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <SEU_TOKEN>`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `User-Agent: cron-job`
- **Body:** `{"event_type":"rebuild"}`

O token vive **só** no cron-job.org, nunca neste repositório.
