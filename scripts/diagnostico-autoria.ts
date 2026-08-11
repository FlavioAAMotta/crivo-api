/**
 * Diagnóstico do "N de N com autor declarado ≠ quem enviou o push".
 *
 *   npx tsx scripts/diagnostico-autoria.ts            # todos os repositórios com commit
 *   npx tsx scripts/diagnostico-autoria.ts 12         # só o repositório 12
 *   npx tsx scripts/diagnostico-autoria.ts --aplicar  # + religa os commits órfãos
 *
 * `getRepositoryMetrics` marca `divergente = true` em DUAS situações distintas
 * que a tela mostra com o mesmo texto: (a) autor resolvido cujo `github_login`
 * difere do pusher — divergência de verdade — e (b) autor não resolvido, ou
 * seja, o e-mail do commit não bateu com nenhum `EmailCommit`. Este script diz
 * qual das duas está acontecendo, commit a commit, e por quê.
 *
 * Sem `--aplicar` é somente leitura.
 */
import { prisma } from '../src/lib/prisma.js';
import { isBotLogin } from '../src/lib/identity.js';
import { vincularCommitsOrfaos } from '../src/services/emails.js';

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const repoIdArg = args.find((a) => /^\d+$/.test(a));

type Causa =
  | 'ok'
  | 'push_de_bot'
  | 'email_nao_cadastrado'
  | 'email_cadastrado_depois'
  | 'autor_sem_github_login'
  | 'divergencia_real';

const ROTULOS: Record<Causa, string> = {
  ok: 'autor = pusher (não divergente)',
  push_de_bot: 'commit de scaffold: push feito por bot, não é atividade de aluno',
  email_nao_cadastrado: 'e-mail do commit não está cadastrado para NENHUM usuário',
  email_cadastrado_depois: 'e-mail já cadastrado, mas o commit ficou órfão (chegou antes do cadastro)',
  autor_sem_github_login: 'autor resolvido, porém o usuário não tem github_login',
  divergencia_real: 'autor e pusher são contas diferentes',
};

async function main() {
  const repos = await prisma.repositorio.findMany({
    where: repoIdArg ? { id: Number(repoIdArg) } : { commits: { some: {} } },
    include: {
      usuario: true,
      equipe: { include: { membros: { include: { usuario: true } } } },
      commits: { include: { autor_usuario: true, push: true }, orderBy: { committed_em: 'asc' } },
    },
    orderBy: { id: 'asc' },
  });

  if (repos.length === 0) {
    console.log('Nenhum repositório com commits encontrado.');
    return;
  }

  const totais: Record<Causa, number> = {
    ok: 0,
    push_de_bot: 0,
    email_nao_cadastrado: 0,
    email_cadastrado_depois: 0,
    autor_sem_github_login: 0,
    divergencia_real: 0,
  };

  for (const repo of repos) {
    const donos = repo.equipe ? repo.equipe.membros.map((m) => m.usuario) : repo.usuario ? [repo.usuario] : [];

    console.log(`\n── repo ${repo.id} · ${repo.nome_completo} (${repo.commits.length} commits)`);
    for (const dono of donos) {
      const emails = await prisma.emailCommit.findMany({ where: { usuario_id: dono.id } });
      console.log(
        `   dono: ${dono.nome} · github_login=${dono.github_login ?? '(NULO)'} · ` +
          `e-mails: ${emails.length ? emails.map((e) => e.email).join(', ') : '(NENHUM)'}`,
      );
    }

    for (const c of repo.commits) {
      const pusher = c.push.pusher_login;
      const autorLogin = c.autor_usuario?.github_login ?? null;

      let causa: Causa;
      if (isBotLogin(pusher)) {
        causa = 'push_de_bot';
      } else if (!c.autor_usuario_id) {
        const dono = await prisma.emailCommit.findUnique({ where: { email: c.autor_email } });
        causa = dono ? 'email_cadastrado_depois' : 'email_nao_cadastrado';
      } else if (!autorLogin) {
        causa = 'autor_sem_github_login';
      } else if (autorLogin.toLowerCase() !== pusher.toLowerCase()) {
        causa = 'divergencia_real';
      } else {
        causa = 'ok';
      }
      totais[causa]++;

      const marca = causa === 'ok' ? ' ' : '!';
      console.log(
        `   ${marca} ${c.sha.slice(0, 7)} autor="${c.autor_nome}" <${c.autor_email}> ` +
          `→ ${autorLogin ?? '(não resolvido)'} | pusher=${pusher} | ${ROTULOS[causa]}`,
      );
    }
  }

  console.log('\n── resumo');
  for (const [causa, n] of Object.entries(totais)) {
    if (n > 0) console.log(`   ${String(n).padStart(4)} commits · ${ROTULOS[causa as Causa]}`);
  }

  if (totais.email_cadastrado_depois > 0) {
    console.log(
      `\n   ${totais.email_cadastrado_depois} commits têm dono cadastrado e só precisam ser religados.` +
        (aplicar ? '' : '\n   Rode de novo com --aplicar para religá-los.'),
    );
  }
  if (totais.email_nao_cadastrado > 0) {
    console.log(
      `\n   ${totais.email_nao_cadastrado} commits usam um e-mail que ninguém cadastrou.` +
        '\n   O aluno precisa adicioná-lo em /aluno/perfil (é o e-mail do `git config user.email`,' +
        '\n   que com "Keep my email private" no GitHub costuma ser ID+login@users.noreply.github.com).',
    );
  }

  if (aplicar) {
    console.log('\n── aplicando vínculo retroativo');
    const usuarios = await prisma.usuario.findMany({ include: { emails: true } });
    let total = 0;
    for (const u of usuarios) {
      if (u.emails.length === 0) continue;
      const n = await vincularCommitsOrfaos(u.id, u.emails.map((e) => e.email));
      if (n > 0) {
        console.log(`   ${n} commits religados a ${u.nome} (${u.github_login ?? 'sem login'})`);
        total += n;
      }
    }
    console.log(`   total: ${total} commits religados`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
