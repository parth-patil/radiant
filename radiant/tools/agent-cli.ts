#!/usr/bin/env bun
// The radiant command: one entry point for agents. See `bun tools/agent-cli.ts --help` and tools/radiant/.
import { main } from './radiant/main';

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
});
