import { describe, it, expect } from 'vitest';
import { serializeBigInt } from '../src/lib/serializer.js';

describe('serializeBigInt', () => {
  it('converte BigInt para string, inclusive aninhado', () => {
    const out = serializeBigInt({
      github_id: 123n,
      repos: [{ github_repo_id: 456n }],
    });
    expect(out).toEqual({ github_id: '123', repos: [{ github_repo_id: '456' }] });
  });

  it('preserva Date como ISO em vez de virar {}', () => {
    // Regressão: `Date` é `typeof 'object'` sem chaves próprias, então o ramo
    // genérico de objeto a transformava em `{}`. O front chama
    // `committed_em.split('T')` e quebrava a página do repositório.
    const d = new Date('2026-07-23T15:13:00.000Z');
    const out = serializeBigInt({ commits: [{ committed_em: d }] });
    expect(out.commits[0].committed_em).toBe('2026-07-23T15:13:00.000Z');
  });

  it('mantém null, undefined e escalares', () => {
    expect(serializeBigInt(null)).toBeNull();
    expect(serializeBigInt(undefined)).toBeUndefined();
    expect(serializeBigInt({ a: 1, b: 'x', c: true, d: null })).toEqual({
      a: 1,
      b: 'x',
      c: true,
      d: null,
    });
  });
});
