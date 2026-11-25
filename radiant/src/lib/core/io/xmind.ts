import { unzipSync } from 'fflate';
import type { OutlineNode } from '../types';
import { attr, parseXml, textOf, type XmlElement } from './xml';

interface XMindOutline {
  title: string;
  nodes: OutlineNode[];
  skipped: string[];
}

const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const TOPIC_FIELDS = new Set(['id', 'class', 'title', 'titleUnedited', 'notes', 'children']);
const SHEET_FIELDS = new Set(['id', 'class', 'title', 'rootTopic']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contents(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function reportFields(value: Record<string, unknown>, allowed: Set<string>, skipped: Set<string>) {
  for (const key of Object.keys(value)) if (!allowed.has(key) && value[key] != null) {
    skipped.add(key.replace(/[\s\x00-\x1f]/g, '').slice(0, 60));
  }
}

function checkDepth(depth: number) {
  if (depth > 500) throw new Error('This XMind file has more than 500 levels of nested topics.');
}

function modern(content: string, skipped: Set<string>): OutlineNode[] {
  const sheets: unknown = JSON.parse(content);
  if (!Array.isArray(sheets)) throw new Error('The XMind workbook has an unrecognized sheet format.');

  function convert(input: unknown, depth: number): OutlineNode {
    checkDepth(depth);
    const topic = record(input);
    const children = record(topic.children);
    const notes = record(topic.notes);
    reportFields(topic, TOPIC_FIELDS, skipped);
    for (const key of Object.keys(children)) {
      if (key !== 'attached' && key !== 'detached') skipped.add(`topic children (${key.slice(0, 40)})`);
    }
    const attached = Array.isArray(children.attached) ? children.attached : [];
    const detached = Array.isArray(children.detached) ? children.detached : [];
    const rich = record(record(notes.html).content).paragraphs;
    const plain = contents(record(notes.plain).content);
    const note = plain ?? (Array.isArray(rich) ? contents(rich.map((paragraph) => {
      const spans = record(paragraph).spans;
      return Array.isArray(spans) ? spans.map((span) => contents(record(span).text) ?? '').join('') : '';
    }).join('\n')) : undefined);
    if (notes.html) skipped.add('rich-text note formatting');
    if (detached.length) skipped.add('floating topic positions');
    return {
      text: typeof topic.title === 'string' ? topic.title : '',
      ...(note ? { note } : {}),
      children: [...attached, ...detached].map((child) => convert(child, depth + 1))
    };
  }

  return sheets.flatMap((item): OutlineNode[] => {
    const sheet = record(item);
    if (!Object.keys(record(sheet.rootTopic)).length) return [];
    reportFields(sheet, SHEET_FIELDS, skipped);
    const root = convert(sheet.rootTopic, 0);
    if (!root.text) root.text = contents(sheet.title) ?? '';
    return [root];
  });
}

const localName = (el: XmlElement) => el.name.split(':').at(-1);
function children(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((child): child is XmlElement => typeof child !== 'string' && localName(child) === name);
}

function classic(content: string, skipped: Set<string>): OutlineNode[] {
  const doc = parseXml(content);
  const workbook = children(doc, 'xmap-content')[0];
  if (!workbook) throw new Error('The XMind file has an unrecognized workbook.');
  const knownTopic = new Set(['title', 'notes', 'children']);
  const topicAttributes = new Set(['id', 'timestamp', 'xmlns', 'modified-by', 'created-time']);
  const knownSheet = new Set(['title', 'topic']);
  const plainText = (el: XmlElement) => el.children.filter((n): n is string => typeof n === 'string').join('');

  function convert(topic: XmlElement, depth: number): OutlineNode {
    checkDepth(depth);
    reportFields(topic.attrs, topicAttributes, skipped);
    for (const el of topic.children) {
      if (typeof el === 'string') continue;
      const name = localName(el)!;
      if (!knownTopic.has(name)) skipped.add(name.slice(0, 60));
    }
    const heading = children(topic, 'title')[0];
    const notes = children(topic, 'notes')[0];
    const plain = notes && children(notes, 'plain')[0];
    if (notes && children(notes, 'html').length) skipped.add('rich-text note formatting');
    const rich = notes && children(notes, 'html')[0];
    const note = (plain && contents(plainText(plain))) ?? (rich && contents(textOf(rich)));
    const kids = children(topic, 'children').flatMap((list) => children(list, 'topics')).flatMap((list) => {
      const type = attr(list, 'type');
      if (type === 'detached') skipped.add('floating topic positions');
      else if (type && type !== 'attached') {
        skipped.add(`topic children (${type.slice(0, 40)})`);
        return [];
      }
      return children(list, 'topic');
    });
    return { text: heading ? plainText(heading) : '', ...(note ? { note } : {}), children: kids.map((child) => convert(child, depth + 1)) };
  }

  return children(workbook, 'sheet').flatMap((sheet) => {
    reportFields(sheet.attrs, topicAttributes, skipped);
    for (const el of sheet.children) {
      if (typeof el === 'string') continue;
      const name = localName(el)!;
      if (!knownSheet.has(name)) skipped.add(name.slice(0, 60));
    }
    const root = children(sheet, 'topic')[0];
    if (!root) return [];
    const converted = convert(root, 0);
    const heading = children(sheet, 'title')[0];
    if (!converted.text && heading) converted.text = plainText(heading);
    return [converted];
  });
}

/** Reads modern XMind JSON workbooks and classic XMind XML archives. Artwork is never extracted. */
export function parseXmind(bytes: Uint8Array): XMindOutline {
  const skipped = new Set<string>();
  const seen = new Set<string>();
  const files = unzipSync(bytes, {
    filter: ({ name, originalSize }) => {
      if (name !== 'content.json' && name !== 'content.xml') {
        if (/^(?:xap:)?(?:attachments|resources)\//.test(name)) skipped.add('embedded assets');
        return false;
      }
      if (originalSize > MAX_CONTENT_BYTES) throw new Error('The XMind workbook content is too large.');
      if (seen.has(name)) throw new Error('The XMind archive has duplicate workbook entries.');
      seen.add(name);
      return true;
    }
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const nodes = files['content.json'] ? modern(decoder.decode(files['content.json']), skipped)
    : files['content.xml'] ? classic(decoder.decode(files['content.xml']), skipped)
    : [];
  if (!nodes.length) throw new Error('The XMind archive does not contain any readable sheets.');
  return { title: nodes[0].text, nodes, skipped: [...skipped].filter(Boolean).sort() };
}
