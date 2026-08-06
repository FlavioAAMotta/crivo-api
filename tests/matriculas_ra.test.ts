import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { signToken } from '../src/lib/auth.js';
import { getInstallationOctokit } from '../src/lib/octokit.js';

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    usuario: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    matricula: { upsert: vi.fn(), findMany: vi.fn() },
    trabalho: { findFirst: vi.fn() },
    equipe: { findMany: vi.fn() },
    repositorio: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock('../src/lib/octokit.js', () => ({
  getInstallationOctokit: vi.fn(),
  withGithubRetry: (fn: any) => fn(),
}));

const PROFESSOR = { id: 1, github_id: '1', github_login: 'prof1', papel: 'PROFESSOR' as const };
const authProf = { authorization: `Bearer ${signToken(PROFESSOR)}` };

describe('POST /prof/turmas/:id/matriculas (RA)', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exige papel professor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/prof/turmas/5/matriculas',
      payload: { matriculas: [{ ra: '25-13353', nome: 'Breno Moreira Soares' }] },
    });
    expect(response.statusCode).toBe(401);
  });

  it('cria usuario novo por RA sem tocar em github_id/github_login e vincula a turma', async () => {
    vi.mocked(prisma.usuario.upsert).mockResolvedValue({ id: 50, matricula: '25-13353' } as any);
    vi.mocked(prisma.matricula.upsert).mockResolvedValue({} as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/turmas/5/matriculas',
      headers: authProf,
      payload: { matriculas: [{ ra: '25-13353', nome: 'Breno Moreira Soares' }] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.imported).toEqual(['25-13353']);
    expect(prisma.usuario.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matricula: '25-13353' },
        create: expect.objectContaining({
          matricula: '25-13353',
          nome: 'Breno Moreira Soares',
          papel: 'ALUNO',
          github_id: null,
          github_login: null,
          senha_hash: null,
        }),
      }),
    );
    expect(prisma.matricula.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { usuario_id_turma_id: { usuario_id: 50, turma_id: 5 } },
      }),
    );
  });
});

describe('GET /prof/turmas/:id/matriculas', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lista o status de ativação de cada matriculado', async () => {
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([
      {
        usuario_id: 50,
        turma_id: 5,
        usuario: {
          id: 50,
          nome: 'Breno Moreira Soares',
          matricula: '25-13353',
          github_login: null,
          github_id: null,
          senha_hash: 'algum-hash',
        },
      },
    ] as any);

    const response = await app.inject({
      method: 'GET',
      url: '/prof/turmas/5/matriculas',
      headers: authProf,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual([
      {
        usuario_id: 50,
        nome: 'Breno Moreira Soares',
        matricula: '25-13353',
        github_login: null,
        senha_definida: true,
        vinculado: false,
      },
    ]);
  });
});

describe('POST /prof/alunos/:id/resetar-senha', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('404 quando o aluno não existe', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/alunos/999/resetar-senha',
      headers: authProf,
    });
    expect(response.statusCode).toBe(404);
  });

  it('409 quando o aluno já está vinculado ao GitHub', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      id: 50, papel: 'ALUNO', github_id: 123n,
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/alunos/50/resetar-senha',
      headers: authProf,
    });
    expect(response.statusCode).toBe(409);
  });

  it('zera senha_hash quando pendente de vínculo', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      id: 50, papel: 'ALUNO', github_id: null,
    } as any);
    vi.mocked(prisma.usuario.update).mockResolvedValue({ id: 50 } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/alunos/50/resetar-senha',
      headers: authProf,
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.usuario.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { senha_hash: null, senha_redefinida_em: null },
    });
  });
});

describe('POST /prof/alunos/:id/resetar-acesso', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('remove senha e vínculo do GitHub para refazer o primeiro acesso', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      id: 50, papel: 'ALUNO', github_id: 123n, github_login: 'breno',
    } as any);
    vi.mocked(prisma.usuario.update).mockResolvedValue({ id: 50 } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/alunos/50/resetar-acesso',
      headers: authProf,
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.usuario.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: {
        github_id: null,
        github_login: null,
        senha_hash: null,
        senha_redefinida_em: null,
      },
    });
  });

  it('404 quando o usuário não é aluno', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      id: 1, papel: 'PROFESSOR',
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/alunos/1/resetar-acesso',
      headers: authProf,
    });

    expect(response.statusCode).toBe(404);
    expect(prisma.usuario.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /prof/repositorios/:id', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exclui primeiro no GitHub e depois no banco', async () => {
    const excluirGithub = vi.fn().mockResolvedValue({});
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 20,
      nome_completo: 'faminas-ads/trabalho-aluno',
    } as any);
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: { repos: { delete: excluirGithub } },
    } as any);
    vi.mocked(prisma.repositorio.delete).mockResolvedValue({ id: 20 } as any);

    const response = await app.inject({
      method: 'DELETE',
      url: '/prof/repositorios/20',
      headers: authProf,
    });

    expect(response.statusCode).toBe(204);
    expect(excluirGithub).toHaveBeenCalledWith({
      owner: 'faminas-ads',
      repo: 'trabalho-aluno',
    });
    expect(prisma.repositorio.delete).toHaveBeenCalledWith({ where: { id: 20 } });
  });

  it('não toca no GitHub quando o repositório não existe no Crivo', async () => {
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue(null);

    const response = await app.inject({
      method: 'DELETE',
      url: '/prof/repositorios/999',
      headers: authProf,
    });

    expect(response.statusCode).toBe(404);
    expect(getInstallationOctokit).not.toHaveBeenCalled();
  });

  it('conclui no banco quando o repositório já não existe no GitHub', async () => {
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 20,
      nome_completo: 'faminas-ads/trabalho-aluno',
    } as any);
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: {
        repos: {
          delete: vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })),
        },
      },
    } as any);
    vi.mocked(prisma.repositorio.delete).mockResolvedValue({ id: 20 } as any);

    const response = await app.inject({
      method: 'DELETE',
      url: '/prof/repositorios/20',
      headers: authProf,
    });

    expect(response.statusCode).toBe(204);
    expect(prisma.repositorio.delete).toHaveBeenCalledWith({ where: { id: 20 } });
  });
});

describe('GET /prof/turmas/:id/grade após reset de acesso', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('usa o RA no membro de repo individual quando github_login é nulo', async () => {
    vi.mocked(prisma.trabalho.findFirst).mockResolvedValue({
      id: 7,
      turma_id: 5,
      tipo: 'INDIVIDUAL',
      janela_inicio: new Date(),
      deadline: new Date(Date.now() + 86_400_000),
      congelamento_automatico: true,
    } as any);
    vi.mocked(prisma.repositorio.findMany).mockResolvedValue([{
      id: 20,
      nome_completo: 'faminas-ads/trabalho-aluno',
      dono_tipo: 'ALUNO',
      usuario_id: 50,
      usuario: {
        id: 50,
        nome: 'Breno Moreira Soares',
        matricula: '25-13353',
        github_login: null,
      },
      equipe: null,
      entregas: [],
      sinalizacoes: [],
      pushes: [],
      commits: [],
      setup_status: 'CONFIGURADO',
      setup_erro: null,
    }] as any);
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([{
      usuario_id: 50,
      turma_id: 5,
      usuario: { id: 50, nome: 'Breno Moreira Soares', matricula: '25-13353' },
    }] as any);

    const response = await app.inject({
      method: 'GET',
      url: '/prof/turmas/5/grade?trabalho_id=7',
      headers: authProf,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)[0].membros).toEqual(['25-13353']);
  });
});
