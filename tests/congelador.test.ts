import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { getInstallationOctokit } from '../src/lib/octokit.js';
import { runCongelador } from '../src/jobs/congelador.js';

// Mock Prisma
vi.mock('../src/lib/prisma.js', () => {
  return {
    prisma: {
      trabalho: {
        findMany: vi.fn(),
      },
      entrega: {
        create: vi.fn(),
      },
      entregaAgendada: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
    },
  };
});

// Mock Octokit App Helper
const mockOctokit = {
  rest: {
    repos: {
      getBranch: vi.fn(),
      listCommits: vi.fn(),
    },
    git: {
      createRef: vi.fn(),
    },
  },
};

vi.mock('../src/lib/octokit.js', () => {
  return {
    getInstallationOctokit: vi.fn(() => mockOctokit),
    withGithubRetry: vi.fn((fn) => fn()),
    config: { GITHUB_ORG: 'faminas-ads' }
  };
});

describe('Congelador Job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sem trabalhoId, runCongelador também varre marcos agendados vencidos —
    // vazio por padrão, os testes de deadline não têm nenhum.
    vi.mocked(prisma.entregaAgendada.findMany).mockResolvedValue([]);
  });

  it('should get main HEAD commit from GitHub and create tag ref and Entrega log in database', async () => {
    const expiredTrabalhos = [
      {
        id: 10,
        titulo: 'ED Trabalho 1',
        congelamento_automatico: true,
        deadline: new Date('2026-07-15T00:00:00Z'),
        repositorios: [
          {
            id: 22,
            nome_completo: 'faminas-ads/ed-t1-aluno1',
            entregas: [], // no entrega yet
          },
        ],
      },
    ];

    vi.mocked(prisma.trabalho.findMany).mockResolvedValue(expiredTrabalhos as any);
    
    // Mock Octokit getBranch response
    mockOctokit.rest.repos.getBranch.mockResolvedValue({
      data: {
        commit: { sha: 'branchheadsha111' },
      },
    } as any);

    // Mock Git createRef response
    mockOctokit.rest.git.createRef.mockResolvedValue({} as any);

    await runCongelador();

    // Verify branch head fetched
    expect(mockOctokit.rest.repos.getBranch).toHaveBeenCalledWith({
      owner: 'faminas-ads',
      repo: 'ed-t1-aluno1',
      branch: 'main',
    });

    // Verify GitHub tag ref created
    expect(mockOctokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: 'faminas-ads',
      repo: 'ed-t1-aluno1',
      ref: 'refs/tags/entrega-1',
      sha: 'branchheadsha111',
    });

    // Verify Entrega record saved in DB
    expect(prisma.entrega.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositorio_id: 22,
        trabalho_id: 10,
        sha_congelado: 'branchheadsha111',
        tag: 'entrega-1',
      }),
    });
  });

  it('should complete successfully even if GitHub tag already exists (idempotency)', async () => {
    const expiredTrabalhos = [
      {
        id: 10,
        congelamento_automatico: true,
        deadline: new Date('2026-07-15T00:00:00Z'),
        repositorios: [
          {
            id: 22,
            nome_completo: 'faminas-ads/ed-t1-aluno1',
            entregas: [],
          },
        ],
      },
    ];

    vi.mocked(prisma.trabalho.findMany).mockResolvedValue(expiredTrabalhos as any);
    
    mockOctokit.rest.repos.getBranch.mockResolvedValue({
      data: { commit: { sha: 'branchheadsha111' } },
    } as any);

    // Mock that tag creation throws 422 Reference already exists
    const error422 = new Error('Reference already exists');
    (error422 as any).status = 422;
    mockOctokit.rest.git.createRef.mockRejectedValue(error422);

    await runCongelador();

    // Verify that despite GitHub throwing 422, it proceeds to save Entrega in database
    expect(prisma.entrega.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositorio_id: 22,
        trabalho_id: 10,
        sha_congelado: 'branchheadsha111',
        tag: 'entrega-1',
      }),
    });
  });
});

describe('Congelador Job — marco agendado (EntregaAgendada)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('congela usando o commit que era HEAD de main na data do marco, não o HEAD atual', async () => {
    const marco = {
      id: 5,
      trabalho_id: 10,
      data_hora: new Date('2026-08-01T19:00:00Z'),
      trabalho: {
        repositorios: [
          {
            id: 22,
            nome_completo: 'faminas-ads/ed-t1-aluno1',
            entregas: [], // ainda não tem entrega para este marco
          },
        ],
      },
    };

    vi.mocked(prisma.entregaAgendada.findUnique).mockResolvedValue(marco as any);
    mockOctokit.rest.repos.listCommits.mockResolvedValue({
      data: [{ sha: 'shanaepoca222' }],
    } as any);
    mockOctokit.rest.git.createRef.mockResolvedValue({} as any);

    await runCongelador({ entregaAgendadaId: 5 });

    expect(mockOctokit.rest.repos.listCommits).toHaveBeenCalledWith({
      owner: 'faminas-ads',
      repo: 'ed-t1-aluno1',
      sha: 'main',
      until: '2026-08-01T19:00:00.000Z',
      per_page: 1,
    });
    // Não deve consultar o HEAD atual — a fonte é sempre a data do marco.
    expect(mockOctokit.rest.repos.getBranch).not.toHaveBeenCalled();

    expect(mockOctokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: 'faminas-ads',
      repo: 'ed-t1-aluno1',
      ref: 'refs/tags/entrega-1',
      sha: 'shanaepoca222',
    });

    expect(prisma.entrega.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositorio_id: 22,
        trabalho_id: 10,
        entrega_agendada_id: 5,
        sha_congelado: 'shanaepoca222',
        tag: 'entrega-1',
      }),
    });
  });

  it('pula o repositório sem nenhum commit até a data do marco, sem criar Entrega', async () => {
    const marco = {
      id: 5,
      trabalho_id: 10,
      data_hora: new Date('2026-08-01T19:00:00Z'),
      trabalho: {
        repositorios: [
          { id: 22, nome_completo: 'faminas-ads/ed-t1-aluno1', entregas: [] },
        ],
      },
    };

    vi.mocked(prisma.entregaAgendada.findUnique).mockResolvedValue(marco as any);
    mockOctokit.rest.repos.listCommits.mockResolvedValue({ data: [] } as any);

    await runCongelador({ entregaAgendadaId: 5 });

    expect(mockOctokit.rest.git.createRef).not.toHaveBeenCalled();
    expect(prisma.entrega.create).not.toHaveBeenCalled();
  });

  it('é idempotente: repositório que já tem entrega para este marco é pulado sem force', async () => {
    const marco = {
      id: 5,
      trabalho_id: 10,
      data_hora: new Date('2026-08-01T19:00:00Z'),
      trabalho: {
        repositorios: [
          {
            id: 22,
            nome_completo: 'faminas-ads/ed-t1-aluno1',
            entregas: [{ entrega_agendada_id: 5 }],
          },
        ],
      },
    };

    vi.mocked(prisma.entregaAgendada.findUnique).mockResolvedValue(marco as any);

    await runCongelador({ entregaAgendadaId: 5 });

    expect(mockOctokit.rest.repos.listCommits).not.toHaveBeenCalled();
    expect(prisma.entrega.create).not.toHaveBeenCalled();
  });

  it('force=true recongela um repositório já congelado para este marco, gerando entrega-N+1', async () => {
    const marco = {
      id: 5,
      trabalho_id: 10,
      data_hora: new Date('2026-08-01T19:00:00Z'),
      trabalho: {
        repositorios: [
          {
            id: 22,
            nome_completo: 'faminas-ads/ed-t1-aluno1',
            entregas: [{ entrega_agendada_id: 5 }],
          },
        ],
      },
    };

    vi.mocked(prisma.entregaAgendada.findUnique).mockResolvedValue(marco as any);
    mockOctokit.rest.repos.listCommits.mockResolvedValue({ data: [{ sha: 'novosha333' }] } as any);
    mockOctokit.rest.git.createRef.mockResolvedValue({} as any);

    await runCongelador({ entregaAgendadaId: 5, force: true });

    expect(prisma.entrega.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tag: 'entrega-2', sha_congelado: 'novosha333' }),
    });
  });
});
