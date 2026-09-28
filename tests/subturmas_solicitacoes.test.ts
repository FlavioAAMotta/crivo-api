import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { decideTeamRequest, requestTeamEntry } from '../src/services/team.js';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {
  equipe: { findUnique: vi.fn() },
  equipeMembro: { findFirst: vi.fn() },
  solicitacaoEquipe: { findUnique: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
} }));

const trabalho = { id: 7, turma_id: 1, max_integrantes_equipe: 4,
  turma: { matriculas: [] },
  turmas_vinculadas: [{ turma_id: 2, turma: { matriculas: [{ usuario_id: 20 }] } }],
};

describe('solicitações entre subturmas do mesmo trabalho', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({ id: 3, trabalho_id: 7,
      membros: [{ usuario_id: 10 }], formada_em: null, trabalho } as any);
    vi.mocked(prisma.equipeMembro.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.solicitacaoEquipe.findUnique).mockResolvedValue(null as any);
    vi.mocked(prisma.solicitacaoEquipe.create).mockResolvedValue({ id: 5 } as any);
  });

  it('aluno da subturma adicional pode pedir entrada', async () => {
    expect(await requestTeamEntry(3, 20)).toMatchObject({ id: 5 });
    expect(prisma.solicitacaoEquipe.create).toHaveBeenCalled();
  });

  it('aluno de turma não vinculada não pode pedir entrada', async () => {
    await expect(requestTeamEntry(3, 99)).rejects.toThrow('Você não pertence');
    expect(prisma.solicitacaoEquipe.create).not.toHaveBeenCalled();
  });

  it('aceite confere matrícula atual antes de criar o membro', async () => {
    const tx = {
      solicitacaoEquipe: { findUnique: vi.fn().mockResolvedValue({ id: 5, equipe_id: 3, usuario_id: 20,
        equipe: { id: 3, lider_id: 10, membros: [{ usuario_id: 10 }], formada_em: null, trabalho } }),
        deleteMany: vi.fn() },
      matricula: { count: vi.fn().mockResolvedValue(0) },
      equipeMembro: { findFirst: vi.fn(), create: vi.fn() },
    };
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: any) => fn(tx)) as any);
    await expect(decideTeamRequest(5, 10, true)).rejects.toThrow('não pertence');
    expect(tx.equipeMembro.create).not.toHaveBeenCalled();
    expect(tx.matricula.count).toHaveBeenCalledWith({ where: {
      usuario_id: 20, turma_id: { in: [1, 2] },
    } });
  });
});
