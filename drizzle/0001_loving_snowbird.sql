CREATE TABLE "dictionary_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_dict_id" text NOT NULL,
	"word" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "dictionary_entries_client_dict_id_unique" UNIQUE("client_dict_id")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_folder_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"workspace_id" text,
	"space_id" text,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "folders_client_folder_id_unique" UNIQUE("client_folder_id")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_note_id" text NOT NULL,
	"title" text,
	"content" text DEFAULT '' NOT NULL,
	"enhanced_content" text,
	"enhancement_prompt" text,
	"enhanced_at_content_hash" text,
	"note_type" text DEFAULT 'personal' NOT NULL,
	"source_file" text,
	"audio_duration_seconds" double precision,
	"transcript" text,
	"participants" text,
	"calendar_event_id" text,
	"diarization_enabled" integer,
	"expected_speaker_count" integer,
	"folder_id" uuid,
	"workspace_id" text,
	"space_id" text,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "notes_client_note_id_unique" UNIQUE("client_note_id")
);
--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_snippet_id" text NOT NULL,
	"trigger" text NOT NULL,
	"replacement" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "snippets_client_snippet_id_unique" UNIQUE("client_snippet_id")
);
--> statement-breakpoint
CREATE TABLE "transcriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_transcription_id" text NOT NULL,
	"text" text NOT NULL,
	"raw_text" text,
	"provider" text,
	"model" text,
	"audio_duration_ms" integer,
	"status" text DEFAULT 'completed' NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "transcriptions_client_transcription_id_unique" UNIQUE("client_transcription_id")
);
--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dictionary_entries_updated_idx" ON "dictionary_entries" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "dictionary_entries_created_idx" ON "dictionary_entries" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "folders_updated_idx" ON "folders" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "folders_created_idx" ON "folders" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_live_name_uq" ON "folders" USING btree ("name") WHERE "folders"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "notes_updated_idx" ON "notes" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "notes_created_idx" ON "notes" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "snippets_updated_idx" ON "snippets" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "snippets_created_idx" ON "snippets" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_live_trigger_uq" ON "snippets" USING btree ("trigger") WHERE "snippets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "transcriptions_updated_idx" ON "transcriptions" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "transcriptions_created_idx" ON "transcriptions" USING btree ("created_at","id");