// Run with bun tools/check-prompt-regression.ts [--corpus path] [--baseline path].
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeStream from '../src/lib/core/ai/templates/node-stream.json';
import { buildGenerateMapPrompt, generationLimits } from '../src/lib/core/ai/prompts';
import { NodeLineParser, StreamApplier } from '../src/lib/core/ai/stream';

interface Fixture {
  id: string;
  topic: string;
  style: string;
  depth: number;
  breadth: number;
  origin: string;
  records?: string[];
  capture?: { source: string; interrupted: boolean; deltas: string[] };
}

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const corpusPath = resolve(option('--corpus') ?? fileURLToPath(new URL('./fixtures/prompt-regression.json', import.meta.url)));
const corpus: Fixture[] = JSON.parse(readFileSync(corpusPath, 'utf8'));
if (new Set(corpus.map((item) => item.id)).size < 10) throw new Error('The regression set requires ten distinct fixtures.');

function runFixture(fixture: Fixture) {
  const limits = generationLimits(fixture);
  const request = buildGenerateMapPrompt(fixture.topic, { request: fixture.style }, fixture);
  let id = 0;
  const applier = new StreamApplier({
    jobId: fixture.id, idGen: () => String(++id), existingIds: new Set(),
    attachTo: { kind: 'newRoot', position: { x: 0, y: 0 } }, ...limits
  });
  const childCounts = new Map<string, number>();
  const depths = new Map<string, number>();
  const parser = new NodeLineParser({ onNode(node) {
    const insert = applier.push(node).find((op) => op.t === 'insert');
    if (!insert) return;
    const parent = insert.parent;
    depths.set(insert.node.id, parent ? 1 + (depths.get(parent) ?? 0) : 0);
    if (parent) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  } });
  if (fixture.capture) {
    for (const delta of fixture.capture.deltas) parser.push(delta);
    if (fixture.capture.interrupted) parser.discard();
    else parser.end();
  } else {
    const output = (fixture.records ?? []).join('\n') + '\n';
    for (let index = 0; index < output.length; index += 11) parser.push(output.slice(index, index + 11));
    parser.end();
  }
  const rejected = parser.errors + applier.rejected.length;
  return {
    id: fixture.id, origin: fixture.origin,
    templateVersion: request.templateVersion, requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    valid: applier.count, rejected,
    reachedDepth: Math.max(0, ...depths.values()) === limits.maxDepth,
    reachedBreadth: Math.max(0, ...childCounts.values()) === limits.maxChildren
  };
}

const publishedExample = nodeStream.example.map(row => JSON.stringify(row));
const exampleRequest = buildGenerateMapPrompt('Coffee', {}, { withNotes: true, withImageHints: true });
if (!exampleRequest.instructions.includes(publishedExample.join('\n'))) {
  throw new Error('The generation instructions omitted or changed the node stream example.');
}
const example = runFixture({
  id: nodeStream.version, topic: 'Coffee', style: '', depth: 3, breadth: 5,
  origin: 'versioned node stream example', records: publishedExample
});
if (example.valid !== publishedExample.length || example.rejected) {
  throw new Error('The production parser or applier rejected the versioned node stream example.');
}

const jobs = corpus.map(runFixture);
const valid = jobs.reduce((sum, job) => sum + job.valid, 0);
const rejected = jobs.reduce((sum, job) => sum + job.rejected, 0);
const report = {
  example: { specification: nodeStream.version, accepted: example.valid, rejected: example.rejected },
  fixtureCount: jobs.length, valid, rejected, validLineShare: valid / Math.max(1, valid + rejected),
  jobsReachingDepth: jobs.filter(job => job.reachedDepth).length / jobs.length,
  jobsReachingBreadth: jobs.filter(job => job.reachedBreadth).length / jobs.length,
  jobsReachingBothLimits: jobs.filter(job => job.reachedDepth && job.reachedBreadth).length / jobs.length,
  jobs
};
const path = option('--baseline');
let comparison;
if (path) {
  const baseline: typeof report = JSON.parse(readFileSync(path, 'utf8'));
  const before = new Map(baseline.jobs.map(job => [job.id, job.requestHash]));
  comparison = {
    changedRequests: jobs.filter(job => before.get(job.id) !== job.requestHash).map(job => job.id),
    validLineShareChange: report.validLineShare - baseline.validLineShare,
    jobsReachingBothLimitsChange: report.jobsReachingBothLimits - baseline.jobsReachingBothLimits
  };
}
console.log(JSON.stringify({ ...report, ...(comparison ? { comparison } : {}) }, null, 2));
