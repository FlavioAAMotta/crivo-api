/**
 * Diagnóstico do 404 "Not Found" ao gerar repositório a partir do template.
 *
 *   npx tsx scripts/diagnostico-template.ts owner/repo
 *
 * O endpoint `POST /repos/{owner}/{repo}/generate` responde **404 para quatro
 * causas diferentes** — repositório invisível para a instalação, repositório que
 * não é template, App sem permissão de criar repositório na org, e App não
 * instalado. A mensagem é a mesma nos quatro casos; este script pergunta ao
 * GitHub o que dá para perguntar sem criar nada e diz qual é.
 *
 * Só faz leitura: nenhum repositório é criado ou alterado.
 */
import { config } from '../src/lib/config.js';
import { getGithubApp, getInstallationOctokit } from '../src/lib/octokit.js';

const alvo = process.argv[2];

if (!alvo || !alvo.includes('/')) {
  console.error('Uso: npx tsx scripts/diagnostico-template.ts owner/repo');
  process.exit(1);
}

const [templateOwner, templateRepo] = alvo.split('/');

function ok(msg: string) {
  console.log(`  [ok]    ${msg}`);
}
function falha(msg: string) {
  console.log(`  [FALHA] ${msg}`);
}
function info(msg: string) {
  console.log(`  ·       ${msg}`);
}

const conclusoes: string[] = [];

async function main() {
  console.log(`\nTemplate declarado no trabalho: ${templateOwner}/${templateRepo}`);
  console.log(`Org de destino (GITHUB_ORG):    ${config.GITHUB_ORG}`);
  console.log(`App id:                         ${config.GITHUB_APP_ID}\n`);

  if (!config.GITHUB_PRIVATE_KEY) {
    console.error('GITHUB_PRIVATE_KEY não está no ambiente — rode com as variáveis de produção.');
    process.exit(1);
  }

  // ---- 1. O App está instalado na org de destino? -------------------------
  console.log('1. Instalação do App na org');
  let installation;
  try {
    const { data } = await getGithubApp().octokit.rest.apps.getOrgInstallation({
      org: config.GITHUB_ORG,
    });
    installation = data;
    ok(`instalado (installation id ${data.id})`);
  } catch (err: any) {
    falha(`getOrgInstallation devolveu ${err.status}: ${err.message}`);
    conclusoes.push(
      `O App não está instalado em "${config.GITHUB_ORG}" (ou GITHUB_ORG está errado). ` +
        'Instale em Settings → GitHub Apps → Install, ou corrija a variável.',
    );
    return;
  }

  // ---- 2. A instalação pode criar repositório na org? ---------------------
  console.log('\n2. Permissões da instalação');
  const permissoes = (installation.permissions ?? {}) as Record<string, string>;
  info(`repository_selection: ${installation.repository_selection}`);
  info(`permissões concedidas: ${JSON.stringify(permissoes)}`);

  if (permissoes.administration === 'write') {
    ok('administration: write — pode criar repositório na org');
  } else {
    falha(`administration está "${permissoes.administration ?? 'ausente'}", precisa ser "write"`);
    conclusoes.push(
      'A instalação não tem Administration: write. Se você já marcou essa permissão na página ' +
        'do App, ela fica PENDENTE até um owner da org aprovar: org → Settings → GitHub Apps → ' +
        'Configure → banner "review and accept new permissions".',
    );
  }

  // ---- 3. A instalação enxerga o template? -------------------------------
  console.log('\n3. Template visto pelo token da instalação');
  const octokit = await getInstallationOctokit();
  let repo;
  try {
    const { data } = await octokit.rest.repos.get({ owner: templateOwner, repo: templateRepo });
    repo = data;
    ok(`visível como ${data.full_name} (privado: ${data.private})`);
  } catch (err: any) {
    falha(`repos.get devolveu ${err.status}: ${err.message}`);
    if (templateOwner.toLowerCase() !== config.GITHUB_ORG.toLowerCase()) {
      conclusoes.push(
        `O template está em "${templateOwner}", fora da org "${config.GITHUB_ORG}" onde o App está ` +
          'instalado. O token da instalação não enxerga repositório de outro dono — mova o template ' +
          'para a org, ou instale o App também no outro dono.',
      );
    } else {
      conclusoes.push(
        'O template existe no navegador mas é invisível para o App: a instalação está em "Only ' +
          'select repositories" e este repositório não está na lista. Org → Settings → GitHub Apps → ' +
          'Configure → Repository access, e adicione o template (ou marque All repositories).',
      );
    }
    return;
  }

  // ---- 4. O repositório é template? --------------------------------------
  console.log('\n4. Marcação de template');
  if (repo.is_template) {
    ok('is_template: true');
  } else {
    falha('is_template: false — o endpoint /generate devolve 404 para repositório comum');
    conclusoes.push(
      `Marque a caixinha "Template repository" em https://github.com/${repo.full_name}/settings ` +
        '(é a causa mais comum: o repositório existe e abre no navegador, mas não é template).',
    );
  }

  if (repo.archived) {
    falha('o repositório está arquivado — não serve como template');
    conclusoes.push(`Desarquive https://github.com/${repo.full_name}.`);
  }

  const branchPadrao = repo.default_branch;
  if (branchPadrao !== 'main') {
    info(`branch padrão é "${branchPadrao}", não "main"`);
    conclusoes.push(
      `A branch padrão do template é "${branchPadrao}". O repositório vai nascer, mas o setup ` +
        '(colaboradores e proteção) espera "main" e cairá em setup_status=ERRO.',
    );
  }

  if (repo.size === 0) {
    info('o template está vazio (size 0) — /generate falha em repositório sem nenhum commit');
    conclusoes.push(`Faça ao menos um commit em https://github.com/${repo.full_name}.`);
  }
}

main()
  .then(() => {
    console.log('\n---');
    if (conclusoes.length === 0) {
      console.log(
        'Nenhuma causa conhecida encontrada: o App enxerga o template, ele é template e há ' +
          'permissão de criar repositório. Se ainda assim der 404, confira se o nome do novo ' +
          'repositório já existe na org (aí o erro real seria 422) e olhe o log do worker.',
      );
    } else {
      console.log('Causa(s) encontrada(s):\n');
      conclusoes.forEach((c, i) => console.log(`${i + 1}. ${c}\n`));
    }
  })
  .catch((err) => {
    console.error('\nO diagnóstico falhou antes de concluir:', err);
    process.exit(1);
  });
