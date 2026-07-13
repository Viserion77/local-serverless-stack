// The dependency-free multipart/form-data parser behind S3 presigned POST:
// boundary extraction, named text fields, a file part with filename +
// content-type, byte-exact bodies (binary, embedded CRLF) and tolerance for
// the preamble/epilogue a browser may add.
import { multipartBoundary, parseMultipart } from '../../../../src/server/engine/emulators/s3/multipart';

describe('multipartBoundary', () => {
  it('extracts a bare boundary', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc123')).toBe('abc123');
  });
  it('extracts a quoted boundary', () => {
    expect(multipartBoundary('multipart/form-data; boundary="a b c"')).toBe('a b c');
  });
  it('returns undefined for non-multipart content types', () => {
    expect(multipartBoundary('application/json')).toBeUndefined();
    expect(multipartBoundary('application/x-www-form-urlencoded')).toBeUndefined();
    expect(multipartBoundary(undefined)).toBeUndefined();
    expect(multipartBoundary('multipart/form-data')).toBeUndefined();
  });
});

function part(name: string, value: string, extra = ''): string {
  return `--B\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n${value}\r\n`;
}

describe('parseMultipart', () => {
  it('parses named text fields', () => {
    const body = Buffer.from(part('key', 'photos/1.jpg') + part('acl', 'private') + '--B--\r\n');
    const fields = parseMultipart(body, 'B');
    expect(fields.map(f => [f.name, f.data.toString()])).toEqual([
      ['key', 'photos/1.jpg'],
      ['acl', 'private'],
    ]);
    expect(fields.every(f => f.filename === undefined)).toBe(true);
  });

  it('parses a file part with filename and content-type', () => {
    const body = Buffer.concat([
      Buffer.from(part('key', 'k')),
      Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n'),
      Buffer.from('file contents'),
      Buffer.from('\r\n--B--\r\n'),
    ]);
    const fields = parseMultipart(body, 'B');
    const file = fields.find(f => f.name === 'file')!;
    expect(file.filename).toBe('a.txt');
    expect(file.contentType).toBe('text/plain');
    expect(file.data.toString()).toBe('file contents');
  });

  it('preserves binary bytes including embedded CRLF exactly', () => {
    const binary = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x2d, 0x2d, 0x42, 0x80]);
    const body = Buffer.concat([
      Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\n'),
      binary,
      Buffer.from('\r\n--B--\r\n'),
    ]);
    const fields = parseMultipart(body, 'B');
    expect(Buffer.compare(fields[0].data, binary)).toBe(0);
  });

  it('ignores a preamble before the first boundary', () => {
    const body = Buffer.from('preamble junk\r\n' + part('key', 'v') + '--B--\r\n');
    const fields = parseMultipart(body, 'B');
    expect(fields).toHaveLength(1);
    expect(fields[0].data.toString()).toBe('v');
  });

  it('does not mistake the tail of filename= for the name parameter', () => {
    // Content-Disposition lists filename before name; the `name` param must be
    // "file", not "a.txt" grabbed from inside "filename=".
    const body = Buffer.concat([
      Buffer.from('--B\r\nContent-Disposition: form-data; filename="a.txt"; name="file"\r\n\r\n'),
      Buffer.from('data'),
      Buffer.from('\r\n--B--\r\n'),
    ]);
    const fields = parseMultipart(body, 'B');
    expect(fields[0].name).toBe('file');
    expect(fields[0].filename).toBe('a.txt');
  });

  it('returns nothing when the boundary is absent', () => {
    expect(parseMultipart(Buffer.from('no boundary here'), 'B')).toEqual([]);
  });
});
