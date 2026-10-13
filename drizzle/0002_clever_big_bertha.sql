ALTER TABLE "dictionary_entries" DROP CONSTRAINT "dictionary_entries_client_dict_id_unique";--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT "folders_client_folder_id_unique";--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_client_note_id_unique";--> statement-breakpoint
ALTER TABLE "snippets" DROP CONSTRAINT "snippets_client_snippet_id_unique";--> statement-breakpoint
ALTER TABLE "transcriptions" DROP CONSTRAINT "transcriptions_client_transcription_id_unique";--> statement-breakpoint
DROP INDEX "dictionary_entries_updated_idx";--> statement-breakpoint
DROP INDEX "dictionary_entries_created_idx";--> statement-breakpoint
DROP INDEX "folders_updated_idx";--> statement-breakpoint
DROP INDEX "folders_created_idx";--> statement-breakpoint
DROP INDEX "folders_live_name_uq";--> statement-breakpoint
DROP INDEX "notes_updated_idx";--> statement-breakpoint
DROP INDEX "notes_created_idx";--> statement-breakpoint
DROP INDEX "snippets_updated_idx";--> statement-breakpoint
DROP INDEX "snippets_created_idx";--> statement-breakpoint
DROP INDEX "snippets_live_trigger_uq";--> statement-breakpoint
DROP INDEX "transcriptions_updated_idx";--> statement-breakpoint
DROP INDEX "transcriptions_created_idx";--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "owner_id" text NOT NULL DEFAULT 'rico';--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "dictionary_entries" ADD COLUMN "owner_id" text NOT NULL DEFAULT 'rico';--> statement-breakpoint
ALTER TABLE "dictionary_entries" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "owner_id" text NOT NULL DEFAULT 'rico';--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "owner_id" text NOT NULL DEFAULT 'rico';--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "snippets" ADD COLUMN "owner_id" text NOT NULL DEFAULT 'rico';--> statement-breakpoint
ALTER TABLE "snippets" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "owner_id" text NOT NULL DEFAULT 'rico';--> statement-breakpoint
ALTER TABLE "transcriptions" ALTER COLUMN "owner_id" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "dictionary_entries_updated_idx" ON "dictionary_entries" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "dictionary_entries_created_idx" ON "dictionary_entries" USING btree ("owner_id","created_at","id");--> statement-breakpoint
CREATE INDEX "folders_updated_idx" ON "folders" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "folders_created_idx" ON "folders" USING btree ("owner_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_live_name_uq" ON "folders" USING btree ("owner_id","name") WHERE "folders"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "notes_updated_idx" ON "notes" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "notes_created_idx" ON "notes" USING btree ("owner_id","created_at","id");--> statement-breakpoint
CREATE INDEX "snippets_updated_idx" ON "snippets" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "snippets_created_idx" ON "snippets" USING btree ("owner_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_live_trigger_uq" ON "snippets" USING btree ("owner_id","trigger") WHERE "snippets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "transcriptions_updated_idx" ON "transcriptions" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "transcriptions_created_idx" ON "transcriptions" USING btree ("owner_id","created_at","id");--> statement-breakpoint
ALTER TABLE "dictionary_entries" ADD CONSTRAINT "dictionary_entries_owner_client_dict_id_uq" UNIQUE("owner_id","client_dict_id");--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_client_folder_id_uq" UNIQUE("owner_id","client_folder_id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_client_note_id_uq" UNIQUE("owner_id","client_note_id");--> statement-breakpoint
ALTER TABLE "snippets" ADD CONSTRAINT "snippets_owner_client_snippet_id_uq" UNIQUE("owner_id","client_snippet_id");--> statement-breakpoint
ALTER TABLE "transcriptions" ADD CONSTRAINT "transcriptions_owner_client_transcription_id_uq" UNIQUE("owner_id","client_transcription_id");