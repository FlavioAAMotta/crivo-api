ALTER TABLE "trabalhos" ADD COLUMN "max_integrantes_equipe" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "equipes" ADD COLUMN "formada_em" TIMESTAMP(3);

UPDATE "equipes" e
SET "formada_em" = NOW()
WHERE EXISTS (SELECT 1 FROM "repositorios" r WHERE r."equipe_id" = e."id");
