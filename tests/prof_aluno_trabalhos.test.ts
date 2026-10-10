import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { signToken } from '../src/lib/auth.js';

vi.mock('bullmq', () => ({ Queue: class { add = vi.fn(); }, Worker: class { on = vi.fn(); } }));
vi.mock('../src/lib/prisma.js', () => ({ prisma: {
  matricula: { findUnique: vi.fn() }, trabalho: { findMany: vi.fn() },
} }));

const app = buildApp();
const url = '/prof/alunos/10/turmas/2/trabalhos';
const headers = { authorization: `Bearer ${signToken({ id: 1, papel: 'PROFESSOR', github_id: '1', github_login: 'prof' })}` };

describe('trabalhos do aluno para consulta de notas', () => {
  beforeEach(() => vi.resetAllMocks());

  it('exige professor', async () => {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const aluno = { authorization: `Bearer ${signToken({ id: 10, papel: 'ALUNO', github_id: '10', github_login: 'aluno' })}` };
    expect((await app.inject({ method: 'GET', url, headers: aluno })).statusCode).toBe(403);
  });

  it('não consulta uma turma onde o aluno não está matriculado', async () => {
    vi.mocked(prisma.matricula.findUnique).mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
    expect(prisma.trabalho.findMany).not.toHaveBeenCalled();
  });

  it('consulta por ID do dono ou membro, inclui subturmas, todas as entregas e commits sem autoria', async () => {
    vi.mocked(prisma.matricula.findUnique).mockResolvedValue({ usuario_id: 10, turma_id: 2 } as any);
    vi.mocked(prisma.trabalho.findMany).mockResolvedValue([
      { id: 5, titulo: 'Individual', repositorios: [{ id: 8, _count: { commits: 12 }, entregas: [{ id: 4, tag: 'entrega-1' }], avaliacao: { nota: 0 } }] },
      { id: 6, titulo: 'Equipe', repositorios: [{ id: 9, _count: { commits: 30 }, entregas: [], equipe: { nome: 'Grupo A' } }] },
      { id: 7, titulo: 'Sem repo', repositorios: [] },
    ] as any);
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0].repositorios[0]._count.commits).toBe(12);
    expect(response.json()[1].repositorios[0]._count.commits).toBe(30);
    expect(response.json()[2].repositorios).toEqual([]);
    const query = vi.mocked(prisma.trabalho.findMany).mock.calls[0][0] as any;
    expect(query.where.OR).toEqual([{ turma_id: 2 }, { turmas_vinculadas: { some: { turma_id: 2 } } }]);
    expect(query.select.repositorios.where.OR).toEqual([
      { dono_tipo: 'ALUNO', usuario_id: 10 },
      { dono_tipo: 'EQUIPE', equipe: { membros: { some: { usuario_id: 10 } } } },
    ]);
    expect(query.select.repositorios.select._count).toEqual({ select: { commits: true } });
    expect(query.select.repositorios.select.entregas).not.toHaveProperty('take');
  });

  it('recusa IDs inválidos', async () => {
    expect((await app.inject({ method: 'GET', url: '/prof/alunos/abc/turmas/2/trabalhos', headers })).statusCode).toBe(400);
  });
});
