// Minimal XML helpers shared by the rest-xml (S3) and query-xml (SNS/STS)
// protocols. Deliberately tiny: the engine only ever parses XML documents
// whose shape it defined the request contract for (DeleteObjects,
// NotificationConfiguration, VersioningConfiguration), so this is a strict
// well-formed-subset parser — no namespaces resolution, no DTD, no CDATA.

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

// Build one element. `content` is either pre-built XML (from nested tag()
// calls) or raw text that gets escaped when `escape` is true (default).
export function tag(name: string, content: string, options?: { attrs?: Record<string, string>; escape?: boolean }): string {
  const attrs = Object.entries(options?.attrs ?? {})
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
  if (content === '') return `<${name}${attrs}/>`;
  const body = options?.escape === false ? content : escapeXml(content);
  return `<${name}${attrs}>${body}</${name}>`;
}

export function xmlDocument(root: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${root}`;
}

// Parse a well-formed XML document into a node tree. Throws on malformed
// input (mismatched tags, trailing garbage).
export function parseXml(input: string): XmlNode {
  const source = input.replace(/<\?xml[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  let pos = 0;

  function fail(reason: string): never {
    throw new Error(`Malformed XML at offset ${pos}: ${reason}`);
  }

  function parseNode(): XmlNode {
    if (source[pos] !== '<') fail('expected element');
    const open = /^<([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/.exec(source.slice(pos));
    if (!open) fail('invalid opening tag');
    const [openText, name, attrText, selfClose] = open;
    pos += openText.length;

    const attributes: Record<string, string> = {};
    for (const match of attrText.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
      attributes[match[1]] = unescapeXml(match[2]);
    }

    const node: XmlNode = { name, attributes, children: [], text: '' };
    if (selfClose === '/') return node;

    for (;;) {
      const nextTag = source.indexOf('<', pos);
      if (nextTag === -1) fail(`unclosed element <${name}>`);
      const textChunk = source.slice(pos, nextTag);
      if (textChunk.trim()) node.text += unescapeXml(textChunk.trim());
      pos = nextTag;
      if (source.startsWith(`</${name}`, pos)) {
        const close = source.indexOf('>', pos);
        if (close === -1) fail(`unclosed closing tag for <${name}>`);
        pos = close + 1;
        return node;
      }
      if (source.startsWith('</', pos)) fail(`unexpected closing tag inside <${name}>`);
      node.children.push(parseNode());
    }
  }

  const root = parseNode();
  if (source.slice(pos).trim()) fail('trailing content after root element');
  return root;
}

// Convenience lookups used by emulators.
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter(child => child.name === name);
}

export function childText(node: XmlNode, name: string): string | undefined {
  return node.children.find(child => child.name === name)?.text;
}
