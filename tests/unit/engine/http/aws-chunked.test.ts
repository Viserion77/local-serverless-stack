import { decodeAwsChunkedBody, isAwsChunkedBody } from '../../../../src/server/engine/http/aws-chunked.js';
import { AwsError } from '../../../../src/server/engine/http/errors.js';

function signedChunk(data: string): string {
  return `${Buffer.byteLength(data).toString(16)};chunk-signature=${'ab'.repeat(32)}\r\n${data}\r\n`;
}

function unsignedChunk(data: string): string {
  return `${Buffer.byteLength(data).toString(16)}\r\n${data}\r\n`;
}

describe('isAwsChunkedBody', () => {
  it('detects the content-encoding token', () => {
    expect(isAwsChunkedBody({ 'content-encoding': 'aws-chunked' })).toBe(true);
    expect(isAwsChunkedBody({ 'content-encoding': 'gzip, aws-chunked' })).toBe(true);
  });

  it('detects the STREAMING- payload hash variant', () => {
    expect(isAwsChunkedBody({ 'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER' })).toBe(true);
    expect(isAwsChunkedBody({ 'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' })).toBe(true);
  });

  it('leaves plain requests alone', () => {
    expect(isAwsChunkedBody({})).toBe(false);
    expect(isAwsChunkedBody({ 'content-encoding': 'gzip' })).toBe(false);
    expect(isAwsChunkedBody({ 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' })).toBe(false);
  });
});

describe('decodeAwsChunkedBody', () => {
  it('decodes signed chunks', () => {
    const body = Buffer.from(signedChunk('Hello ') + signedChunk('world') + `0;chunk-signature=${'ab'.repeat(32)}\r\n\r\n`);
    expect(decodeAwsChunkedBody(body).toString('utf8')).toBe('Hello world');
  });

  it('decodes the unsigned variant', () => {
    const body = Buffer.from(unsignedChunk('binary\x00data') + unsignedChunk('!') + '0\r\n\r\n');
    expect(decodeAwsChunkedBody(body).toString('latin1')).toBe('binary\x00data!');
  });

  it('drops trailer checksums after the final chunk', () => {
    const body = Buffer.from(
      unsignedChunk('payload') + '0\r\nx-amz-checksum-crc32:sOO8/Q==\r\nx-amz-trailer-signature:abcd\r\n\r\n',
    );
    expect(decodeAwsChunkedBody(body).toString('utf8')).toBe('payload');
  });

  it('handles multi-byte sizes and preserves binary bytes exactly', () => {
    const data = Buffer.alloc(300, 7);
    const body = Buffer.concat([
      Buffer.from(`${(300).toString(16)};chunk-signature=00\r\n`),
      data,
      Buffer.from('\r\n0\r\n\r\n'),
    ]);
    expect(decodeAwsChunkedBody(body).equals(data)).toBe(true);
  });

  it('throws IncompleteBody on a missing size-line terminator', () => {
    expect(() => decodeAwsChunkedBody(Buffer.from('5;chunk-signature=ab'))).toThrow(AwsError);
    try {
      decodeAwsChunkedBody(Buffer.from('5;chunk-signature=ab'));
    } catch (err) {
      expect((err as AwsError).code).toBe('IncompleteBody');
      expect((err as AwsError).status).toBe(400);
    }
  });

  it('throws on a non-hex chunk size', () => {
    expect(() => decodeAwsChunkedBody(Buffer.from('zz\r\nhi\r\n0\r\n\r\n'))).toThrow(/invalid chunk size/);
  });

  it('throws on truncated chunk data', () => {
    expect(() => decodeAwsChunkedBody(Buffer.from('a\r\nshort\r\n'))).toThrow(/chunk data truncated/);
  });

  it('throws when a chunk is not CRLF-terminated', () => {
    expect(() => decodeAwsChunkedBody(Buffer.from('5\r\nhelloXX0\r\n\r\n'))).toThrow(
      /missing chunk data terminator/,
    );
  });
});
