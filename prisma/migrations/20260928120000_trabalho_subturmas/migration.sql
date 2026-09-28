CREATE TABLE "trabalho_turmas" (
    "trabalho_id" INTEGER NOT NULL,
    "turma_id" INTEGER NOT NULL,
    CONSTRAINT "trabalho_turmas_pkey" PRIMARY KEY ("trabalho_id","turma_id")
);

CREATE INDEX "trabalho_turmas_turma_id_idx" ON "trabalho_turmas"("turma_id");
ALTER TABLE "trabalho_turmas" ADD CONSTRAINT "trabalho_turmas_trabalho_id_fkey" FOREIGN KEY ("trabalho_id") REFERENCES "trabalhos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trabalho_turmas" ADD CONSTRAINT "trabalho_turmas_turma_id_fkey" FOREIGN KEY ("turma_id") REFERENCES "turmas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "trabalho_turmas" ("trabalho_id", "turma_id")
SELECT "id", "turma_id" FROM "trabalhos";
