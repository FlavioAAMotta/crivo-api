-- AlterTable: Make github_id and github_login nullable, add senha fields
ALTER TABLE "usuarios" ALTER COLUMN "github_id" DROP NOT NULL;

ALTER TABLE "usuarios" ALTER COLUMN "github_login" DROP NOT NULL;

ALTER TABLE "usuarios" ADD COLUMN "senha_hash" TEXT;

ALTER TABLE "usuarios" ADD COLUMN "senha_redefinida_em" TIMESTAMP(3);

-- CreateIndex: Add unique constraint on matricula (nullable values don't violate uniqueness in PostgreSQL)
CREATE UNIQUE INDEX "usuarios_matricula_key" ON "usuarios"("matricula");
