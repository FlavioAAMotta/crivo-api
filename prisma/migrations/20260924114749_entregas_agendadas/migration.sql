-- AlterTable
ALTER TABLE "entregas" ADD COLUMN     "entrega_agendada_id" INTEGER;

-- CreateTable
CREATE TABLE "entregas_agendadas" (
    "id" SERIAL NOT NULL,
    "trabalho_id" INTEGER NOT NULL,
    "nome" TEXT NOT NULL,
    "data_hora" TIMESTAMP(3) NOT NULL,
    "congelamento_automatico" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entregas_agendadas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entregas_agendadas_trabalho_id_data_hora_idx" ON "entregas_agendadas"("trabalho_id", "data_hora");

-- CreateIndex
CREATE UNIQUE INDEX "entregas_agendadas_trabalho_id_nome_key" ON "entregas_agendadas"("trabalho_id", "nome");

-- AddForeignKey
ALTER TABLE "entregas_agendadas" ADD CONSTRAINT "entregas_agendadas_trabalho_id_fkey" FOREIGN KEY ("trabalho_id") REFERENCES "trabalhos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas" ADD CONSTRAINT "entregas_entrega_agendada_id_fkey" FOREIGN KEY ("entrega_agendada_id") REFERENCES "entregas_agendadas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
