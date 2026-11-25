export const importNotices = {
  markdown: 'Imports headings and nested lists as the map hierarchy and paragraphs as notes. Formatting stays as source text. Picture files, visual styles, positions and cross-connections are not imported.',
  text: 'Imports indented lines as the map hierarchy and labels. Notes, pictures, styles and cross-connections are outside this format.',
  opml: 'Imports outline hierarchy, labels, notes and readable outline attributes. Map artwork, layout and cross-connections are outside this format.',
  freemind: 'Imports the hierarchy, labels, note text, folds, node links and icon metadata. FreeMind visual styles, embedded pictures, exact positions and cross-connections are not imported.',
  xmind: 'Imports the topic hierarchy, labels and plain-text notes. Artwork, styles, connections and fixed topic positions are not imported.',
  mindnode: 'Imports the supported hierarchy, labels, notes and attachments. Exact positions, unsupported artwork and rich styling can be lost. Supported metadata differs between MindNode Classic and Next.',
  canvas: 'Imports supported cards and connections. Fixed card sizes and attachment sides, embedded file contents and group containment are not preserved.',
  json: 'Imports editable Radiant map data and asset references. A JSON file contains no artwork bytes. Pictures require the original asset store or a portable bundle.',
  bundle: 'Imports editable Radiant map data and its bundled artwork. Local snapshots, Undo history, review history and settings live outside the bundle.',
} satisfies Record<string, string>;

export type ImportFormat = keyof typeof importNotices;
