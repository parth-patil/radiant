#!/usr/bin/env python3
"""Generate the Rust and TypeScript projections of Codex messages consumed by Radiant."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

DESTINATION = Path(__file__).resolve().parents[1] / 'src-tauri/src/codex'
# Name the fields Radiant consumes. Their types and requiredness come from Codex.
MESSAGES = {
    'InitializeResponse': ('InitializeResponse', ['userAgent']),
    'GetAccountResponse': ('GetAccountResponse', ['account', 'requiresOpenaiAuth']),
    'TurnStartResponse': ('TurnStartResponse', ['turn']),
    'Turn': ('TurnStartResponse', ['id']),
    'ThreadStartResponse': ('ThreadStartResponse', ['thread', 'model']),
    'Thread': ('ThreadStartResponse', ['id', 'model']),
    'ConfigReadResponse': ('ConfigReadResponse', ['config']),
    'ModelListResponse': ('ModelListResponse', ['data']),
    'Model': ('ModelListResponse', ['id']),
    'GetAccountRateLimitsResponse': ('GetAccountRateLimitsResponse', ['rateLimits']),
    'AccountRateLimitsUpdatedNotification': ('AccountRateLimitsUpdatedNotification', ['rateLimits']),
    'AgentMessageDeltaNotification': ('AgentMessageDeltaNotification', ['delta']),
    'ThreadRoute': ('AgentMessageDeltaNotification', ['threadId']),
    'TurnRoute': ('AgentMessageDeltaNotification', ['turnId']),
    'ItemCompletedNotification': ('ItemCompletedNotification', ['item']),
    'ImageGenerationThreadItem': ('ItemCompletedNotification', ['result', 'savedPath', 'failure', 'revisedPrompt']),
    'ThreadTokenUsageUpdatedNotification': ('ThreadTokenUsageUpdatedNotification', ['tokenUsage']),
    'ThreadTokenUsage': ('ThreadTokenUsageUpdatedNotification', ['total', 'last']),
    'TokenUsageBreakdown': ('ThreadTokenUsageUpdatedNotification', ['inputTokens', 'outputTokens']),
    'RateLimitSnapshot': ('AccountRateLimitsUpdatedNotification', ['primary', 'secondary', 'planType', 'rateLimitReachedType']),
    'RateLimitWindow': ('AccountRateLimitsUpdatedNotification', ['usedPercent', 'windowDurationMins', 'resetsAt']),
    'ErrorNotification': ('ErrorNotification', ['error', 'willRetry']),
    'TurnCompletedNotification': ('TurnCompletedNotification', ['turn']),
    'CompletedTurn': ('TurnCompletedNotification', ['id', 'items', 'status', 'error']),
}
REQUESTS = {
    'InitializeParams': ('InitializeParams', ['clientInfo', 'capabilities']),
    'ClientInfo': ('InitializeParams', ['name', 'title', 'version']),
    'InitializeCapabilities': ('InitializeParams', ['experimentalApi', 'requestAttestation']),
    'ConfigReadParams': ('ConfigReadParams', ['includeLayers']),
    'ModelListParams': ('ModelListParams', ['limit']),
    'GetAccountRateLimitsParams': ('NullableGetAccountRateLimitsParams', []),
    'GetAccountParams': ('GetAccountParams', ['refreshToken']),
    'ThreadUnsubscribeParams': ('ThreadUnsubscribeParams', ['threadId']),
    'ThreadStartParams': ('ThreadStartParams', ['cwd', 'approvalPolicy', 'sandbox', 'ephemeral', 'serviceName', 'config', 'model', 'developerInstructions']),
    'TurnStartParams': ('TurnStartParams', ['threadId', 'input', 'effort', 'model', 'outputSchema']),
    'TurnInterruptParams': ('TurnInterruptParams', ['threadId', 'turnId']),
}
# Free-form configuration/schema values and extensible provider payloads use JSON.
OPAQUE = {
    'ThreadStartParams.config', 'TurnStartParams.outputSchema', 'GetAccountResponse.account',
    'ConfigReadResponse.config', 'GetAccountRateLimitsResponse.rateLimits',
    'AccountRateLimitsUpdatedNotification.rateLimits', 'ItemCompletedNotification.item',
    'ImageGenerationThreadItem.failure',
    'ErrorNotification.error', 'CompletedTurn.error',
}
# Older CLI releases omitted fields that the current schema declares required.
LEGACY_OPTIONAL = {'ThreadStartResponse.model', 'ThreadTokenUsage.total', 'ThreadTokenUsage.last',
                   'CompletedTurn.items', 'CompletedTurn.status', 'ErrorNotification.willRetry',
                   'TokenUsageBreakdown.inputTokens', 'TokenUsageBreakdown.outputTokens', 'RateLimitWindow.usedPercent'}
ALIASES = {'CompletedTurn': 'Turn', 'ThreadRoute': 'AgentMessageDeltaNotification',
           'TurnRoute': 'AgentMessageDeltaNotification'}
REF_OVERRIDES = {('TurnCompletedNotification', 'Turn'): 'CompletedTurn'}
REQUEST_ENUMS = {'AskForApproval', 'SandboxMode'}
STRING_ENUMS = REQUEST_ENUMS | {'TurnStatus'}
VARIANTS = {'text': ['text', 'text_elements'], 'localImage': ['path']}
PRIMITIVES = {
    'string': ('String', 'string'), 'boolean': ('bool', 'boolean'),
    'integer': ('i64', 'number'), 'number': ('f64', 'number'),
    'object': ('serde_json::Value', 'Record<string, unknown>'),
}


def nullable_type(schema):
    if isinstance(schema.get('type'), list) and 'null' in schema['type']:
        return {**schema, 'type': next(kind for kind in schema['type'] if kind != 'null')}
    if 'anyOf' in schema and len(schema['anyOf']) == 2 and {'type': 'null'} in schema['anyOf']:
        return next(branch for branch in schema['anyOf'] if branch != {'type': 'null'})
    return schema


def field_type(schema, context, definitions):
    schema = nullable_type(schema)
    if context == 'CompletedTurn.items':
        if schema.get('type') != 'array':
            raise ValueError(f'{context} is no longer an array')
        return 'Vec<serde_json::Value>', 'Array<unknown>'
    if context in OPAQUE:
        return 'serde_json::Value', 'unknown'
    if '$ref' in schema:
        name = schema['$ref'].rsplit('/', 1)[-1]
        name = REF_OVERRIDES.get((context.split('.')[0], name), name)
        if name in MESSAGES or name in REQUESTS or name == 'UserInput':
            return name, name
        if name in STRING_ENUMS:
            return name, name
        if name == 'TextElement':
            return 'serde_json::Value', 'unknown'
        return field_type(definitions[name], context, definitions)
    if schema.get('type') == 'array':
        rust, ts = field_type(schema['items'], context, definitions)
        return f'Vec<{rust}>', f'Array<{ts}>'
    if schema.get('type') == 'integer' and schema.get('format', '').startswith('uint'):
        return 'u64', 'number'
    if schema.get('type') == 'string' and 'enum' in schema:
        return 'String', ' | '.join(json.dumps(value) for value in schema['enum'])
    if schema.get('type') in PRIMITIVES:
        return PRIMITIVES[schema['type']]
    raise ValueError(f'{context} has an unsupported schema type: {schema}')


def string_enum(name, schema, rust, ts, request=True):
    values = schema.get('enum')
    if values is None:
        values = next(branch['enum'] for branch in schema['oneOf'] if 'enum' in branch)
    derives = ['#[derive(Clone, Serialize)]', '#[allow(dead_code)]'] if request else ['#[derive(Clone, Copy, Deserialize)]']
    rust.extend([*derives, f'pub(super) enum {name} {{'])
    for value in values:
        variant = ''.join(word[0].upper() + word[1:] for word in value.split('-'))
        rust.extend([f'    #[serde(rename = "{value}")]', f'    {variant},'])
    if not request:
        rust.extend(['    #[serde(other)]', '    Unknown,'])
    rust.extend(['}', ''])
    ts.extend([f'export type {name} = ' + ' | '.join(json.dumps(value) for value in values) + ';', ''])


def user_input(definitions, rust, ts):
    schema = definitions['UserInput']
    rust.extend(['#[derive(Clone, Serialize)]', '#[serde(tag = "type", rename_all = "camelCase")]', 'pub(super) enum UserInput {'])
    ts.append('export type UserInput =')
    for variant, fields in VARIANTS.items():
        entry = next((item for item in schema['oneOf']
                      if item['properties']['type']['enum'] == [variant]), None)
        if entry is None:
            raise ValueError(f'Codex omitted UserInput.{variant}')
        rust.append(f'    {variant[0].upper() + variant[1:]} {{')
        ts.append(f'  | {{ type: "{variant}";')
        for field in fields:
            rust_type, ts_type = field_type(entry['properties'][field], f'UserInput.{variant}.{field}', definitions)
            rust.append(f'        {field}: {rust_type},')
            ts.append(f'      {field}: {ts_type};')
        rust.append('    },')
        ts.append('    }')
    rust.extend(['}', ''])
    ts.extend([';', ''])


def generate(binary):
    version = subprocess.check_output([binary, '--version'], text=True).strip()
    with tempfile.TemporaryDirectory(prefix='radiant-schema-') as directory:
        root = Path(directory)
        subprocess.run([binary, 'app-server', 'generate-json-schema', '--out', root],
                       stdin=subprocess.DEVNULL, check=True)
        rust = [f'// Generated by tools/generate-codex-protocol.py from {version}.', 'use serde::{Deserialize, Serialize};', '']
        ts = [f'// Generated by tools/generate-codex-protocol.py from {version}.', '']
        for name, (document, fields) in (MESSAGES | REQUESTS).items():
            source = next(root.rglob(document + '.json'), None)
            if source is None:
                raise ValueError(f'Codex omitted {document}.json')
            schema = json.loads(source.read_text())
            definitions = schema.get('definitions', {})
            request = name in REQUESTS
            spelling = ALIASES.get(name, name)
            if name == 'ImageGenerationThreadItem':
                schema = next(item for item in definitions['ThreadItem']['oneOf']
                              if item['properties']['type']['enum'] == ['imageGeneration'])
                property_sets = [entry.get('properties', {}) for entry in schema['anyOf']]
                schema['properties'] = {**schema['properties'], **{k: v for props in property_sets for k, v in props.items()}}
            elif spelling != document:
                schema = definitions.get(spelling, {})
            if schema.get('type') != 'object':
                raise ValueError(f'{name} is no longer an object')
            if not fields and schema.get('required'):
                raise ValueError(f'{name} no longer allows empty params')
            rust.extend(['#[derive(Clone, Serialize)]' if request else '#[derive(Deserialize)]', '#[serde(rename_all = "camelCase")]', f'pub(super) struct {name} {{'])
            ts.append(f'export interface {name} {{' if fields else f'export type {name} = Record<string, never>;')
            for field in fields:
                context = f'{name}.{field}'
                entry = schema.get('properties', {}).get(field)
                if entry is None:
                    raise ValueError(f'Codex omitted {context}')
                rust_type, ts_type = field_type(entry, context, definitions)
                optional = field not in schema.get('required', []) or context in LEGACY_OPTIONAL
                if optional:
                    rust_type = f'Option<{rust_type}>'
                    if request and context != 'TurnStartParams.effort':
                        rust.append('    #[serde(skip_serializing_if = "Option::is_none")]')
                snake = re.sub('[A-Z]', lambda match: '_' + match[0].lower(), field)
                rust.append(f'    pub {snake}: {rust_type},')
                if nullable_type(entry) != entry:
                    ts_type += ' | null'
                ts.append(f'  {field}{"?" if optional else ""}: {ts_type};')
            rust.extend(['}', ''])
            ts.extend(['}', ''] if fields else [''])
            if name == 'ThreadStartParams':
                for enum in sorted(REQUEST_ENUMS):
                    string_enum(enum, definitions[enum], rust, ts)
            if name == 'CompletedTurn':
                string_enum('TurnStatus', definitions['TurnStatus'], rust, ts, request=False)
            if name == 'TurnStartParams':
                user_input(definitions, rust, ts)
    return {'protocol_types.rs': '\n'.join(rust), 'protocol-types.ts': '\n'.join(ts)}


def main():
    options = argparse.ArgumentParser(description=__doc__)
    options.add_argument('--binary', default='codex')
    options.add_argument('--output-dir', type=Path, default=DESTINATION)
    options.add_argument('--check', action='store_true')
    args = options.parse_args()
    expected = generate(args.binary)
    if not args.check:
        args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, text in expected.items():
        path = args.output_dir / filename
        if args.check:
            if not path.is_file() or path.read_text() != text:
                raise SystemExit(f'{path} differs from installed Codex. Regenerate and review the protocol changes.')
        else:
            path.write_text(text)


if __name__ == '__main__':
    main()
