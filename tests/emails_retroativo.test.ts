import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { vincularCommitsOrfaos } from '../src/services/emails.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    commit: {
      updateMany: vi.fn(),
    },
  },
}));

describe('vincularCommitsOrfaos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.commit.updateMany).mockResolvedValue({ count: 3 } as any);
  });

  it('liga commits órfãos cujo autor_email bate com um e-mail do usuário', async () => {
    const n = await vincularCommitsOrfaos(7, ['Aluno@Exemplo.com']);

    expect(n).toBe(3);
    expect(prisma.commit.updateMany).toHaveBeenCalledWith({
      // Só órfãos: um commit já atribuído a outro aluno não é reatribuído aqui.
      where: { autor_usuario_id: null, autor_email: { in: ['aluno@exemplo.com'] } },
      data: { autor_usuario_id: 7 },
    });
  });

  it('normaliza caixa e remove duplicatas antes de consultar', async () => {
    await vincularCommitsOrfaos(7, ['A@x.com', 'a@x.com', '12+jo@users.noreply.github.com']);

    expect(prisma.commit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          autor_email: { in: ['a@x.com', '12+jo@users.noreply.github.com'] },
        }),
      }),
    );
  });

  it('não consulta o banco quando não há e-mail', async () => {
    expect(await vincularCommitsOrfaos(7, [])).toBe(0);
    expect(prisma.commit.updateMany).not.toHaveBeenCalled();
  });
});
