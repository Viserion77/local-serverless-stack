// Minimal multipart/form-data parser for S3 browser POST uploads (presigned
// POST). No dependency: the body is small (a policy form plus one file) and
// arrives fully buffered. Byte-accurate — the file part is preserved exactly,
// binary included. Only what presigned POST needs is parsed: named text
// fields plus a single file part (name + filename + content-type + bytes).

export interface MultipartField {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

const DASH = 0x2d; // '-'
const CR = 0x0d;
const LF = 0x0a;

// Extract the boundary token from a `multipart/form-data; boundary=...` header
// (quoted or bare). Returns undefined when the header is not multipart.
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (!contentType || !/^multipart\/form-data/i.test(contentType.trim())) return undefined;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  return boundary.length > 0 ? boundary : undefined;
}

export function parseMultipart(body: Buffer, boundary: string): MultipartField[] {
  // The opening boundary is `--boundary`; every later one is `\r\n--boundary`
  // (the CRLF belongs to the delimiter, not the part body). Searching for the
  // CRLF-prefixed form to close a part is what makes binary content safe — the
  // MIME contract guarantees the full delimiter never appears inside a part.
  const dashBoundary = Buffer.from(`--${boundary}`);
  const crlfBoundary = Buffer.from(`\r\n--${boundary}`);
  const fields: MultipartField[] = [];
  let pos = body.indexOf(dashBoundary);
  if (pos === -1) return fields;
  pos += dashBoundary.length;
  for (;;) {
    // After a delimiter: either "--" (final boundary) or CRLF then a part.
    if (body[pos] === DASH && body[pos + 1] === DASH) break;
    if (body[pos] === CR && body[pos + 1] === LF) pos += 2;
    const headerEnd = indexOfDoubleCrlf(body, pos);
    if (headerEnd === -1) break;
    const headerText = body.subarray(pos, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const nextDelimiter = body.indexOf(crlfBoundary, dataStart);
    if (nextDelimiter === -1) break;
    const field = parseHeaders(headerText);
    if (field) fields.push({ ...field, data: body.subarray(dataStart, nextDelimiter) });
    pos = nextDelimiter + crlfBoundary.length;
  }
  return fields;
}

function indexOfDoubleCrlf(body: Buffer, from: number): number {
  for (let i = from; i + 3 < body.length; i++) {
    if (body[i] === CR && body[i + 1] === LF && body[i + 2] === CR && body[i + 3] === LF) return i;
  }
  return -1;
}

function parseHeaders(headerText: string): Omit<MultipartField, 'data'> | undefined {
  let name: string | undefined;
  let filename: string | undefined;
  let contentType: string | undefined;
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const headerName = line.slice(0, colon).trim().toLowerCase();
    const headerValue = line.slice(colon + 1).trim();
    if (headerName === 'content-disposition') {
      name = dispositionParam(headerValue, 'name');
      filename = dispositionParam(headerValue, 'filename');
    } else if (headerName === 'content-type') {
      contentType = headerValue;
    }
  }
  if (name === undefined) return undefined;
  return { name, filename, contentType };
}

function dispositionParam(value: string, param: string): string | undefined {
  // Anchor the parameter at a segment start (`^` or after `;`) so searching
  // for `name` does not match the tail of `filename` (which ends in "name").
  const match = new RegExp(`(?:^|;)\\s*${param}=(?:"([^"]*)"|([^;]+))`, 'i').exec(value);
  if (!match) return undefined;
  return (match[1] ?? match[2] ?? '').trim();
}
