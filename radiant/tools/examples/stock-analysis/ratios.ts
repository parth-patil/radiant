// Ratio and valuation maths for a stock analysis, so that no figure in the map comes from mental arithmetic.
// Run: bun tools/examples/stock-analysis/ratios.ts DIR      (DIR holds facts.json; writes metrics.json there)
// facts.json: { company, ticker, currency, unit, years: [oldest … latest], ttm?, market: { date, price, sharesOutstanding }, assumptions }
// Money fields are in one unit (say USD millions); shares in the same unit (millions); capex, dividends, buybacks,
// acquisitions and debtRepaid are positive numbers. A missing input makes the figures that need it null.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Num = number | null;
type Row = Record<string, unknown>;
const dir = process.argv[2];
if (!dir) { console.error('Usage: ratios.ts DIR (the folder holding facts.json)'); process.exit(2); }
const facts = JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf8')) as { years?: Row[]; ttm?: Row; market?: Row; assumptions?: Row } & Row;
const years = facts.years ?? [];
const problems: string[] = [];
if (years.length < 3) problems.push('facts.years has fewer than three fiscal years; trends need at least five.');

const n = (v: unknown): Num => typeof v === 'number' && Number.isFinite(v) ? v : null;
const div = (a: Num, b: Num): Num => a === null || b === null || b === 0 ? null : a / b;
const sub = (a: Num, b: Num): Num => a === null || b === null ? null : a - b;
const add = (a: Num, b: Num): Num => a === null || b === null ? null : a + b;
const mul = (a: Num, b: Num): Num => a === null || b === null ? null : a * b;
const mean = (a: Num, b: Num): Num => a === null ? null : b === null ? a : (a + b) / 2;
const round = (v: Num, places = 4): Num => v === null ? null : Number(v.toFixed(places));
const cagr = (first: Num, last: Num, periods: number): Num => first === null || last === null || first <= 0 || last <= 0 || periods < 1 ? null : Math.pow(last / first, 1 / periods) - 1;

function derive(y: Row, p: Row | undefined) {
  const revenue = n(y.revenue), cogs = n(y.costOfRevenue) ?? sub(revenue, n(y.grossProfit));
  const grossProfit = n(y.grossProfit) ?? sub(revenue, cogs);
  const op = n(y.operatingIncome), ni = n(y.netIncome), da = n(y.depreciationAmortization);
  const taxRate = div(n(y.incomeTax), n(y.pretaxIncome));
  const ebitda = add(op, da);
  const cash = n(y.cashAndInvestments), debt = n(y.totalDebt), equity = n(y.equity), assets = n(y.totalAssets);
  const netDebt = sub(debt, cash);
  const cfo = n(y.operatingCashFlow), capex = n(y.capex), sbc = n(y.stockComp), shares = n(y.dilutedShares);
  const fcf = sub(cfo, capex);
  const receivableDays = mul(div(n(y.receivables), revenue), 365), inventoryDays = mul(div(n(y.inventory), cogs), 365), payableDays = mul(div(n(y.payables), cogs), 365);
  const invested = sub(add(debt, equity), cash), investedPrev = p ? sub(add(n(p.totalDebt), n(p.equity)), n(p.cashAndInvestments)) : null;
  const nopat = taxRate === null ? null : mul(op, 1 - taxRate);
  const nopatPrev = p ? (() => { const t = div(n(p.incomeTax), n(p.pretaxIncome)); return t === null ? null : mul(n(p.operatingIncome), 1 - t); })() : null;
  const avgEquity = mean(equity, p ? n(p.equity) : null), avgAssets = mean(assets, p ? n(p.totalAssets) : null);
  const revenueGrowth = p ? sub(div(revenue, n(p.revenue)), 1) : null;
  const receivablesGrowth = p ? sub(div(n(y.receivables), n(p.receivables)), 1) : null;
  const out: Record<string, Num | string> = {
    label: String(y.label ?? ''),
    revenue, revenueGrowth, grossProfit, grossMargin: div(grossProfit, revenue), operatingIncome: op, operatingMargin: div(op, revenue),
    netIncome: ni, netMargin: div(ni, revenue), taxRate, ebitda, dilutedEps: n(y.dilutedEps) ?? div(ni, shares), dilutedShares: shares,
    shareCountChange: p ? sub(div(shares, n(p.dilutedShares)), 1) : null,
    stockComp: sbc, stockCompToRevenue: div(sbc, revenue),
    cashAndInvestments: cash, totalDebt: debt, netDebt, netDebtToEbitda: div(netDebt, ebitda), interestCoverage: div(op, n(y.interestExpense)),
    currentRatio: div(n(y.currentAssets), n(y.currentLiabilities)), quickRatio: div(add(cash, n(y.receivables)), n(y.currentLiabilities)),
    receivableDays, inventoryDays, payableDays, cashConversionCycle: sub(add(inventoryDays, receivableDays), payableDays),
    goodwillAndIntangiblesToAssets: div(add(n(y.goodwill) ?? 0, n(y.intangibles) ?? 0), assets),
    bookValuePerShare: div(equity, shares), retainedEarnings: n(y.retainedEarnings),
    operatingCashFlow: cfo, cashConversion: div(cfo, ni), capex, capexToRevenue: div(capex, revenue), capexToDepreciation: div(capex, da),
    freeCashFlow: fcf, fcfMargin: div(fcf, revenue), fcfPerShare: div(fcf, shares), fcfAfterStockComp: sub(fcf, sbc),
    dividends: n(y.dividends), buybacks: n(y.buybacks), acquisitions: n(y.acquisitions), debtRepaid: n(y.debtRepaid),
    shareholderReturnsToFcf: div(add(n(y.dividends) ?? 0, n(y.buybacks) ?? 0), fcf),
    roe: div(ni, avgEquity), assetTurnover: div(revenue, avgAssets), financialLeverage: div(avgAssets, avgEquity),
    investedCapital: invested, nopat, roic: div(nopat, mean(invested, investedPrev)),
    reinvestmentRate: div(sub(invested, investedPrev), nopat), returnOnNewInvestment: div(sub(nopat, nopatPrev), sub(invested, investedPrev)),
    accrualsRatio: div(sub(ni, cfo), avgAssets), receivablesGrowth, receivablesGrowthMinusRevenueGrowth: sub(receivablesGrowth, revenueGrowth)
  };
  for (const key of Object.keys(out)) if (typeof out[key] === 'number') out[key] = round(out[key] as number);
  return out;
}

const perYear = years.map((y, i) => derive(y, years[i - 1]));
const first = perYear[0], last = perYear[perYear.length - 1];
const span = perYear.length - 1;
const average = (key: string): Num => { const v = perYear.map((y) => y[key]).filter((x): x is number => typeof x === 'number'); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
const trends = first && last ? {
  span: (first.label as string) + ' to ' + (last.label as string), periods: span,
  revenueCagr: round(cagr(first.revenue as Num, last.revenue as Num, span)), netIncomeCagr: round(cagr(first.netIncome as Num, last.netIncome as Num, span)),
  epsCagr: round(cagr(first.dilutedEps as Num, last.dilutedEps as Num, span)), fcfCagr: round(cagr(first.freeCashFlow as Num, last.freeCashFlow as Num, span)),
  shareCountCagr: round(cagr(first.dilutedShares as Num, last.dilutedShares as Num, span)),
  averageGrossMargin: average('grossMargin'), averageOperatingMargin: average('operatingMargin'), averageFcfMargin: average('fcfMargin'),
  averageRoe: average('roe'), averageRoic: average('roic'), averageCashConversion: average('cashConversion'), averageTaxRate: average('taxRate')
} : null;

// ---------------------------------------------------------------- valuation
const market = facts.market ?? {}, assume = (facts.assumptions ?? {}) as Row;
const basisRow = facts.ttm ? { ...years[years.length - 1], ...facts.ttm } : years[years.length - 1];
const basis = basisRow ? derive(basisRow, years[years.length - (facts.ttm ? 1 : 2)]) : null;
const price = n(market.price), sharesOut = n(market.sharesOutstanding) ?? (basis ? basis.dilutedShares as Num : null);
const marketCap = mul(price, sharesOut);
let valuation: Record<string, unknown> | null = null;
if (!basis || price === null || sharesOut === null) problems.push('market.price and market.sharesOutstanding are needed for valuation.');
else {
  const cash = basis.cashAndInvestments as Num, debt = basis.totalDebt as Num;
  const ev = sub(add(marketCap, debt), cash);
  const eps = basis.dilutedEps as Num, pe = div(price, eps);
  const expected = n(assume.expectedEpsGrowth);
  const dps = div(basis.dividends as Num, sharesOut);
  const scenarioInput = (assume.scenarios ?? {}) as Record<string, Row>;
  const wacc = n(assume.wacc), terminalGrowth = n(assume.terminalGrowth), horizon = n(assume.forecastYears) ?? 10;
  // Revenue growth per forecast year. "growth" lists explicit rates for the first years (guidance, consensus); after
  // them, or from "startGrowth" when there are none, growth fades in a straight line to "endGrowth" in the last year.
  const growthPath = (s: Row): number[] | null => {
    const explicit = Array.isArray(s.growth) ? (s.growth as unknown[]).map(n).filter((v): v is number => v !== null).slice(0, horizon) : [];
    const from = explicit.length ? explicit[explicit.length - 1] : n(s.startGrowth), endGrowth = n(s.endGrowth);
    if (from === null || endGrowth === null) return null;
    const rest = horizon - explicit.length;
    return Array.from({ length: horizon }, (_, i) => i < explicit.length ? explicit[i]
      : explicit.length ? from + (endGrowth - from) * ((i - explicit.length + 1) / rest)
      : from + (endGrowth - from) * (horizon === 1 ? 0 : i / (horizon - 1)));
  };
  const dcf = (s: Row, w: number, g: number, growthScale = 1) => {
    const growth = growthPath(s), startMargin = n(s.fcfMargin) ?? n(s.startFcfMargin), endMargin = n(s.endFcfMargin) ?? startMargin;
    const revenue0 = basis.revenue as Num;
    if (growth === null || startMargin === null || endMargin === null || revenue0 === null || w <= g) return null;
    let revenue = revenue0, pv = 0, fcf = 0;
    const path: { year: number; growth: number; revenue: number; fcf: number }[] = [];
    for (let t = 1; t <= horizon; t++) {
      const k = horizon === 1 ? 0 : (t - 1) / (horizon - 1);
      revenue *= 1 + growth[t - 1] * growthScale;
      fcf = revenue * (startMargin + (endMargin - startMargin) * k);
      pv += fcf / Math.pow(1 + w, t);
      path.push({ year: t, growth: round(growth[t - 1] * growthScale) as number, revenue: Math.round(revenue), fcf: Math.round(fcf) });
    }
    const terminal = fcf * (1 + g) / (w - g), terminalPv = terminal / Math.pow(1 + w, horizon);
    const enterprise = pv + terminalPv, equityValue = enterprise + (cash ?? 0) - (debt ?? 0);
    return { enterpriseValue: Math.round(enterprise), terminalShare: round(terminalPv / enterprise), equityValue: Math.round(equityValue), valuePerShare: round(equityValue / sharesOut, 2), path };
  };
  const scenarios: Record<string, unknown> = {};
  let weighted = 0, weight = 0;
  if (wacc === null || terminalGrowth === null) problems.push('assumptions.wacc and assumptions.terminalGrowth are needed for the DCF.');
  else for (const [name, s] of Object.entries(scenarioInput)) {
    const result = dcf(s, wacc, terminalGrowth);
    if (!result) { problems.push('scenario "' + name + '" needs startGrowth (or growth), endGrowth and startFcfMargin.'); continue; }
    const probability = n(s.probability);
    scenarios[name] = { ...s, valuePerShare: result.valuePerShare, enterpriseValue: result.enterpriseValue, equityValue: result.equityValue, terminalShare: result.terminalShare,
      revenueCagr: round(cagr(basis.revenue as Num, result.path[result.path.length - 1].revenue, horizon)),
      finalYearRevenue: result.path[result.path.length - 1].revenue, finalYearFcf: result.path[result.path.length - 1].fcf, path: result.path };
    if (probability !== null) { weighted += probability * (result.valuePerShare as number); weight += probability; }
  }
  const base = scenarioInput.base;
  let sensitivity: unknown = null, reverse: unknown = null;
  if (base && wacc !== null && terminalGrowth !== null) {
    sensitivity = [-0.01, 0, 0.01].map((dw) => ({ wacc: round(wacc + dw), values: [-0.01, 0, 0.01].map((dg) => ({ terminalGrowth: round(terminalGrowth + dg), valuePerShare: dcf(base, wacc + dw, terminalGrowth + dg)?.valuePerShare ?? null })) }));
    // Reverse DCF: scale every year's base-case growth by one factor until value equals price.
    let lo = 0, hi = 6;
    const at = (scale: number) => dcf(base, wacc, terminalGrowth, scale)?.valuePerShare as number | undefined;
    const low = at(lo), high = at(hi);
    if (low !== undefined && high !== undefined && low <= price && high >= price) {
      for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if ((at(mid) as number) < price) lo = mid; else hi = mid; }
      const scale = (lo + hi) / 2, implied = dcf(base, wacc, terminalGrowth, scale)!;
      const endRevenue = implied.path[implied.path.length - 1].revenue;
      reverse = { growthScale: round(scale), impliedFirstYearGrowth: implied.path[0].growth, impliedRevenueCagr: round(cagr(basis.revenue as Num, endRevenue, horizon)),
        baseCaseRevenueCagr: round(cagr(basis.revenue as Num, dcf(base, wacc, terminalGrowth)!.path[horizon - 1].revenue, horizon)), impliedFinalYearRevenue: endRevenue,
        reading: 'With the base case margins and discount rate, the price is justified if revenue growth in every forecast year is growthScale times the base case. Compare impliedRevenueCagr with baseCaseRevenueCagr.' };
    } else reverse = { growthScale: null, reading: low !== undefined && low > price ? 'The price is below the value of the business with no growth at all, on the base case margins.' : 'The price is above what six times the base case growth would justify.' };
  }
  const weightedValue = weight > 0 ? round(weighted / weight, 2) : null;
  const baseValue = (scenarios.base as { valuePerShare?: number } | undefined)?.valuePerShare ?? null;
  const costOfEquity = n(assume.costOfEquity), dividendGrowth = n(assume.dividendGrowth);
  valuation = {
    basis: facts.ttm ? 'trailing twelve months' : 'latest fiscal year (' + (basis.label as string) + ')', date: market.date ?? null, price, sharesOutstanding: sharesOut,
    marketCap: round(marketCap, 0), enterpriseValue: round(ev, 0),
    priceToEarnings: round(pe, 2), pegRatio: expected === null ? null : round(div(pe, expected * 100), 2), evToEbitda: round(div(ev, basis.ebitda as Num), 2),
    priceToFreeCashFlow: round(div(marketCap, basis.freeCashFlow as Num), 2), fcfYield: round(div(basis.freeCashFlow as Num, marketCap)),
    priceToBook: round(div(marketCap, n(basisRow.equity)), 2), evToSales: round(div(ev, basis.revenue as Num), 2),
    dividendPerShare: round(dps, 4), dividendYield: round(div(dps, price)),
    dividendDiscountValue: dps && costOfEquity !== null && dividendGrowth !== null && costOfEquity > dividendGrowth ? round(dps * (1 + dividendGrowth) / (costOfEquity - dividendGrowth), 2) : null,
    discountRate: wacc, terminalGrowth, forecastYears: horizon, scenarios, sensitivity, reverseDcf: reverse,
    probabilityWeightedValue: weightedValue,
    marginOfSafetyVsWeighted: weightedValue === null ? null : round(1 - price / weightedValue), marginOfSafetyVsBase: baseValue === null ? null : round(1 - price / baseValue)
  };
}

const metrics = { company: facts.company ?? null, ticker: facts.ticker ?? null, currency: facts.currency ?? null, unit: facts.unit ?? null, problems, trends, perYear, basis, valuation };
writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
const pct = (v: unknown) => typeof v === 'number' ? (v * 100).toFixed(1) + '%' : 'n/a';
console.log('Wrote ' + join(dir, 'metrics.json'));
console.log('Years: ' + perYear.map((y) => y.label).join(', '));
if (trends) console.log('Revenue CAGR ' + pct(trends.revenueCagr) + ' · average ROIC ' + pct(trends.averageRoic) + ' · average FCF margin ' + pct(trends.averageFcfMargin));
if (valuation) console.log('P/E ' + valuation.priceToEarnings + ' · EV/EBITDA ' + valuation.evToEbitda + ' · weighted value per share ' + valuation.probabilityWeightedValue + ' · margin of safety ' + pct(valuation.marginOfSafetyVsWeighted));
for (const problem of problems) console.log('PROBLEM ' + problem);
