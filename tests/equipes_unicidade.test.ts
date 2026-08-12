import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { signToken } from '../src/lib/auth.js';

// Evita conexões reais com Redis ao importar as filas
vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    trabalho: { findUnique: vi.fn() },
    equipe: { findUnique: vi.fn() },
    equipeMembro: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const ALUNO = { id: 2, github_id: '222', github_login: 'joaopsilva', papel: 'ALUNO' as const };
const auth = { authorization: `Bearer ${signToken(ALUNO)}` };

/**
 * Um aluno em dois grupos do mesmo trabalho deixaria dois repositórios
 * reivindicando a mesma entrega. A restrição é por trabalho — em outro trabalho
 * o mesmo aluno pode (e deve poder) montar outro grupo.
 */
describe('um aluno, uma equipe por trabalho', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: any) =>
      fn({
        equipe: { create: vi.fn().mockResolvedValue({ id: 9, trabalho_id: 7, nome: 'Grupo 01' }) },
        equipeMembro: { create: vi.fn().mockResolvedValue({ equipe_id: 9, usuario_id: ALUNO.id }) },
      })) as any);
  });

  it('recusa criar um segundo grupo no mesmo trabalho', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({
      id: 7,
      tipo: 'EQUIPE',
      janela_inicio: new Date(Date.now() - 3600_000),
      turma: { matriculas: [{ usuario_id: ALUNO.id }] },
    } as any);
    vi.mocked(prisma.equipeMembro.findFirst).mockResolvedValue({ equipe_id: 3, usuario_id: ALUNO.id } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/trabalhos/7/equipes',
      headers: auth,
      payload: { nome: 'Grupo 02' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/already belongs to a team/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('permite criar grupo quando o aluno só tem equipe em OUTRO trabalho', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({
      id: 7,
      tipo: 'EQUIPE',
      janela_inicio: new Date(Date.now() - 3600_000),
      turma: { matriculas: [{ usuario_id: ALUNO.id }] },
    } as any);
    // O filtro é por `equipe.trabalho_id`: a equipe do outro trabalho não casa.
    vi.mocked(prisma.equipeMembro.findFirst).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'POST',
      url: '/trabalhos/7/equipes',
      headers: auth,
      payload: { nome: 'Grupo 01' },
    });

    expect(response.statusCode).toBe(201);
    expect(vi.mocked(prisma.equipeMembro.findFirst).mock.calls[0][0]).toMatchObject({
      where: { usuario_id: ALUNO.id, equipe: { trabalho_id: 7 } },
    });
  });

  it('recusa adicionar colega que já está em outro grupo do mesmo trabalho', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 9,
      trabalho_id: 7,
      membros: [{ usuario_id: ALUNO.id }],
      trabalho: { turma: { matriculas: [{ usuario_id: ALUNO.id }, { usuario_id: 5 }] } },
    } as any);
    vi.mocked(prisma.equipeMembro.findFirst).mockResolvedValue({ equipe_id: 4, usuario_id: 5 } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/equipes/9/membros',
      headers: auth,
      payload: { usuario_id: 5 },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/another team/);
    expect(prisma.equipeMembro.create).not.toHaveBeenCalled();
  });

  it('adiciona o colega quando ele não está em nenhum grupo do trabalho', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 9,
      trabalho_id: 7,
      membros: [{ usuario_id: ALUNO.id }],
      trabalho: { turma: { matriculas: [{ usuario_id: ALUNO.id }, { usuario_id: 5 }] } },
    } as any);
    vi.mocked(prisma.equipeMembro.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.equipeMembro.create).mockResolvedValue({ equipe_id: 9, usuario_id: 5 } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/equipes/9/membros',
      headers: auth,
      payload: { usuario_id: 5 },
    });

    expect(response.statusCode).toBe(201);
  });
});
