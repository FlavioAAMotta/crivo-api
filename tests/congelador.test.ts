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
    },
  };
});

// Mock Octokit App Helper
const mockOctokit = {
  rest: {
    repos: {
      getBranch: vi.fn(),
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
