// Decoder for the aws-chunked content encoding. @aws-sdk v3 >= 3.729 enables
// flexible checksums by default, so every S3 PutObject arrives as:
//
//   <hex-size>[;chunk-signature=<sig>]\r\n<chunk bytes>\r\n ...
//   0[;chunk-signature=<sig>]\r\n[<trailer>:<value>\r\n ...]\r\n
//
// Without this decoder every upload from a current SDK would be persisted
// with the framing bytes baked in. Trailer checksums (x-amz-checksum-crc32
// etc.) are discarded, not verified — dev-tool fidelity bar.

import { AwsError } from './errors.js';

// Both the signed variant (content-encoding: aws-chunked) and the unsigned
// streaming variant advertise themselves via x-amz-content-sha256.
export function isAwsChunkedBody(headers: Record<string, string>): boolean {
  const encoding = headers['content-encoding'];
  if (encoding && encoding.split(',').some(token => token.trim() === 'aws-chunked')) return true;
  const contentSha = headers['x-amz-content-sha256'];
  return contentSha !== undefined && contentSha.startsWith('STREAMING-');
}

function malformed(reason: string): AwsError {
  return new AwsError('IncompleteBody', `Malformed aws-chunked request body: ${reason}`, { status: 400 });
}

export function decodeAwsChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const lineEnd = body.indexOf('\r\n', pos);
    if (lineEnd === -1) throw malformed('missing chunk-size line terminator');
    const sizeLine = body.subarray(pos, lineEnd).toString('latin1');
    const sizeHex = sizeLine.split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeHex)) throw malformed(`invalid chunk size "${sizeHex}"`);
    const size = parseInt(sizeHex, 16);
    pos = lineEnd + 2;
    // Final chunk: whatever follows is trailer headers (checksums) — dropped.
    if (size === 0) break;
    if (pos + size > body.length) throw malformed('chunk data truncated');
    chunks.push(body.subarray(pos, pos + size));
    pos += size;
    if (body.subarray(pos, pos + 2).toString('latin1') !== '\r\n') {
      throw malformed('missing chunk data terminator');
    }
    pos += 2;
  }
  return Buffer.concat(chunks);
}
