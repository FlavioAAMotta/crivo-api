ALTER TABLE "equipes" ADD COLUMN "lider_id" INTEGER;
UPDATE "equipes" e SET "lider_id" = (SELECT MIN(em."usuario_id") FROM "equipe_membros" em WHERE em."equipe_id" = e."id");
ALTER TABLE "equipes" ALTER COLUMN "lider_id" SET NOT NULL;
ALTER TABLE "equipes" ADD CONSTRAINT "equipes_lider_id_fkey" FOREIGN KEY ("lider_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "solicitacoes_equipe" (
  "id" SERIAL NOT NULL, "equipe_id" INTEGER NOT NULL, "usuario_id" INTEGER NOT NULL,
  "criada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "solicitacoes_equipe_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "solicitacoes_equipe_equipe_id_usuario_id_key" ON "solicitacoes_equipe"("equipe_id", "usuario_id");
ALTER TABLE "solicitacoes_equipe" ADD CONSTRAINT "solicitacoes_equipe_equipe_id_fkey" FOREIGN KEY ("equipe_id") REFERENCES "equipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "solicitacoes_equipe" ADD CONSTRAINT "solicitacoes_equipe_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
