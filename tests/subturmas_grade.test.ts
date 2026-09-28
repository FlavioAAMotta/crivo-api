import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { signToken } from '../src/lib/auth.js';

vi.mock('bullmq', () => ({ Queue: class { add = vi.fn(); }, Worker: class { on = vi.fn(); } }));
vi.mock('../src/lib/prisma.js', () => ({ prisma: {
  trabalho: { findFirst: vi.fn() },
  repositorio: { findMany: vi.fn() },
  matricula: { findMany: vi.fn() },
  equipe: { findMany: vi.fn() },
} }));

const auth = { authorization: `Bearer ${signToken({ id: 1, github_id: '1', github_login: 'prof', papel: 'PROFESSOR' })}` };

describe('grade de trabalho compartilhado', () => {
  const app = buildApp();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.trabalho.findFirst).mockResolvedValue({ id: 7, turma_id: 1, tipo: 'INDIVIDUAL',
      deadline: new Date(Date.now() + 86400000), janela_inicio: new Date(), congelamento_automatico: true } as any);
    vi.mocked(prisma.repositorio.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([{ usuario_id: 20,
      usuario: { nome: 'Aluno da subturma B', github_login: 'alunob' } }] as any);
  });

  it('mostra o aluno sem repo na subturma vinculada', async () => {
    const response = await app.inject({ method: 'GET', url: '/prof/turmas/2/grade?trabalho_id=7', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{ dono: 'Aluno da subturma B', status: 'sem repo' }]);
    expect(vi.mocked(prisma.trabalho.findFirst).mock.calls[0][0].where).toMatchObject({
      OR: [{ turma_id: 2 }, { turmas_vinculadas: { some: { turma_id: 2 } } }],
    });
  });

  it('recusa grade em turma sem vínculo', async () => {
    vi.mocked(prisma.trabalho.findFirst).mockResolvedValue(null as any);
    const response = await app.inject({ method: 'GET', url: '/prof/turmas/3/grade?trabalho_id=7', headers: auth });
    expect(response.statusCode).toBe(404);
  });

  it('mostra a mesma equipe mista em ambas as subturmas sem duplicar o repositório', async () => {
    vi.mocked(prisma.trabalho.findFirst).mockResolvedValue({ id: 7, turma_id: 1, tipo: 'EQUIPE',
      deadline: new Date(Date.now() + 86400000), janela_inicio: new Date(), congelamento_automatico: true } as any);
    vi.mocked(prisma.matricula.findMany).mockImplementation((async ({ where }: any) => [
      { usuario_id: where.turma_id === 1 ? 10 : 20,
        usuario: { nome: 'Aluno', github_login: where.turma_id === 1 ? 'alunoa' : 'alunob' } },
    ]) as any);
    vi.mocked(prisma.repositorio.findMany).mockResolvedValue([{ id: 55, trabalho_id: 7, equipe_id: 3,
      dono_tipo: 'EQUIPE', nome_completo: 'org/trabalho-equipe-3', setup_status: 'CONFIGURADO', setup_erro: null,
      equipe: { id: 3, nome: 'Mista', membros: [
        { usuario_id: 10, usuario: { github_login: 'alunoa' } },
        { usuario_id: 20, usuario: { github_login: 'alunob' } },
      ] }, pushes: [], entregas: [], sinalizacoes: [], commits: [],
    }] as any);
    vi.mocked(prisma.equipe.findMany).mockResolvedValue([] as any);

    for (const turmaId of [1, 2]) {
      const response = await app.inject({ method: 'GET', url: `/prof/turmas/${turmaId}/grade?trabalho_id=7`, headers: auth });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject([{ repositorio_id: 55, dono: 'Equipe: Mista',
        membros: ['alunoa', 'alunob'] }]);
      expect(response.json()).toHaveLength(1);
    }
  });
});
