// List every analysis under analyses/ in one table: analyses/INDEX.md and analyses/index.json.
// Run: bun radiant/tools/examples/stock-analysis/index.ts [ANALYSES_DIR]
// Reads summary.json (written by the analysis) and verification.json (written after the independent check), where present.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? new URL('../../../../analyses', import.meta.url).pathname);
const read = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const order: string[] = (read(join(root, 'companies.json'))?.companies ?? []).map((c: { ticker: string }) => c.ticker);
const names = new Map<string, string>((read(join(root, 'companies.json'))?.companies ?? []).map((c: { ticker: string; company: string }) => [c.ticker, c.company]));
const folders = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory());
const tickers = [...new Set([...order, ...folders])];
const money = (v: unknown, currency = 'USD') => typeof v === 'number' ? (currency === 'USD' ? '$' : currency + ' ') + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
const pct = (v: unknown) => typeof v === 'number' ? (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%' : '';
const cell = (text: unknown) => String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

const rows = tickers.map((ticker, i) => {
  const dir = join(root, ticker), summary = read(join(dir, 'summary.json')), check = read(join(dir, 'verification.json'));
  const map = join(dir, ticker + '-fundamental-analysis.radiant.zip');
  const state = !existsSync(dir) ? 'not started' : !existsSync(map) ? 'no map yet' : !summary ? 'map built, no summary' : 'done';
  return { rank: order.indexOf(ticker) >= 0 ? order.indexOf(ticker) + 1 : i + 1, ticker, company: summary?.company ?? names.get(ticker) ?? '', state,
    decision: summary?.decision ?? '', price: summary?.price ?? null, currency: summary?.priceCurrency ?? 'USD', value: summary?.weightedValue ?? null,
    marginOfSafety: summary?.marginOfSafety ?? null, latestPeriod: summary?.latestPeriod ?? '', asOf: summary?.asOf ?? '', oneLine: summary?.oneLine ?? '',
    redFlags: summary?.redFlags ?? [], verdict: check?.verdict ?? '', corrections: check?.corrections?.length ?? null, unresolved: check?.unresolved ?? [],
    map: existsSync(map) ? ticker + '/' + ticker + '-fundamental-analysis.radiant.zip' : '' };
});
const done = rows.filter((r) => r.state === 'done');
const byMargin = [...done].sort((a, b) => (b.marginOfSafety ?? -9) - (a.marginOfSafety ?? -9));
const table = (list: typeof rows) => ['| # | Ticker | Company | Decision | Price | Value | Margin of safety | Check | Conclusion |', '|---|---|---|---|---|---|---|---|---|',
  ...list.map((r) => '| ' + [r.rank, r.map ? '[' + r.ticker + '](' + r.map + ')' : r.ticker, cell(r.company), cell(r.decision), money(r.price, r.currency), money(r.value, r.currency), pct(r.marginOfSafety),
    cell(r.verdict + (r.corrections ? ' (' + r.corrections + ' fixed)' : '') + (r.unresolved.length ? ', ' + r.unresolved.length + ' open' : '')), cell(r.oneLine)].join(' | ') + ' |')].join('\n');
const pending = rows.filter((r) => r.state !== 'done');
const text = ['# Fundamental analyses', '',
  done.length + ' of ' + rows.length + ' companies analysed. Each row links to a Radiant map (open it with File > Open). Value is the probability-weighted estimate per share; margin of safety is 1 − price / value, so a positive figure means the price is below the estimate. Analysis from public filings; not investment advice.', '',
  '## By margin of safety', '', table(byMargin), '',
  ...(pending.length ? ['## Not finished', '', ...pending.map((r) => '- ' + r.ticker + ' ' + cell(r.company) + ': ' + r.state), ''] : []),
  '## Open questions from the independent check', '', ...(done.some((r) => r.unresolved.length) ? done.filter((r) => r.unresolved.length).flatMap((r) => ['- **' + r.ticker + '**: ' + r.unresolved.map(cell).join('; ')]) : ['None recorded.']), ''].join('\n');
writeFileSync(join(root, 'INDEX.md'), text);
writeFileSync(join(root, 'index.json'), JSON.stringify(rows, null, 2) + '\n');
console.log('Wrote ' + join(root, 'INDEX.md') + ': ' + done.length + ' done, ' + pending.length + ' not finished.');
