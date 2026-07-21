-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Papel" AS ENUM ('ALUNO', 'PROFESSOR');

-- CreateEnum
CREATE TYPE "TipoTrabalho" AS ENUM ('INDIVIDUAL', 'EQUIPE');

-- CreateEnum
CREATE TYPE "DonoTipo" AS ENUM ('ALUNO', 'EQUIPE');

-- CreateEnum
CREATE TYPE "StatsStatus" AS ENUM ('PENDENTE', 'CALCULADO', 'ERRO');

-- CreateEnum
CREATE TYPE "RepoSetupStatus" AS ENUM ('PENDENTE', 'CONFIGURADO', 'ERRO');

-- CreateEnum
CREATE TYPE "SinalizacaoTipo" AS ENUM ('DIVERGENCIA_PUSHER_AUTOR', 'SEM_ATIVIDADE', 'FORCE_PUSH', 'COMMIT_GIGANTE', 'AUTOR_NAO_RECONHECIDO');

-- CreateEnum
CREATE TYPE "SinalizacaoIntensidade" AS ENUM ('BAIXA', 'MEDIA', 'ALTA');

-- CreateEnum
CREATE TYPE "SinalizacaoStatus" AS ENUM ('PENDENTE', 'PROCEDE', 'DESCARTADA');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" SERIAL NOT NULL,
    "github_id" BIGINT NOT NULL,
    "github_login" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "papel" "Papel" NOT NULL,
    "matricula" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emails_commit" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "verificado" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "emails_commit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplinas" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,

    CONSTRAINT "disciplinas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turmas" (
    "id" SERIAL NOT NULL,
    "disciplina_id" INTEGER NOT NULL,
    "nome" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,

    CONSTRAINT "turmas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matriculas" (
    "usuario_id" INTEGER NOT NULL,
    "turma_id" INTEGER NOT NULL,

    CONSTRAINT "matriculas_pkey" PRIMARY KEY ("usuario_id","turma_id")
);

-- CreateTable
CREATE TABLE "trabalhos" (
    "id" SERIAL NOT NULL,
    "turma_id" INTEGER NOT NULL,
    "titulo" TEXT NOT NULL,
    "descricao_md" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tipo" "TipoTrabalho" NOT NULL,
    "template_repo" TEXT NOT NULL,
    "janela_inicio" TIMESTAMP(3) NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "congelamento_automatico" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trabalhos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipes" (
    "id" SERIAL NOT NULL,
    "trabalho_id" INTEGER NOT NULL,
    "nome" TEXT NOT NULL,

    CONSTRAINT "equipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipe_membros" (
    "equipe_id" INTEGER NOT NULL,
    "usuario_id" INTEGER NOT NULL,

    CONSTRAINT "equipe_membros_pkey" PRIMARY KEY ("equipe_id","usuario_id")
);

-- CreateTable
CREATE TABLE "repositorios" (
    "id" SERIAL NOT NULL,
    "trabalho_id" INTEGER NOT NULL,
    "dono_tipo" "DonoTipo" NOT NULL,
    "usuario_id" INTEGER,
    "equipe_id" INTEGER,
    "github_repo_id" BIGINT NOT NULL,
    "nome_completo" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setup_status" "RepoSetupStatus" NOT NULL DEFAULT 'PENDENTE',
    "setup_erro" TEXT,
    "setup_tentativas" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "repositorios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pushes" (
    "id" SERIAL NOT NULL,
    "repositorio_id" INTEGER NOT NULL,
    "pusher_github_id" BIGINT NOT NULL,
    "pusher_login" TEXT NOT NULL,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "recebido_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ref" TEXT NOT NULL,
    "github_delivery_id" TEXT NOT NULL,

    CONSTRAINT "pushes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commits" (
    "id" SERIAL NOT NULL,
    "push_id" INTEGER NOT NULL,
    "repositorio_id" INTEGER NOT NULL,
    "sha" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "autor_nome" TEXT NOT NULL,
    "autor_email" TEXT NOT NULL,
    "autor_usuario_id" INTEGER,
    "committed_em" TIMESTAMP(3) NOT NULL,
    "additions" INTEGER,
    "deletions" INTEGER,
    "stats_status" "StatsStatus" NOT NULL DEFAULT 'PENDENTE',

    CONSTRAINT "commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entregas" (
    "id" SERIAL NOT NULL,
    "repositorio_id" INTEGER NOT NULL,
    "trabalho_id" INTEGER NOT NULL,
    "sha_congelado" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "congelado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entregas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sinalizacoes" (
    "id" SERIAL NOT NULL,
    "repositorio_id" INTEGER NOT NULL,
    "tipo" "SinalizacaoTipo" NOT NULL,
    "intensidade" "SinalizacaoIntensidade" NOT NULL,
    "evidencia_json" JSONB NOT NULL,
    "status" "SinalizacaoStatus" NOT NULL DEFAULT 'PENDENTE',
    "nota_revisao" TEXT,
    "revisado_por" INTEGER,
    "detectado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisado_em" TIMESTAMP(3),

    CONSTRAINT "sinalizacoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_github_id_key" ON "usuarios"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_github_login_key" ON "usuarios"("github_login");

-- CreateIndex
CREATE UNIQUE INDEX "emails_commit_email_key" ON "emails_commit"("email");

-- CreateIndex
CREATE UNIQUE INDEX "disciplinas_codigo_key" ON "disciplinas"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "trabalhos_slug_key" ON "trabalhos"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "repositorios_github_repo_id_key" ON "repositorios"("github_repo_id");

-- CreateIndex
CREATE UNIQUE INDEX "pushes_github_delivery_id_key" ON "pushes"("github_delivery_id");

-- CreateIndex
CREATE INDEX "pushes_repositorio_id_recebido_em_idx" ON "pushes"("repositorio_id", "recebido_em");

-- CreateIndex
CREATE INDEX "commits_repositorio_id_committed_em_idx" ON "commits"("repositorio_id", "committed_em");

-- CreateIndex
CREATE UNIQUE INDEX "commits_repositorio_id_sha_key" ON "commits"("repositorio_id", "sha");

-- CreateIndex
CREATE INDEX "sinalizacoes_status_idx" ON "sinalizacoes"("status");

-- AddForeignKey
ALTER TABLE "emails_commit" ADD CONSTRAINT "emails_commit_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turmas" ADD CONSTRAINT "turmas_disciplina_id_fkey" FOREIGN KEY ("disciplina_id") REFERENCES "disciplinas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matriculas" ADD CONSTRAINT "matriculas_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matriculas" ADD CONSTRAINT "matriculas_turma_id_fkey" FOREIGN KEY ("turma_id") REFERENCES "turmas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trabalhos" ADD CONSTRAINT "trabalhos_turma_id_fkey" FOREIGN KEY ("turma_id") REFERENCES "turmas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipes" ADD CONSTRAINT "equipes_trabalho_id_fkey" FOREIGN KEY ("trabalho_id") REFERENCES "trabalhos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipe_membros" ADD CONSTRAINT "equipe_membros_equipe_id_fkey" FOREIGN KEY ("equipe_id") REFERENCES "equipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipe_membros" ADD CONSTRAINT "equipe_membros_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositorios" ADD CONSTRAINT "repositorios_trabalho_id_fkey" FOREIGN KEY ("trabalho_id") REFERENCES "trabalhos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositorios" ADD CONSTRAINT "repositorios_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositorios" ADD CONSTRAINT "repositorios_equipe_id_fkey" FOREIGN KEY ("equipe_id") REFERENCES "equipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pushes" ADD CONSTRAINT "pushes_repositorio_id_fkey" FOREIGN KEY ("repositorio_id") REFERENCES "repositorios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_push_id_fkey" FOREIGN KEY ("push_id") REFERENCES "pushes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_repositorio_id_fkey" FOREIGN KEY ("repositorio_id") REFERENCES "repositorios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_autor_usuario_id_fkey" FOREIGN KEY ("autor_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas" ADD CONSTRAINT "entregas_repositorio_id_fkey" FOREIGN KEY ("repositorio_id") REFERENCES "repositorios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas" ADD CONSTRAINT "entregas_trabalho_id_fkey" FOREIGN KEY ("trabalho_id") REFERENCES "trabalhos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sinalizacoes" ADD CONSTRAINT "sinalizacoes_repositorio_id_fkey" FOREIGN KEY ("repositorio_id") REFERENCES "repositorios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sinalizacoes" ADD CONSTRAINT "sinalizacoes_revisado_por_fkey" FOREIGN KEY ("revisado_por") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

