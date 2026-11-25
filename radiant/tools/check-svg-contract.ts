#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { artPreset } from '../src/lib/core/art/styleSheet';
import { buildSvgSubtreePrompt, buildSvgRepairPrompt, svgNodeAssets, validateSvg, type SvgSubtreeRequest } from '../src/lib/core/art/svg';
import corpus from './fixtures/svg-contract/cases.json';

const directory = new URL('./fixtures/svg-contract/', import.meta.url);
const request: SvgSubtreeRequest = { ...corpus.request, style: artPreset('buzan') };
let failed = false;
for (const fixture of corpus.cases) {
  const svg = readFileSync(new URL(fixture.file, directory), 'utf8');
  const input = { ...request, nodes: 'nodes' in fixture ? fixture.nodes : request.nodes, limits: fixture.limits };
  const report = validateSvg(svg, input);
  const found = report.issues.filter(issue => issue.severity === 'error')
    .map(issue => issue.nodeId ? `${issue.code}:${issue.nodeId}` : issue.code).sort();
  const expected = [...fixture.errors].sort();
  let pass = report.ok === (expected.length === 0) && JSON.stringify(found) === JSON.stringify(expected);
  if ('anchorSeparation' in (fixture.limits ?? {})) {
    const message = 'In and out anchors may coincide.';
    pass &&= buildSvgSubtreePrompt(input).instructions.includes(message)
      && buildSvgRepairPrompt(svg, report, input).instructions.includes(message);
  }
  if (report.ok) pass &&= svgNodeAssets(svg, input, report).size === input.nodes.length;
  const detail = found.length ? found.join(', ') : 'accepted';
  console.log(`${pass ? 'PASS' : 'FAIL'} ${fixture.name} — ${detail}`);
  if (!pass) {
    console.error(`Expected ${expected.join(', ') || 'acceptance'}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
