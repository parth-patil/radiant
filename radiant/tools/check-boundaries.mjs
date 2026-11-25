// @ts-nocheck -- standalone Node build tool, outside the application TypeScript project.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';
import ts from 'typescript';

const project = fileURLToPath(new URL('../', import.meta.url));
// These entry points run on typed arrays or strings without DOM, shell or filesystem APIs.
const corePackages = new Set(['fflate', 'markdown-it/browser', 'roughjs/bin/generator']);
const sharedGlobals = new Set([
  'URL', 'URLSearchParams', 'TextEncoder', 'TextEncoderCommon', 'TextDecoder',
  'TextDecoderCommon', 'Crypto', 'SubtleCrypto', 'crypto'
]);
const shellPackages = /^(?:@tauri-apps\/|electron(?:\/|$)|@neutralinojs\/)/;
const directProviders = /^(?:openai(?:\/|$)|@openai\/|@ai-sdk\/openai(?:\/|$)|@anthropic-ai\/|node:child_process$|child_process$)/;
const concreteProviders = /^src\/lib\/host\/(?:tauri|mock|replay)(?:[.-][^/]+)?$/;
const directEndpoints = /^https?:\/\/(?:api\.openai\.com|chatgpt\.com|api\.anthropic\.com)(?:[/:?#]|$)/i;
const aiCommands = new Set(['ai_status', 'ai_start_turn', 'ai_resolve_map_round', 'ai_cancel', 'ai-event', 'app-server', 'codex']);
const shellGlobals = /^__TAURI(?:_INTERNALS__|__|_IPC__)$/;
const gpuNames = /^(?:WebGL\w+|GPU(?:Adapter|Buffer|CanvasContext|Device|Queue|RenderPipeline|Texture))$/;
const gpuContexts = new Set(['webgl', 'webgl2', 'experimental-webgl', 'webgpu']);
const gpuCalls = new Set([
  'drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced',
  'bindVertexArray', 'vertexAttribPointer', 'texImage2D', 'texSubImage2D'
]);

function list(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const target = resolve(path, entry.name);
    return entry.isDirectory() ? list(target) :
      entry.isFile() && /\.(?:svelte|[mc]?[jt]sx?)$/.test(entry.name) ? [target] : [];
  });
}

const inside = (path, folder) => path === folder || path.startsWith(folder + '/');
const label = (absolute) => relative(project, absolute).split(sep).join('/');

function fromSpec(file, spec) {
  if (spec.startsWith('$lib/')) return 'src/lib/' + spec.slice(5);
  if (spec === '$lib') return 'src/lib';
  if (spec.startsWith('.')) return label(resolve(dirname(file), spec));
  if (spec.startsWith('/src/')) return spec.slice(1);
  return null;
}

function memberName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
}

export function checkBoundaries() {
  const files = list(resolve(project, 'src'));
  const coreFiles = files.filter((file) => inside(label(file), 'src/lib/core') && !file.endsWith('.svelte'));
  const coreProgram = ts.createProgram(coreFiles, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    types: [],
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.webworker.d.ts']
  });
  const checker = coreProgram.getTypeChecker();
  const violations = new Set();
  for (const file of files) {
    const name = label(file);
    const core = inside(name, 'src/lib/core');
    const renderer = inside(name, 'src/lib/render');
    const nativeAdapter = name === 'src/lib/host/tauri.ts';
    const shellHost = nativeAdapter || name === 'src/lib/host/index.ts';
    const text = readFileSync(file, 'utf8');
    const lineOffsets = ts.createSourceFile(file + '.ts', text, ts.ScriptTarget.ESNext);
    const fail = (position, description) => {
      const { line, character } = lineOffsets.getLineAndCharacterOfPosition(position);
      violations.add(`${name}:${line + 1}:${character + 1} ${description}`);
    };

    const inspectImport = (source, position) => {
      if (typeof source !== 'string') {
        fail(position, 'Dependency must use a literal module specifier');
        return;
      }
      if (!nativeAdapter && shellPackages.test(source)) fail(position, 'Shell APIs belong in the native host adapter');
      const target = fromSpec(file, source);
      if ((!nativeAdapter && directProviders.test(source)) ||
          (!inside(name, 'src/lib/host') && target && concreteProviders.test(target))) {
        fail(position, 'Codex access must use the AI provider interface');
      }
      if (core) {
        if (target ? !inside(target, 'src/lib/core') : !corePackages.has(source)) {
          fail(position, `Core dependency crosses the engine boundary: ${source}`);
        }
      }
    };

    const inspectString = (value, position) => {
      if (!shellHost && shellGlobals.test(value)) fail(position, 'Shell APIs belong in the native host adapter');
      if (!nativeAdapter && directEndpoints.test(value)) fail(position, 'Codex access must use the AI provider interface');
    };

    const inspectName = (value, position) => {
      if (core && ['Bun', 'Deno', 'process', '__dirname', '__filename'].includes(value)) {
        fail(position, `Runtime API is not allowed in core: ${value}`);
      }
      if (!renderer && gpuNames.test(value)) fail(position, 'GPU APIs belong in the renderer');
      if (!shellHost && shellGlobals.test(value)) fail(position, 'Shell APIs belong in the native host adapter');
    };

    const inspectCall = (callee, first, position) => {
      if (!renderer && callee === 'getContext' && gpuContexts.has(first)) fail(position, 'GPU APIs belong in the renderer');
      if (!renderer && gpuCalls.has(callee)) fail(position, 'GPU APIs belong in the renderer');
      if (!nativeAdapter && ['invoke', 'listen', 'spawn', 'exec', 'execFile', 'Command'].includes(callee) && aiCommands.has(first)) {
        fail(position, 'Codex access must use the AI provider interface');
      }
    };

    function checkScript(script, offset = 0) {
      const inspect = (node) => {
        const position = node.getStart(script) + offset;
        const module = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier : ts.isExternalModuleReference(node) ? node.expression
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
        if (module) inspectImport(ts.isStringLiteralLike(module) ? module.text : undefined, position);
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const first = node.arguments?.[0];
          const literal = first && ts.isStringLiteralLike(first) ? first.text : undefined;
          const name = memberName(node.expression);
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === 'require') {
            inspectImport(literal, position);
          }
          inspectCall(name, literal, position);
        }
        if (ts.isStringLiteralLike(node)) inspectString(node.text, position);
        if (ts.isTemplateExpression(node)) inspectString(node.head.text, position);
        if (ts.isIdentifier(node)) inspectName(node.text, position);
        if (!renderer && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          memberName(node) === 'gpu' && memberName(node.expression) === 'navigator') {
          fail(position, 'GPU APIs belong in the renderer');
        }
        if (core && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) && ts.isElementAccessExpression(node.parent))) {
          const symbol = checker.getSymbolAtLocation(node);
          const browserOnly = symbol?.declarations?.some((declaration) => {
            if (!/lib\.(?:dom|webworker)(?:\.\w+)?\.d\.ts$/.test(declaration.getSourceFile().fileName)) return false;
            const owner = declaration.parent;
            return !((ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) && owner.name &&
              sharedGlobals.has(owner.name.text));
          });
          if (browserOnly && !sharedGlobals.has(symbol.name)) {
            fail(position, `Browser API is not allowed in core: ${symbol.name}`);
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(script);
    }

    if (!file.endsWith('.svelte')) {
      const source = coreProgram.getSourceFile(file) ?? ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
      checkScript(source);
      continue;
    }
    if (core) {
      fail(0, 'Svelte components belong outside the engine core');
      continue;
    }

    const component = parse(text, { filename: file, modern: true });
    for (const block of [component.module, component.instance].filter(Boolean)) {
      const source = text.slice(block.content.start, block.content.end);
      checkScript(ts.createSourceFile(file + '.ts', source, ts.ScriptTarget.ESNext, true), block.content.start);
    }
    function checkTemplate(bindings) {
      if (!bindings || typeof bindings !== 'object') return;
      if (bindings.type === 'ImportExpression') inspectImport(bindings.source.value, bindings.start);
      if (bindings.type === 'CallExpression' || bindings.type === 'NewExpression') {
        const callee = bindings.callee;
        const name = callee.name ?? callee.property?.name ?? callee.property?.value;
        const value = bindings.arguments[0]?.value;
        if (name === 'require') inspectImport(value, bindings.start);
        inspectCall(name, value, bindings.start);
      }
      if (!renderer && bindings.type === 'MemberExpression') {
        const owner = bindings.object.name ?? bindings.object.property?.name ?? bindings.object.property?.value;
        if (owner === 'navigator' && (bindings.property.name ?? bindings.property.value) === 'gpu') {
          fail(bindings.start, 'GPU APIs belong in the renderer');
        }
      }
      if (bindings.type === 'TemplateLiteral') inspectString(bindings.quasis[0].value.cooked ?? '', bindings.start);
      if (bindings.type === 'Identifier') inspectName(bindings.name, bindings.start);
      if (bindings.type === 'Literal' && typeof bindings.value === 'string') inspectString(bindings.value, bindings.start);
      for (const child of Object.values(bindings)) checkTemplate(child);
    }
    checkTemplate(component.fragment);
  }
  if (violations.size) {
    throw new Error(`Architecture boundary violation\n${[...violations].sort().join('\n')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkBoundaries();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
