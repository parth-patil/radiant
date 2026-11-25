// Content of the "Fundamental analysis of a stock" map, as agent ops. Shared by the offline check and the live run.
type N = { label: string; id?: string; note?: string; sticker?: string; side?: 'left' | 'right'; children?: N[] };
const n = (label: string, a: string | Omit<N, 'label' | 'children'> | N[] = [], children: N[] = []): N =>
  Array.isArray(a) ? { label, children: a } : typeof a === 'string' ? { label, note: a, children } : { label, ...a, children };
const leaves = (...labels: string[]): N[] => labels.map((label) => ({ label }));

export const ROOT = { text: 'Fundamental analysis of a stock', sticker: '📈',
  note: 'Goal: estimate what a business is worth and compare that with its price. Work through the nine branches in order: understand, read, measure, value, decide.' };

export const BRANCHES: N[] = [
  n('1 Understand the business', { id: 'business', side: 'right', sticker: '🏢', note: 'If you cannot explain how the company earns money in two sentences, stop here.' }, [
    n('What it sells', leaves('Products and segments', 'Revenue by segment', 'Recurring vs one-time sales')),
    n('How it makes money', { id: 'model' }, [
      n('Price × volume drivers'),
      n('Unit economics', 'Profit per customer or per unit: lifetime value against the cost to win the customer.'),
      n('Fixed vs variable costs') ]),
    n('Customers', [
      n('Who buys and why'),
      n('Customer concentration', 'One customer above 10% of sales is a risk worth naming.'),
      n('Retention and churn') ]),
    n('Industry', { id: 'industry' }, leaves('Market size and growth', 'Cyclical or steady', 'Rivals and market share', 'Regulation')),
    n('Competitive moat', { id: 'moat', note: 'A moat is the reason profits are not competed away. The evidence is high returns on capital held for many years.' },
      leaves('Brand', 'Network effects', 'Switching costs', 'Cost or scale advantage', 'Patents and licences')),
    n('Management', { id: 'mgmt' }, [
      n('Track record'),
      n('Capital allocation', 'What they do with spare cash: reinvest, acquire, repay debt, pay dividends or buy back shares.'),
      n('Insider ownership'),
      n('Pay tied to returns') ]) ]),
  n('2 Read the filings', { id: 'filings', side: 'right', sticker: '📄', note: 'Primary sources first. Read the company before you read opinions about it.' }, [
    n('Annual report (10-K)', { id: 'annual' }, [
      n('Business description'), n('Risk factors'), n('Management discussion (MD&A)'),
      n('Notes to the accounts', 'Where the accounting choices live: revenue recognition, leases, pensions, segment detail.') ]),
    n('Quarterly report (10-Q)'),
    n('Earnings call and slides', 'Listen for what analysts keep asking about, and for changes in tone or guidance.'),
    n('Proxy statement', leaves('Executive pay', 'Share ownership')),
    n('Read five years back', 'Compare what management promised with what happened.') ]),
  n('3 Income statement', { id: 'income', side: 'right', sticker: '💵', note: 'What the company earned over a period.' }, [
    n('Revenue', { id: 'revenue' }, leaves('Growth rate over 5 years', 'Organic vs acquired growth', 'Price vs volume')),
    n('Gross margin', 'Gross profit ÷ revenue. Shows pricing power and the cost of making the product.'),
    n('Operating margin', { id: 'opmargin', note: 'Operating profit ÷ revenue. A margin that rises as sales rise shows operating leverage.' }),
    n('Net income', { id: 'netincome' }, [
      n('One-off items'),
      n('Adjusted vs reported', 'Be wary when adjusted profit is always higher than reported profit.'),
      n('Tax rate') ]),
    n('Earnings per share', { id: 'eps' }, leaves('Share count trend', 'Dilution from stock pay', 'Buybacks')) ]),
  n('4 Balance sheet', { id: 'balance', side: 'right', sticker: '⚖️', note: 'What the company owns and owes on one day.' }, [
    n('Liquidity', [
      n('Cash and equivalents'),
      n('Current ratio', 'Current assets ÷ current liabilities. Above 1 means short-term bills are covered.'),
      n('Quick ratio', '(Cash + receivables) ÷ current liabilities.') ]),
    n('Debt', { id: 'debt' }, [
      n('Net debt to EBITDA', '(Debt − cash) ÷ EBITDA. Above 3 deserves a hard look in most industries.'),
      n('Interest coverage', 'Operating profit ÷ interest expense. Below 3 leaves little room for a bad year.'),
      n('Maturity schedule'),
      n('Fixed vs floating rate') ]),
    n('Working capital', { id: 'wc' }, [
      n('Receivable days'), n('Inventory days'), n('Payable days'),
      n('Cash conversion cycle', 'Inventory days + receivable days − payable days. Shorter is better.') ]),
    n('Asset quality', leaves('Goodwill and intangibles', 'Write-down history')),
    n('Equity', leaves('Book value per share', 'Retained earnings')) ]),
  n('5 Cash flow', { id: 'cash', side: 'left', sticker: '💧', note: 'Cash is harder to flatter than profit. Trust it more.' }, [
    n('Operating cash flow', { id: 'ocf' }, [
      n('Cash conversion', 'Operating cash flow ÷ net income. Near or above 1 over several years is healthy.'),
      n('Working capital swings') ]),
    n('Capital spending', { id: 'capex' }, leaves('Maintenance capex', 'Growth capex')),
    n('Free cash flow', { id: 'fcf', note: 'Operating cash flow − capital spending. The cash owners could take out each year.' }, [
      n('FCF margin'), n('FCF per share'),
      n('Stock pay as a cost', 'Stock-based pay is added back in the cash flow statement, but it is a real cost to owners.') ]),
    n('Uses of cash', { id: 'uses' }, leaves('Dividends', 'Buybacks', 'Acquisitions', 'Debt repayment')) ]),
  n('6 Quality and returns', { id: 'quality', side: 'left', sticker: '⭐', note: 'Good businesses earn high returns on the money put into them, year after year.' }, [
    n('Return on equity', { id: 'roe', note: 'Net income ÷ shareholders’ equity. Split it three ways (DuPont) to see what drives it.' },
      leaves('Net margin', 'Asset turnover', 'Financial leverage')),
    n('Return on invested capital', { id: 'roic', note: 'After-tax operating profit ÷ (debt + equity − cash). Compare it with the cost of capital.' },
      leaves('ROIC above cost of capital', 'Trend over ten years')),
    n('Growth quality', leaves('Reinvestment rate', 'Return on new investment')),
    n('Earnings quality', { id: 'equality' }, [
      n('Accruals', 'Profit far above cash flow for years is a warning.'),
      n('Receivables vs sales growth'),
      n('Capitalised costs') ]),
    n('Compare with peers') ]),
  n('7 Valuation', { id: 'valuation', side: 'left', sticker: '🏷️', note: 'Price is what you pay; value is what the business is worth. Estimate value several ways.' }, [
    n('Multiples', { id: 'multiples', note: 'Quick and relative. Compare with peers and with the company’s own history.' }, [
      n('Price to earnings (P/E)'),
      n('PEG ratio', 'P/E ÷ expected growth rate.'),
      n('EV to EBITDA', 'Enterprise value = market value + debt − cash.'),
      n('Price to free cash flow'), n('Price to book'), n('EV to sales') ]),
    n('Discounted cash flow', { id: 'dcf', note: 'Value = the sum of future free cash flows, each discounted back to today.' },
      leaves('Forecast free cash flow', 'Discount rate (WACC)', 'Terminal value', 'Sensitivity table')),
    n('Reverse DCF', 'Ask what growth the current price already assumes, then judge whether that is likely.'),
    n('Dividend discount model'),
    n('Sum of the parts'),
    n('Margin of safety', { id: 'mos', note: 'Buy only when the price is well below your estimate, so that mistakes are affordable.' }) ]),
  n('8 Risks and red flags', { id: 'risks', side: 'left', sticker: '🚩', note: 'Look for reasons not to buy before you look for reasons to buy.' }, [
    n('Business risks', leaves('Disruption', 'Regulation and lawsuits', 'Cyclical demand', 'Key supplier or customer')),
    n('Financial risks', { id: 'finrisk' }, leaves('High leverage', 'Refinancing wall', 'Currency and rates')),
    n('Accounting red flags', { id: 'redflags' }, leaves('Profit up, cash down', 'Frequent one-off charges', 'Auditor or CFO changes', 'Aggressive revenue recognition')),
    n('Governance', leaves('Related-party deals', 'Dual-class shares', 'Heavy dilution')) ]),
  n('9 Decide and monitor', { id: 'decide', side: 'left', sticker: '✅', note: 'Write the decision down so you can check it later against what happened.' }, [
    n('Investment thesis', { id: 'thesis', note: 'Three reasons to own it, written before you buy.' }, leaves('What must go right', 'What the market misses')),
    n('Scenarios', { id: 'scenarios' }, leaves('Bear case', 'Base case', 'Bull case', 'Probability-weighted value')),
    n('Position size', 'Size by how wrong you could be, not by how sure you feel.'),
    n('Catalysts'),
    n('Sell rules', { id: 'sell' }, leaves('Thesis broken', 'Price above value', 'Better idea found')),
    n('Track each quarter', leaves('Key numbers vs thesis', 'Decision journal')) ])
];

export const LINKS = [
  { from: 'model', to: 'revenue', label: 'drives' },
  { from: 'fcf', to: 'dcf', label: 'feeds the model' },
  { from: 'equality', to: 'redflags', label: 'check', dash: 'dashed' }
];

export const count = (nodes: N[]): number => nodes.reduce((sum, node) => sum + 1 + count(node.children ?? []), 0);

/** Phase 1: the tree and its cross-links, on an existing root. */
export function treeOps(rootId: string, reuseRoot: boolean) {
  const ops: Record<string, unknown>[] = [];
  let root = rootId;
  if (reuseRoot) {
    ops.push({ op: 'set-text', id: rootId, text: ROOT.text }, { op: 'set-note', id: rootId, note: ROOT.note }, { op: 'set', id: rootId, patch: { sticker: ROOT.sticker } },
      { op: 'doc', title: ROOT.text, theme: 'daylight' });
  } else {
    ops.push({ op: 'add-root', text: ROOT.text, note: ROOT.note, layout: 'mindmap', ref: 'root' }, { op: 'set', id: '@root', patch: { sticker: ROOT.sticker } });
    root = '@root';
  }
  for (const { side, ...branch } of BRANCHES) {
    ops.push({ op: 'add-tree', parent: root, spec: branch });
    // add-tree ignores "side" on the top node of a fragment, so it is set afterwards.
    if (side && branch.id) ops.push({ op: 'set', id: branch.id, patch: { side } });
  }
  for (const link of LINKS) ops.push({ op: 'link', ...link, arrows: 'end' });
  return ops;
}

/** Phase 2: sketch elements around the map, placed from its bounds (centre x, top and bottom edges). */
export function canvasOps(b: { x: number; y: number; w: number; h: number }) {
  const ops: Record<string, unknown>[] = [];
  const add = (ref: string, element: Record<string, unknown>) => ops.push({ op: 'canvas-add', ref, element: { roughness: 1, ...element } });
  const cx = b.x + b.w / 2;
  // --- the workflow strip above the map
  const steps = [['Understand', '1 and 2', '#2B7DE9', '#CDE7FD'], ['Read the numbers', '3, 4 and 5', '#12A07C', '#C9F0E2'], ['Judge quality', '6', '#8A5CF5', '#E2D8FD'],
    ['Value it', '7', '#F08C00', '#FFE8BF'], ['Decide', '8 and 9', '#E8478B', '#FBD3E3']];
  const bw = 210, bh = 96, gap = 70, stripW = steps.length * bw + (steps.length - 1) * gap + 120, top = b.y - 360;
  add('flow', { kind: 'frame', x: cx - stripW / 2, y: top, w: stripW, h: 250, text: 'The path through the map' });
  steps.forEach(([label, branches, stroke, fill], i) => {
    const x = cx - stripW / 2 + 60 + i * (bw + gap);
    add('s' + i, { kind: 'rect', x, y: top + 70, w: bw, h: bh, stroke, fill, fillStyle: 'hachure', round: true, text: label, frame: '@flow' });
    add('t' + i, { kind: 'text', x: x, y: top + 70 + bh + 14, w: bw, h: 24, text: 'branches ' + branches, font: 'hand', fontSize: 16, align: 'center', frame: '@flow' });
    if (i) add('a' + i, { kind: 'arrow', from: '@s' + (i - 1), to: '@s' + i, stroke: '#495057', frame: '@flow' });
  });
  // --- formulas below the map
  const notes = [['Free cash flow', '= Operating cash flow\n− Capital spending', '#FFF3BF'], ['ROIC', '= After-tax operating profit\n/ Invested capital', '#D3F9D8'],
    ['Enterprise value', '= Market value\n+ Debt − Cash', '#D0EBFF'], ['ROE (DuPont)', '= Net margin\n× Asset turnover\n× Leverage', '#E5DBFF'],
    ['Margin of safety', '= 1 − Price / Value', '#FFE3E3']];
  const nw = 262, nh = 170, ngap = 36, rowW = notes.length * nw + (notes.length - 1) * ngap + 100, bottom = b.y + b.h + 130;
  const left = cx - (rowW + 620) / 2;
  add('formulas', { kind: 'frame', x: left, y: bottom, w: rowW, h: nh + 120, text: 'Formulas worth keeping' });
  notes.forEach(([title, body, fill], i) => add('f' + i, { kind: 'note', x: left + 50 + i * (nw + ngap), y: bottom + 70, w: nw, h: nh, fill, text: title + '\n' + body, font: 'hand', fontSize: 17, frame: '@formulas' }));
  // --- the decision sketch beside the formulas
  const dx = left + rowW + 60;
  add('decision', { kind: 'frame', x: dx, y: bottom, w: 560, h: nh + 120, text: 'The decision' });
  add('q', { kind: 'diamond', x: dx + 40, y: bottom + 75, w: 220, h: 160, stroke: '#F08C00', fill: '#FFE8BF', fillStyle: 'hachure', text: 'Price well\nbelow value?', frame: '@decision' });
  add('yes', { kind: 'rect', x: dx + 350, y: bottom + 66, w: 170, h: 70, stroke: '#12A07C', fill: '#C9F0E2', fillStyle: 'hachure', round: true, text: 'Buy in stages', frame: '@decision' });
  add('no', { kind: 'rect', x: dx + 350, y: bottom + 176, w: 170, h: 70, stroke: '#E03131', fill: '#FFE3E3', fillStyle: 'hachure', round: true, text: 'Wait and watch', frame: '@decision' });
  add('ay', { kind: 'arrow', from: '@q', to: '@yes', stroke: '#12A07C', text: 'yes', frame: '@decision' });
  add('an', { kind: 'arrow', from: '@q', to: '@no', stroke: '#E03131', text: 'no', frame: '@decision' });
  return ops;
}
