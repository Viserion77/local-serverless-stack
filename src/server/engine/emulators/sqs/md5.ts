// SQS response digests. SDKs (JS v2, botocore) validate MD5OfMessageBody and
// MD5OfMessageAttributes client-side and throw on mismatch, so these must
// match AWS byte-for-byte. Attribute digest algorithm per the SQS developer
// guide ("Calculating the MD5 message digest for message attributes"):
// attributes sorted by name, each encoded as
//   len(name) + name + len(dataType) + dataType + transportByte + len(value) + value
// with 4-byte big-endian lengths and transport byte 1 for String/Number
// values, 2 for Binary values.

import crypto from 'crypto';

// Wire shape of one message attribute in the SQS JSON protocol. BinaryValue
// travels base64-encoded; custom type labels ("String.foo", "Binary.bar")
// keep their base type's transport encoding.
export interface SqsMessageAttributeValue {
  DataType: string;
  StringValue?: string;
  BinaryValue?: string;
}

export function md5OfMessageBody(body: string): string {
  return crypto.createHash('md5').update(body, 'utf8').digest('hex');
}

function lengthPrefixed(value: Buffer): Buffer[] {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return [length, value];
}

export function md5OfMessageAttributes(
  attributes: Record<string, SqsMessageAttributeValue>,
): string {
  const parts: Buffer[] = [];
  for (const name of Object.keys(attributes).sort()) {
    const attribute = attributes[name];
    const dataType = attribute.DataType || 'String';
    parts.push(...lengthPrefixed(Buffer.from(name, 'utf8')));
    parts.push(...lengthPrefixed(Buffer.from(dataType, 'utf8')));
    if (dataType.startsWith('Binary')) {
      parts.push(Buffer.from([2]));
      parts.push(...lengthPrefixed(Buffer.from(attribute.BinaryValue ?? '', 'base64')));
    } else {
      parts.push(Buffer.from([1]));
      parts.push(...lengthPrefixed(Buffer.from(attribute.StringValue ?? '', 'utf8')));
    }
  }
  return crypto.createHash('md5').update(Buffer.concat(parts)).digest('hex');
}
