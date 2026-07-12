import crypto from 'crypto';
import {
  md5OfMessageAttributes,
  md5OfMessageBody,
} from '../../../../src/server/engine/emulators/sqs/md5.js';
import type { SqsMessageAttributeValue } from '../../../../src/server/engine/emulators/sqs/md5.js';

describe('SQS md5 digests', () => {
  test('MD5OfMessageBody is the hex md5 of the body string', () => {
    // Well-known md5('hello world').
    expect(md5OfMessageBody('hello world')).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
    expect(md5OfMessageBody('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  test('single String attribute matches the hand-computed fixture', () => {
    // Hand-derived per the documented algorithm:
    // len('Color') + 'Color' + len('String') + 'String' + 0x01 + len('gray') + 'gray'
    expect(md5OfMessageAttributes({ Color: { DataType: 'String', StringValue: 'gray' } })).toBe(
      '92cce3ef3a009c57dc8d0f28ecf36707',
    );
  });

  test('String + Number + Binary set matches the documented algorithm byte-for-byte', () => {
    const attributes: Record<string, SqsMessageAttributeValue> = {
      Population: { DataType: 'Number', StringValue: '1250800' },
      Color: { DataType: 'String', StringValue: 'gray' },
      Data: { DataType: 'Binary', BinaryValue: Buffer.from('hello').toString('base64') },
    };

    // Independent construction of the digest input: sorted names, 4-byte
    // big-endian length prefixes, transport byte 1 (string) / 2 (binary).
    const len4 = (buf: Buffer) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(buf.length, 0);
      return b;
    };
    const encodeString = (name: string, type: string, value: string) =>
      Buffer.concat([
        len4(Buffer.from(name)), Buffer.from(name),
        len4(Buffer.from(type)), Buffer.from(type),
        Buffer.from([1]),
        len4(Buffer.from(value)), Buffer.from(value),
      ]);
    const encodeBinary = (name: string, type: string, value: Buffer) =>
      Buffer.concat([
        len4(Buffer.from(name)), Buffer.from(name),
        len4(Buffer.from(type)), Buffer.from(type),
        Buffer.from([2]),
        len4(value), value,
      ]);
    const expected = crypto
      .createHash('md5')
      .update(
        Buffer.concat([
          encodeString('Color', 'String', 'gray'),
          encodeBinary('Data', 'Binary', Buffer.from('hello')),
          encodeString('Population', 'Number', '1250800'),
        ]),
      )
      .digest('hex');

    expect(md5OfMessageAttributes(attributes)).toBe(expected);
    // Pinned value from the same hand computation.
    expect(md5OfMessageAttributes(attributes)).toBe('40f7cbc2f05bf80157e9b2704d4d8d09');
  });

  test('digest is insertion-order independent (names are sorted)', () => {
    const a = md5OfMessageAttributes({
      Zeta: { DataType: 'String', StringValue: 'z' },
      Alpha: { DataType: 'Number', StringValue: '1' },
    });
    const b = md5OfMessageAttributes({
      Alpha: { DataType: 'Number', StringValue: '1' },
      Zeta: { DataType: 'String', StringValue: 'z' },
    });
    expect(a).toBe(b);
  });

  test('custom type labels keep their base transport encoding', () => {
    // 'String.custom' uses the string transport byte; 'Binary.custom' the
    // binary one — so equal-value attributes with different labels differ.
    const stringLabel = md5OfMessageAttributes({
      A: { DataType: 'String.custom', StringValue: 'x' },
    });
    const binaryLabel = md5OfMessageAttributes({
      A: { DataType: 'Binary.custom', BinaryValue: Buffer.from('x').toString('base64') },
    });
    expect(stringLabel).not.toBe(binaryLabel);

    const len4 = (buf: Buffer) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(buf.length, 0);
      return b;
    };
    const expected = crypto
      .createHash('md5')
      .update(
        Buffer.concat([
          len4(Buffer.from('A')), Buffer.from('A'),
          len4(Buffer.from('String.custom')), Buffer.from('String.custom'),
          Buffer.from([1]),
          len4(Buffer.from('x')), Buffer.from('x'),
        ]),
      )
      .digest('hex');
    expect(stringLabel).toBe(expected);
  });
});
