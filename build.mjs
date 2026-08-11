// build.mjs — runs on the GitHub Actions runner (Node 20+, no dependencies).
//
// Cross-references two shared Google Sheets and writes ./public/data.json for the
// static dashboard. READ-ONLY: it only fetches the sheets via CSV/gviz export
// endpoints; it never writes to them.
//
// DATA MODEL (this account) --------------------------------------------------
//   1) Métricas dos Anúncios — aba "Meta Ads": Day / Campaign Name / Ad Set Name /
//      Ad Name / Amount Spent / Impressions / Link Clicks / Landing Page Views /
//      Checkouts Initiated. One row per day×campaign×conjunto×anúncio.
//   2) Lista de Compradores — aba "29/08": Data / Nome / ... / UTM Source / UTM Medium /
//      UTM Campaign / UTM Content / UTM Term / UTM id / SCK.
//      One row per sale. ATRIBUIÇÃO DO CRIATIVO vem da coluna SCK (Site Custom Key do
//      Meta), cujo ÚLTIMO segmento é o nome do anúncio — o utm_content desta conta vem
//      errado (traz a fase da campanha, não o anúncio). UTM é só fallback quando não há SCK.
//      VALUE: this tab has no price column yet. The build AUTO-DETECTS a value column
//      (Valor da Compra / Valor / Bruto / Faturamento / …) the moment it is added.
//      Until then each sale is priced at FALLBACK_TICKET (see below).
//
// MOEDA: a conta de anúncios é em DÓLAR (USD). O gasto vai CRU em USD no data.json;
// o dashboard multiplica por meta.fx (câmbio USD→BRL, buscado ao vivo a cada build)
// para exibir TODAS as métricas de dinheiro em REAL (BRL). SEM imposto (meta.tax = 1).

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

// --- Sources ----------------------------------------------------------------
const ADS_ID    = '1r0Gu8XTVmG4tlMlsY8D2OKvkEpvvrAjTACR13LEn87s';
const BUYERS_ID = '1tCmJ79YCYFje8sH9NFXrWuO6366i5JowRDSQ70zs0aM';
const SALES_TAB = '29/08';                       // aba dos compradores (gid 0)

const SHEET_ADS   = `https://docs.google.com/spreadsheets/d/${ADS_ID}/export?format=csv&gid=0`;
const SHEET_SALES = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SALES_TAB)}`;

const ADS_URL    = `https://docs.google.com/spreadsheets/d/${ADS_ID}/edit`;
const BUYERS_URL = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/edit`;

// --- Tax on ad spend --------------------------------------------------------
// A conta é em USD → sem imposto brasileiro sobre o gasto. Deixe 1 para desligar.
const TAX_RATE = 1;

// --- Câmbio USD→BRL (buscado ao vivo a cada build) --------------------------
const FX_SOURCE   = 'https://open.er-api.com/v6/latest/USD'; // grátis, sem chave
const FX_FALLBACK = 5.11;  // usado só se a cotação ao vivo falhar
async function fetchFxUsdBrl() {
  try {
    const r = await fetch(FX_SOURCE, { headers: { 'User-Agent': 'funnel-dashboard-build' } });
    if (!r.ok) throw new Error(`FX HTTP ${r.status}`);
    const j = await r.json();
    const rate = j && j.rates && Number(j.rates.BRL);
    if (Number.isFinite(rate) && rate > 0) {
      return { fx: rate, date: j.time_last_update_utc || null, source: 'open.er-api.com' };
    }
    throw new Error('FX payload sem rates.BRL');
  } catch (e) {
    console.warn('FX ao vivo falhou, usando fallback:', e.message);
    return { fx: FX_FALLBACK, date: null, source: 'fallback' };
  }
}

// --- Fallback ticket while the buyers tab has no value column ----------------
// Regra do cliente (2026-08-10): considerar que TODA venda trouxe R$ 57 de receita.
// Se um dia a aba ganhar uma coluna "Valor da Compra", o build passa a usar o valor
// real de cada linha automaticamente; enquanto não, cada venda vale este ticket.
const FALLBACK_TICKET = 57;

// --- utm_source values that mean "paid Meta traffic" ------------------------
const isPaidSource = (s) => /^(fb|facebook|facebook[-\s]?ads|meta|meta[-\s]?ads|ig|instagram)$/i.test(String(s || '').trim());

// ---------------------------------------------------------------------------
// CSV parser (quoted fields, escaped quotes, embedded newlines)
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Number in Brazilian or plain format: "1.234,56" / "46,9" / "197"
function num(s) {
  if (s == null) return 0;
  s = String(s).trim().replace(/^R\$\s*/i, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Collapse whitespace + trim (join keys sometimes differ only by double spaces).
const normKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// Lowercase + strip accents (for matching).
const fold = (s) => normKey(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Decode a URL-encoded UTM then normalize.
function decodeUtm(s) {
  let v = String(s == null ? '' : s);
  if (v.includes('%')) { try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* keep */ } }
  return normKey(v);
}
const isUtm = (s) => {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v !== '' && v !== 'undefined' && !v.includes('{{');
};
// Meta sometimes appends "|<numeric id>" to UTM values. Strip a trailing "|<6+ digits>".
const stripId = (s) => decodeUtm(s).replace(/\s*\|\s*\d{6,}\s*$/, '').trim();
// utm_content occasionally = "<AdName>|<id>::<fbclid junk>::" → take the ad name.
const cleanContent = (s) => {
  let v = decodeUtm(s).split('::')[0].split('|')[0];
  return normKey(v);
};

const pad = (n) => String(n).padStart(2, '0');

// Extract YYYY-MM-DD from "06/08/2026 09:04", "6/8/2026", ISO…
function isoDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);            // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);           // D/M/YYYY (Brazil)
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  return null;
}

async function fetchText(url, label) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'funnel-dashboard-build' } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${label}`);
  const body = await r.text();
  if (/^\s*<!DOCTYPE html/i.test(body)) {
    throw new Error(`Got an HTML page instead of CSV for ${label} — the sheet is probably NOT shared publicly (set "Anyone with the link → Viewer").`);
  }
  return body;
}
// Case/space-insensitive header lookup; accepts several aliases.
function headerIndex(h, ...names) {
  const want = names.map((n) => fold(n));
  return h.findIndex((x) => want.includes(fold(x)));
}

(async () => {
  const [csvAds, csvSales, fxInfo] = await Promise.all([
    fetchText(SHEET_ADS, 'ads sheet'),
    fetchText(SHEET_SALES, `buyers tab "${SALES_TAB}"`),
    fetchFxUsdBrl(),
  ]);

  // ---------------- Sheet 1: Meta Ads metrics ----------------
  const a = parseCSV(csvAds);
  const h1 = a[0] || [];
  const I = {
    day:   headerIndex(h1, 'Day'),
    camp:  headerIndex(h1, 'Campaign Name'),
    set:   headerIndex(h1, 'Ad Set Name'),
    ad:    headerIndex(h1, 'Ad Name'),
    spend: headerIndex(h1, 'Amount Spent'),
    imp:   headerIndex(h1, 'Impressions'),
    clk:   headerIndex(h1, 'Link Clicks'),
    lpv:   headerIndex(h1, 'Landing Page Views'),
    chk:   headerIndex(h1, 'Checkouts Initiated'),
  };
  const ads = [];
  for (let i = 1; i < a.length; i++) {
    const r = a[i];
    if (!r || r.length < 2) continue;
    const day = String(r[I.day] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    ads.push({
      d: day,
      c: normKey(r[I.camp]),
      s: normKey(r[I.set]),
      a: normKey(r[I.ad]),
      spend: num(r[I.spend]),                       // GROSS — tax applied in dashboard
      imp: Math.round(num(r[I.imp])),
      clk: Math.round(num(r[I.clk])),
      lpv: I.lpv >= 0 ? Math.round(num(r[I.lpv])) : 0,
      ic:  I.chk >= 0 ? Math.round(num(r[I.chk])) : 0,
    });
  }

  // Canonical name lookups (folded → original ads-sheet spelling) so a sale's
  // campaign/conjunto/anúncio join EXACTLY to the ad rows in the grouping tables.
  const canonCamp = new Map(), canonSet = new Map(), canonAd = new Map();
  // Ad-name → {campaign, adset} it spent most under (fallback attribution).
  const spendByCombo = new Map();
  for (const r of ads) {
    if (r.c) canonCamp.set(fold(r.c), r.c);
    if (r.s) canonSet.set(fold(r.s), r.s);
    if (r.a) canonAd.set(fold(r.a), r.a);
    if (r.a) {
      const ak = fold(r.a);
      const m = spendByCombo.get(ak) || new Map();
      const k = r.c + '||' + r.s;
      m.set(k, (m.get(k) || 0) + r.spend);
      spendByCombo.set(ak, m);
    }
  }
  const adToCombo = new Map();
  for (const [ak, m] of spendByCombo) {
    let best = '||', bestSpend = -Infinity;
    for (const [k, sp] of m) if (sp > bestSpend) { bestSpend = sp; best = k; }
    const [c, s] = best.split('||');
    adToCombo.set(ak, { c, s });
  }

  // (anúncio + conjunto) → campanha de maior gasto — resolve a campanha exata quando
  // a SCK nos dá o par anúncio/conjunto (um mesmo anúncio roda em 2 campanhas).
  const campByAdSet = new Map(); // "fold(ad)|fold(set)" -> Map(campanha -> gasto)
  for (const r of ads) {
    if (!r.a) continue;
    const k = fold(r.a) + '|' + fold(r.s);
    const mm = campByAdSet.get(k) || new Map();
    mm.set(r.c, (mm.get(r.c) || 0) + r.spend);
    campByAdSet.set(k, mm);
  }
  const campForAdSet = (adFold, setFold) => {
    const mm = campByAdSet.get(adFold + '|' + setFold);
    if (!mm) return '';
    let best = '', bs = -Infinity;
    for (const [c, sp] of mm) if (sp > bs) { bs = sp; best = c; }
    return best;
  };

  // SCK (Site Custom Key do Meta): "<source>|<conjunto>|<campanha>|<placement>|<ANÚNCIO>".
  // O ANÚNCIO (criativo) é o último segmento e é a atribuição mais confiável — o
  // utm_content desta conta vem errado (traz "E4-VEN", não o nome do anúncio).
  // A campanha tem " | " interno, então NÃO dá pra pegar por posição fixa: varremos
  // os segmentos e casamos com os nomes reais da planilha de anúncios (canonAd/canonSet).
  const sckSegments = (s) => String(s == null ? '' : s).split('|').map((p) => normKey(p));
  // Casa o MAIOR nome conhecido presente como substring na SCK. Necessário porque
  // conjunto e campanha têm " | " interno (ex.: conjunto "...Mix quente | AD09",
  // campanha "WOP-AGO26 | E4-VEN | ... | Teste de Criativos") — split por "|" quebra
  // esses nomes, então casar por inclusão (pegando o mais longo) recupera o certo.
  const longestInSck = (rawSck, canonMap) => {
    const hay = fold(rawSck);
    let best = '', bestLen = 0;
    for (const [cf, orig] of canonMap) if (cf && cf.length > bestLen && hay.includes(cf)) { bestLen = cf.length; best = orig; }
    return best;
  };
  const adFromSck = (rawSck, segs) => {         // criativo = último segmento; senão, maior anúncio casado na SCK
    for (let i = segs.length - 1; i >= 0; i--) { const c = canonAd.get(fold(segs[i])); if (c) return c; }
    return longestInSck(rawSck, canonAd);
  };

  // ---------------- Sheet 2: buyers (aba 29/08) ----------------
  const b = parseCSV(csvSales);
  const h2 = b[0] || [];
  const B = {
    date: headerIndex(h2, 'Data', 'DATA', 'Data | Hora', 'Data da Compra'),
    name: headerIndex(h2, 'Nome', 'NOME', 'Nome Completo'),
    mail: headerIndex(h2, 'Email', 'E-mail'),
    src:  headerIndex(h2, 'UTM Source', 'utm_source'),
    med:  headerIndex(h2, 'UTM Medium', 'utm_medium'),
    camp: headerIndex(h2, 'UTM Campaign', 'utm_campaign'),
    cont: headerIndex(h2, 'UTM Content', 'utm_content'),
    sck:  headerIndex(h2, 'SCK', 'sck', 'Site Custom Key'),
  };
  // Auto-detect a value column the moment it is added to the sheet.
  const valIdx = headerIndex(h2, 'Valor da Compra', 'Valor', 'Bruto', 'Faturamento',
                             'Preço', 'Preco', 'Amount', 'Value', 'Revenue', 'Valor Bruto');
  const hasValueCol = valIdx >= 0;

  const sales = [];
  const attribution = { ad: 0, adset: 0, campaign: 0, unmatched: 0, none: 0 };
  let trafficSales = 0, valuedFromCol = 0, sckAttributed = 0;

  for (let i = 1; i < b.length; i++) {
    const r = b[i];
    if (!r || r.length < 1) continue;
    const d = isoDate(r[B.date]);
    if (!d) continue;
    const name = normKey(r[B.name]);
    const mail = normKey(B.mail >= 0 ? r[B.mail] : '');
    const rawSrc  = String(r[B.src]  || '');
    const rawMed  = String(r[B.med]  || '');
    const rawCamp = String(r[B.camp] || '');
    const rawCont = String(r[B.cont] || '');
    const rawSck  = String(B.sck >= 0 ? r[B.sck] : '');
    const hasUtm = [rawSrc, rawMed, rawCamp, rawCont].some(isUtm);
    // Skip placeholder/empty rows (only a date, no identity, no UTM).
    if (!name && !mail && !hasUtm) continue;

    // Value: from the sheet column if present, else the fallback ticket.
    let value = FALLBACK_TICKET;
    if (hasValueCol) { const vv = num(r[valIdx]); if (vv > 0) { value = vv; valuedFromCol++; } }

    const paid = isPaidSource(rawSrc);
    let src = 'organico', m = 'none', c = '', s = '', ad = '';
    if (paid) {
      src = 'meta-ads';
      // 1) SCK primeiro: o criativo é o último segmento (utm_content vem errado nesta conta).
      //    Conjunto e campanha são casados pelo MAIOR nome conhecido na SCK (têm "|" interno).
      const segs = sckSegments(rawSck);
      ad = adFromSck(rawSck, segs);
      s  = longestInSck(rawSck, canonSet);
      if (ad) {                                   // campanha da própria SCK; senão, par anúncio+conjunto
        const cc = longestInSck(rawSck, canonCamp) || campForAdSet(fold(ad), fold(s)) || (adToCombo.get(fold(ad)) || {}).c || '';
        c = canonCamp.get(fold(cc)) || cc;
        if (!s) { const combo = adToCombo.get(fold(ad)); if (combo) s = canonSet.get(fold(combo.s)) || combo.s; }
        sckAttributed++;
      }
      // 2) Fallback UTM se a SCK não resolveu o anúncio.
      if (!ad) {
        const uCamp = stripId(rawCamp), uSet = stripId(rawMed), uAd = cleanContent(rawCont);
        c  = canonCamp.get(fold(uCamp)) || (isUtm(uCamp) ? uCamp : '');
        s  = s || canonSet.get(fold(uSet)) || (isUtm(uSet) ? uSet : '');
        ad = canonAd.get(fold(uAd)) || '';
        if (ad && (!c || !s)) {
          const combo = adToCombo.get(fold(ad));
          if (combo) { if (!c) c = canonCamp.get(fold(combo.c)) || combo.c; if (!s) s = canonSet.get(fold(combo.s)) || combo.s; }
        }
      }
      m = ad ? 'ad' : s ? 'adset' : c ? 'campaign' : (hasUtm ? 'unmatched' : 'none');
      trafficSales++;
      attribution[m]++;
    } else if (isUtm(rawSrc)) {
      src = fold(rawSrc);   // keep a real non-Meta source label (organico/direto/…)
    }
    sales.push({ d, v: Math.round(value * 100) / 100, src, m, c, s, a: ad });
  }
  const salesRows = sales.length;

  // ---------------- Output (reference data.json contract) ----------------
  const allDates = [...ads.map((x) => x.d), ...sales.map((x) => x.d)].sort();
  const now = new Date();
  const nowBR = now.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(',', '');

  const warnings = [];
  warnings.push(`Gasto da conta em USD → convertido para BRL a câmbio ×${fxInfo.fx.toFixed(4)} (${fxInfo.source}${fxInfo.date ? ', ' + fxInfo.date : ''}). Sem imposto.`);
  if (sckAttributed > 0) warnings.push(`${sckAttributed} venda(s) de tráfego atribuídas ao CRIATIVO pela coluna SCK (utm_content vem errado nesta conta).`);
  if (!hasValueCol) warnings.push(`Receita estimada por regra do cliente: cada venda vale R$ ${FALLBACK_TICKET.toFixed(2)} (a aba "${SALES_TAB}" não tem coluna de valor). Adicione uma coluna "Valor da Compra" para usar o valor real de cada venda.`);
  if (attribution.none > 0)      warnings.push(`${attribution.none} venda(s) de tráfego sem UTM — contam na receita, mas ficam em "Não atribuído".`);
  if (attribution.unmatched > 0) warnings.push(`${attribution.unmatched} venda(s) com UTM que não existe na planilha de anúncios (período fora da janela, outra conta ou UTM digitada errada).`);
  if (attribution.adset + attribution.campaign > 0) warnings.push(`${attribution.adset + attribution.campaign} venda(s) casaram só até conjunto/campanha, não até o anúncio.`);
  const nonTraffic = salesRows - trafficSales;
  if (nonTraffic > 0) warnings.push(`${nonTraffic} venda(s) fora do tráfego (utm_source ≠ Meta) — orgânico/direto; entram só como referência, não no funil/CAC/ROAS.`);

  const out = {
    meta: {
      title: 'WOP-AGO26 — Meta Ads',
      platform: 'Meta Ads',
      traffic_source: 'meta-ads',
      tax: TAX_RATE,
      currency: 'BRL',
      spend_currency: 'USD',
      fx: Math.round(fxInfo.fx * 1e6) / 1e6,
      fx_date: fxInfo.date,
      fx_source: fxInfo.source,
      generated_at: now.toISOString(),
      generated_at_br: nowBR,
      date_min: allDates[0] || null,
      date_max: allDates[allDates.length - 1] || null,
      ads_url: ADS_URL,
      sales_url: BUYERS_URL,
      sales_tab: SALES_TAB,
      counts: {
        ads_rows: ads.length,
        sales_rows: salesRows,
        traffic_sales: trafficSales,
        attribution,
      },
      warnings,
    },
    ads,
    sales,
  };

  mkdirSync('public', { recursive: true });
  writeFileSync('public/data.json', JSON.stringify(out));

  // Cache-bust: stamp the current build id into index.html.
  try {
    const buildId = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    let html = readFileSync('public/index.html', 'utf8');
    html = html.replace(/const BUILD_ID = "[^"]*";/, `const BUILD_ID = "${buildId}";`);
    writeFileSync('public/index.html', html);
  } catch (e) { console.warn('BUILD_ID stamp skipped:', e.message); }

  console.log('Wrote public/data.json', out.meta.counts, out.meta.date_min, '→', out.meta.date_max);
  if (ads.length === 0) throw new Error('No ad rows parsed — aborting so the previous deploy is kept.');
})().catch((err) => { console.error(err); process.exit(1); });
