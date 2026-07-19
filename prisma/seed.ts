import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Crivo database with initial mockup datasets...');

  // 1. Seed Professor
  const prof = await prisma.usuario.upsert({
    where: { github_login: 'prof1' },
    update: {},
    create: {
      github_id: 111111n,
      github_login: 'prof1',
      nome: 'Prof. Crivo',
      papel: 'PROFESSOR',
    },
  });
  console.log('Seeded Professor:', prof.github_login);

  // 2. Seed Disciplina
  const disc = await prisma.disciplina.upsert({
    where: { codigo: 'ED-2026-2' },
    update: {},
    create: {
      codigo: 'ED-2026-2',
      nome: 'Estrutura de Dados',
    },
  });
  console.log('Seeded Disciplina:', disc.codigo);

  // 3. Seed Turmas (Subturmas A & B)
  const turmas = await prisma.turma.findMany({
    where: { disciplina_id: disc.id },
  });
  
  let turmaA;
  let turmaB;

  if (turmas.length < 2) {
    turmaA = await prisma.turma.create({
      data: {
        disciplina_id: disc.id,
        nome: 'Subturma A',
        periodo: '2026.2',
      },
    });
    turmaB = await prisma.turma.create({
      data: {
        disciplina_id: disc.id,
        nome: 'Subturma B',
        periodo: '2026.2',
      },
    });
  } else {
    turmaA = turmas[0];
    turmaB = turmas[1];
  }
  console.log('Seeded Turmas:', turmaA.nome, 'and', turmaB.nome);

  // 4. Seed Alunos
  const aluno1 = await prisma.usuario.upsert({
    where: { github_login: 'aluno1' },
    update: {},
    create: {
      github_id: 222222n,
      github_login: 'aluno1',
      nome: 'Aluno Um',
      papel: 'ALUNO',
      matricula: '12345678-A',
    },
  });

  const aluno2 = await prisma.usuario.upsert({
    where: { github_login: 'aluno2' },
    update: {},
    create: {
      github_id: 333333n,
      github_login: 'aluno2',
      nome: 'Aluno Dois',
      papel: 'ALUNO',
      matricula: '12345678-B',
    },
  });

  const aluno3 = await prisma.usuario.upsert({
    where: { github_login: 'aluno3' },
    update: {},
    create: {
      github_id: 444444n,
      github_login: 'aluno3',
      nome: 'Aluno Três',
      papel: 'ALUNO',
      matricula: '12345678-C',
    },
  });
  console.log('Seeded Alunos:', aluno1.github_login, aluno2.github_login, aluno3.github_login);

  // 5. Seed Matriculas
  await prisma.matricula.upsert({
    where: { usuario_id_turma_id: { usuario_id: aluno1.id, turma_id: turmaA.id } },
    update: {},
    create: { usuario_id: aluno1.id, turma_id: turmaA.id },
  });

  await prisma.matricula.upsert({
    where: { usuario_id_turma_id: { usuario_id: aluno2.id, turma_id: turmaA.id } },
    update: {},
    create: { usuario_id: aluno2.id, turma_id: turmaA.id },
  });

  await prisma.matricula.upsert({
    where: { usuario_id_turma_id: { usuario_id: aluno3.id, turma_id: turmaB.id } },
    update: {},
    create: { usuario_id: aluno3.id, turma_id: turmaB.id },
  });
  console.log('Seeded Matriculas');

  // 6. Seed Email Commits
  await prisma.emailCommit.upsert({
    where: { email: 'aluno1@gmail.com' },
    update: {},
    create: { usuario_id: aluno1.id, email: 'aluno1@gmail.com', verificado: true },
  });

  await prisma.emailCommit.upsert({
    where: { email: 'aluno2@gmail.com' },
    update: {},
    create: { usuario_id: aluno2.id, email: 'aluno2@gmail.com', verificado: true },
  });

  await prisma.emailCommit.upsert({
    where: { email: 'aluno3@gmail.com' },
    update: {},
    create: { usuario_id: aluno3.id, email: 'aluno3@gmail.com', verificado: true },
  });
  console.log('Seeded EmailCommit mappings');

  // 7. Seed Trabalhos (Individual and Team-based)
  const trabalho1 = await prisma.trabalho.create({
    data: {
      turma_id: turmaA.id,
      titulo: 'Trabalho 1: Lista Duplamente Encadeada',
      descricao_md: '# T1 - Lista Dupla\nImplemente uma lista duplamente encadeada em C ou TypeScript.',
      slug: 't1-listadupla',
      tipo: 'INDIVIDUAL',
      template_repo: 'faminas-ads/template-lista-dupla',
      janela_inicio: new Date(),
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
      congelamento_automatico: true,
    },
  });

  const trabalho2 = await prisma.trabalho.create({
    data: {
      turma_id: turmaA.id,
      titulo: 'Trabalho 2: Árvore Binária (Equipe)',
      descricao_md: '# T2 - Árvore Binária\nImplemente uma BST em equipe.',
      slug: 't2-bst',
      tipo: 'EQUIPE',
      template_repo: 'faminas-ads/template-bst',
      janela_inicio: new Date(),
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days from now
      congelamento_automatico: true,
    },
  });
  console.log('Seeded Trabalhos:', trabalho1.slug, 'and', trabalho2.slug);

  console.log('Database seeding successfully finished!');
}

main()
  .catch((e) => {
    console.error('Error during database seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
