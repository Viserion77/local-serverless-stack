// ProjectionExpression: deep document-path extraction preserving nesting,
// list compaction, overlapping paths and immutability of the source item.
import { applyProjection } from '../../../../src/server/engine/emulators/dynamodb/expressions';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap } from '../../../../src/server/engine/types';

function baseItem(): AttributeMap {
  return {
    id: { S: 'user-1' },
    age: { N: '30' },
    history: { L: [{ S: 'x' }, { N: '2' }, { M: { deep: { S: 'y' }, other: { S: 'o' } } }] },
    profile: { M: { name: { S: 'Ana' }, address: { M: { city: { S: 'SP' }, zip: { S: '01310' } } } } },
  };
}

function project(expression: string, names?: Record<string, string>): AttributeMap {
  return applyProjection(expression, baseItem(), { names });
}

describe('applyProjection', () => {
  it('projects top-level attributes', () => {
    expect(project('id, age')).toEqual({ id: { S: 'user-1' }, age: { N: '30' } });
  });

  it('projects nested map paths preserving structure', () => {
    expect(project('profile.name')).toEqual({ profile: { M: { name: { S: 'Ana' } } } });
    expect(project('profile.address.city')).toEqual({ profile: { M: { address: { M: { city: { S: 'SP' } } } } } });
    expect(project('profile.name, profile.address.zip')).toEqual({
      profile: { M: { name: { S: 'Ana' }, address: { M: { zip: { S: '01310' } } } } },
    });
  });

  it('projects list elements compacted in ascending index order', () => {
    expect(project('history[1]')).toEqual({ history: { L: [{ N: '2' }] } });
    expect(project('history[2], history[0]')).toEqual({
      history: { L: [{ S: 'x' }, { M: { deep: { S: 'y' }, other: { S: 'o' } } }] },
    });
    expect(project('history[2].deep')).toEqual({ history: { L: [{ M: { deep: { S: 'y' } } }] } });
  });

  it('omits missing paths entirely', () => {
    expect(project('ghost')).toEqual({});
    expect(project('profile.ghost')).toEqual({});
    expect(project('history[9]')).toEqual({});
    expect(project('id, ghost')).toEqual({ id: { S: 'user-1' } });
    expect(project('id[0]')).toEqual({}); // wrong-kind path: index into a scalar
    expect(project('profile[0]')).toEqual({}); // index into a map
  });

  it('handles overlapping paths in either order', () => {
    const whole = { profile: baseItem().profile };
    expect(project('profile, profile.name')).toEqual(whole);
    expect(project('profile.name, profile')).toEqual(whole);
    expect(project('id, id')).toEqual({ id: { S: 'user-1' } });
  });

  it('resolves #name placeholders', () => {
    expect(project('#p.#n', { '#p': 'profile', '#n': 'name' })).toEqual({ profile: { M: { name: { S: 'Ana' } } } });
  });

  it('does not alias or mutate the source item', () => {
    const item = baseItem();
    const snapshot = JSON.stringify(item);
    const result = applyProjection('profile.name, history[0]', item, {});
    result.profile.M!.name.S = 'mutated';
    result.history.L![0].S = 'mutated';
    expect(JSON.stringify(item)).toBe(snapshot);
  });

  it('throws AWS-worded errors for bad expressions', () => {
    const failures: Array<[string, RegExp | string]> = [
      ['', 'Invalid ProjectionExpression: The expression can not be empty;'],
      ['id,', /Invalid ProjectionExpression: Syntax error; token: "<EOF>"/],
      ['id age', /Invalid ProjectionExpression: Syntax error; token: "age"/],
      ['history[]', /Syntax error/],
      ['history[x]', /Syntax error/],
      ['#nope', 'An expression attribute name used in the document path is not defined; attribute name: #nope'],
    ];
    for (const [expression, pattern] of failures) {
      try {
        project(expression);
        throw new Error(`expected ValidationException for: ${expression}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AwsError);
        expect((err as AwsError).code).toBe('ValidationException');
        if (typeof pattern === 'string') expect((err as AwsError).message).toBe(pattern);
        else expect((err as AwsError).message).toMatch(pattern);
      }
    }
  });
});
