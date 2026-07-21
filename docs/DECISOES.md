# DECISOES.md — Registro de decisões do Crivo

> ADRs informais: o *porquê* de cada escolha estrutural, para que ninguém (humano ou IA) "melhore" o sistema desfazendo uma decisão que tinha razão de ser. Formato: decisão → contexto → justificativa → alternativa rejeitada e por quê. Operação em `OPERACAO.md`; orientação de código em `CLAUDE.md`.

---

## D1. Filosofia: o sistema sinaliza, o humano decide

**Decisão:** nenhuma métrica ou detector produz punição, nota ou juízo automático. Detectores geram `sinalizacoes` com evidência anexada; o professor revisa (PROCEDE/DESCARTADA) com **nota obrigatória**, e a decisão fica imutável (correção = nova sinalização manual).

**Justificativa:** (1) padrões suspeitos têm explicações legítimas — divergência pusher×autor em equipe pode ser pareamento na máquina de um só; sem atividade pode ser licença médica; o sistema não tem contexto, o professor tem. (2) Defensabilidade: numa contestação de nota, "decisão do professor informada por evidência datada" sustenta; "um script decidiu" não. (3) Pedagogia: sinalização é convite à conversa, não veredito — a diferença entre crivo e tribunal.

**Rejeitado:** score automático de contribuição / corte de nota por métrica. Linhas de código são trivialmente gameáveis (colar arquivo, reformatar tudo) e métrica punitiva ensina a burlar métrica, não a trabalhar.

**Corolário (transparência LGPD):** o aluno vê sobre si exatamente o que o professor vê (`GET /me/repositorios/:id/metricas`), incluindo sinalizações que o citam. Vigilância opaca educa menos do que medição declarada; e o professor que ensina LGPD aplicada entrega um sistema exemplar nisso.

## D2. Rastreabilidade: pusher é fato, autor é declaração

**Decisão:** o mecanismo central de veracidade é o cruzamento entre o **autor declarado** do commit e o **pusher autenticado** do push, capturado via webhook.

**Contexto:** a autoria de commit vem do `git config user.name/email` local — qualquer aluno commita "em nome" de qualquer colega, o Git não verifica nada. Medir contribuição só por autoria mede uma declaração falsificável.

**Justificativa:** o push exige autenticação real no GitHub; o payload do webhook entrega `sender` (quem empurrou, com certeza criptográfica) ao lado dos autores declarados de cada commit. Analogia canônica: o commit é a carta (remetente escrito à mão); o push é entregar a carta na portaria mostrando documento com foto. Guardamos os dois e a leitura nasce do cruzamento.

**Interpretação por contexto (não mover para regra única):** em repo INDIVIDUAL, divergência pontual já é sinal; em EQUIPE, divergência pontual é vida normal (par-programming) e o sinal é apenas o **padrão sistemático** (thresholds em `config.detectors`).

**Muletas complementares:** force push bloqueado por branch protection desde o template (reescrita de histórico = adulteração de evidência) e sinalizado se ocorrer; e-mails de commit declarados pelo aluno no onboarding (`emails_commit`) — autor não reconhecido também sinaliza.

## D3. Identidade de máquina: GitHub App, não PAT nem conta-robô

**Decisão:** todas as ações na org e o recebimento de webhooks acontecem via GitHub App `crivo-faminas`, autenticado por chave privada → installation tokens efêmeros.

**Contexto:** "token genérico da org" não existe — no modelo do GitHub, organização é lugar, não ator; todo token pertence a uma identidade.

**Justificativa:** (1) autenticação por criptografia assimétrica: a chave privada nunca trafega, só assinaturas; um PAT é o segredo em si. (2) Tokens de trabalho expiram em 1h e carregam só as permissões declaradas (Administration RW, Contents RW, Metadata) naquela org — vazamento tem raio de dano mínimo e prazo de validade. (3) Permissões vivem na identidade, não no uso: o App *não consegue* agir fora das caixas marcadas, ainda que o código peça. (4) O App é simultaneamente braço (API) e ouvido (webhook com secret próprio), uma peça para os dois lados. (5) Auditoria institucional: ações aparecem como `crivo-faminas[bot]`, não como o professor — distinção valiosa em contencioso. (6) Desacoplamento de pessoa física: o sistema não morre com a conta pessoal do criador.

**Rejeitados:** PAT pessoal (poder total da conta, atribuição pessoal, expiração surpresa, sem webhook embutido, ponto único de falha com nome próprio); conta-robô com PAT (fantoche com e-mail/senha/2FA para gerenciar — a gambiarra que o App veio aposentar).

**Parcimônia como regra viva:** o plano de implementação chegou a propor permissões extras (Pull Requests, Commit statuses, Org Members/Administration); foram cortadas por não servirem a nenhuma funcionalidade. Adicionar permissão depois é um clique; carregar permissão ociosa é risco permanente.

## D4. Granularidade: um repositório por aluno por trabalho

**Decisão:** cada trabalho gera um repo próprio por aluno/equipe, criado de template. Cada lab semanal é um "trabalho" no sistema; um template genérico serve à maioria, templates dedicados onde há esqueleto de código.

**Contexto:** o desenho original era repo por aluno por *disciplina* com trabalhos em pastas; mudou na revisão do plano de implementação e foi refinado depois (labs como trabalhos próprios).

**Justificativa:** (1) *generate from template* só funciona limpo em repo novo — no repo-por-disciplina, cada trabalho novo exigiria gambiarra de commit de pasta. (2) Congelamento trivial e sem ambiguidade: uma tag de entrega por repo (no modelo antigo: congelar o repo inteiro por causa do lab02 com o lab03 em andamento?). (3) Detectores com escopo natural ("sem atividade *neste trabalho*"). (4) Repo criado no dia do uso carrega o template *daquele dia* — melhorias de material chegam aos alunos sem atualização retroativa (que o mecanismo de template não tem: template é carimbo, não cordão umbilical; editar o template não afeta repos já nascidos — e isso é bom: repositório de aluno é evidência). (5) Microgestão por lab na grade (criado/sem push/entregue) em vez de arqueologia de pastas. (6) Ritual semanal criar→clonar→commitar→push é treino de Git disfarçado de logística.

**Custo aceito e mitigação:** mais repos por aluno (~15/semestre) — irrelevante tecnicamente; visão longitudinal do aluno nasce do **banco** (agregação de todos os repos), não da estrutura Git, então nada se perde. Manutenção de templates contida: 4–6 reais, não 15 (genérico reutilizado + dedicados apenas onde a interface padronizada importa — as provas de bancada assumem os nomes de métodos do esqueleto).

## D5. Congelamento de entrega como evidência formal

**Decisão:** no deadline (job repetível de 60s) ou manualmente, o sistema grava o SHA do HEAD e cria a tag `entrega-N` no repo + linha em `entregas`. N contado **por repositório** (a tag mora no repo). `force=true` no endpoint manual gera reentrega (`entrega-N+1`) para prazos estendidos. O endpoint manual **não** reescreve o deadline do trabalho (efeito colateral destrutivo removido). Idempotência: repo com `Entrega` é pulado na varredura automática — remover esse skip faria cada varredura cunhar tag nova.

**Justificativa:** mata o "professor, eu tinha feito, só subi depois" com prova técnica datada; commits pós-congelamento existem, mas fora da evidência de avaliação. É a feature de maior retorno por linha de código do sistema.

## D6. Dois processos: API e worker

**Decisão:** produção roda `api` (HTTP; webhooks apenas **enfileiram**) e `worker` (consome stats-commit, detector, repo-setup, congelador) como processos separados do mesmo código.

**Justificativa:** o GitHub espera resposta do webhook em ~10s; e o enriquecimento exige uma chamada de API **por commit** (o payload do push não traz additions/deletions), sujeita a latência, falha e rate limit — dois ritmos incompatíveis que pedem um amortecedor (a fila) e um consumidor independente. Retry com backoff transforma falha de rede às 2h da manhã de "dado perdido" em "tenta de novo"; a fila persiste trabalho pendente através de reinícios.

**Cicatriz registrada:** a primeira versão do código tinha os jobs escritos e **nenhum processo consumindo** ("corpo sem coração") — webhook gravava, fila enchia, nada acontecia. Sintoma diagnóstico: `stats_status` eternamente PENDENTE e zero sinalizações. Se tocar em execução de jobs, garantir que o entrypoint do worker existe e roda.

## D7. Fila: BullMQ + Redis, com porta de saída pg-boss

**Decisão:** BullMQ sobre Redis para jobs, retries/backoff e agendamento (congelador repetível).

**Justificativa:** resposta padrão do ecossistema Node — madura, recursos prontos, qualquer dev/IA conhece.

**Honestidade dimensionada:** para a escala real (turmas de dezenas, centenas de pushes/semana), o Redis é a única infra que existe *só* para a fila; BullMQ é dimensionado três ordens de grandeza acima da necessidade. **Porta de saída registrada:** `pg-boss` (fila dentro do Postgres já existente) cobre os mesmos conceitos (retry, backoff, cron) eliminando um serviço. Migrar não muda o desenho — muda só quem guarda a lista de pendências. Acionar se o Redis virar atrito operacional.

## D8. Segurança do webhook: HMAC sobre o corpo bruto

**Decisão:** validação HMAC-SHA256 do `X-Hub-Signature-256` com comparação timing-safe, **sobre o raw body** — nunca sobre payload re-serializado. Dedup por `X-GitHub-Delivery` + unique de SHA por repo (reentregas não duplicam).

**Justificativa:** o secret é a única prova de que o POST veio do GitHub; e `JSON.parse`→`stringify` altera bytes, gerando assinatura divergente — o bug clássico do gênero. Invariante protegido por teste: payload reserializado DEVE falhar a verificação. Framework: exige configuração de raw body na rota (Fastify parseia por padrão).

## D9. Papéis: promoção via env, nunca rebaixamento

**Decisão:** `PROFESSOR_LOGINS` (env) promove ALUNO→PROFESSOR no login OAuth; papel persiste no banco; remoção da lista **não** rebaixa (só manual no banco).

**Justificativa:** auto-registro de professor seria furo de segurança; e rebaixamento silencioso por edição de env removeria acesso de quem já revisou sinalizações — mudança de permissão tem que ser ato deliberado.

## D10. Migrations versionadas, nunca `db push`

**Decisão:** `prisma migrate dev` em dev, `migrate deploy` no start da API em produção; pasta `prisma/migrations/` commitada.

**Justificativa:** num sistema cujo produto é **evidência**, o schema precisa de histórico tanto quanto os dados — "que estrutura o banco tinha quando esta sinalização foi gerada" pode ser pergunta real de contestação futura. `db push` altera sem gravar história e faz o `migrate` divergir.

## D11. Falha de setup de repo é estado visível, não log

**Decisão:** pós-criação (poll da main, collaborator, branch protection) roda como job com 5 tentativas e backoff; esgotado, grava `setup_status=ERRO` + `setup_erro` no repositório, exposto na grade do professor.

**Justificativa:** o pior caso do "logar e seguir" é aluno sem acesso de push ou main sem proteção (furo de evidência) com a única testemunha numa linha de log que ninguém lê. Falha operacional relevante tem que aparecer onde o operador olha.

## D12. Detectores: dedup por pendência e thresholds centralizados

**Decisão:** `createSignal` não recria sinalização se já existe uma PENDENTE do mesmo tipo no repo (re-execução segura; re-flag só após revisão humana). Thresholds vivem em `config.detectors`, nunca hardcoded. `COMMIT_GIGANTE` só avalia commits `CALCULADO` — por isso o worker de stats **reenfileira** o detector ao concluir (sem isso, o commit gigante da véspera nunca seria visto: o detector do push rodaria antes das linhas existirem).

**Justificativa:** detectores idempotentes + fila de revisão sem spam; thresholds são hipóteses a calibrar com turma real (primeiro trabalho em modo observação — falsos positivos esperados: duplas que pareiam numa máquina só).

## D13. Domínio em português

**Decisão:** schema, rotas e variáveis usam o vocabulário do domínio em português (`trabalho`, `entrega`, `sinalizacao`...), sem mistura com termos ingleses equivalentes.

**Justificativa:** o domínio é regulatório-acadêmico brasileiro (quem lê contestação, ata ou tela é falante de português); consistência evita o dialeto híbrido que confunde busca e manutenção.
