import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// Sync timestamps are millisecond precision: the wire format carries
// milliseconds, so a stored microsecond would make cursors skip or repeat rows.
const ts = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3 });

const syncTimes = {
  deletedAt: ts("deleted_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
};

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    clientFolderId: text("client_folder_id").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    workspaceId: text("workspace_id"),
    spaceId: text("space_id"),
    ...syncTimes,
  },
  (t) => [
    index("folders_updated_idx").on(t.ownerId, t.updatedAt, t.id),
    index("folders_created_idx").on(t.ownerId, t.createdAt, t.id),
    unique("folders_owner_client_folder_id_uq").on(t.ownerId, t.clientFolderId),
    uniqueIndex("folders_live_name_uq")
      .on(t.ownerId, t.name)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    clientNoteId: text("client_note_id").notNull(),
    title: text("title"),
    content: text("content").notNull().default(""),
    enhancedContent: text("enhanced_content"),
    enhancementPrompt: text("enhancement_prompt"),
    enhancedAtContentHash: text("enhanced_at_content_hash"),
    noteType: text("note_type").notNull().default("personal"),
    sourceFile: text("source_file"),
    audioDurationSeconds: doublePrecision("audio_duration_seconds"),
    transcript: text("transcript"),
    participants: text("participants"),
    calendarEventId: text("calendar_event_id"),
    diarizationEnabled: integer("diarization_enabled"),
    expectedSpeakerCount: integer("expected_speaker_count"),
    // No cascade: deleting a folder never touches its notes (protocol 8).
    folderId: uuid("folder_id").references(() => folders.id),
    workspaceId: text("workspace_id"),
    spaceId: text("space_id"),
    ...syncTimes,
  },
  (t) => [
    index("notes_updated_idx").on(t.ownerId, t.updatedAt, t.id),
    index("notes_created_idx").on(t.ownerId, t.createdAt, t.id),
    unique("notes_owner_client_note_id_uq").on(t.ownerId, t.clientNoteId),
  ],
);

export const dictionaryEntries = pgTable(
  "dictionary_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    clientDictId: text("client_dict_id").notNull(),
    word: text("word").notNull(),
    source: text("source").notNull().default("manual"),
    ...syncTimes,
  },
  (t) => [
    index("dictionary_entries_updated_idx").on(t.ownerId, t.updatedAt, t.id),
    index("dictionary_entries_created_idx").on(t.ownerId, t.createdAt, t.id),
    unique("dictionary_entries_owner_client_dict_id_uq").on(
      t.ownerId,
      t.clientDictId,
    ),
  ],
);

export const snippets = pgTable(
  "snippets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    clientSnippetId: text("client_snippet_id").notNull(),
    trigger: text("trigger").notNull(),
    replacement: text("replacement").notNull(),
    ...syncTimes,
  },
  (t) => [
    index("snippets_updated_idx").on(t.ownerId, t.updatedAt, t.id),
    index("snippets_created_idx").on(t.ownerId, t.createdAt, t.id),
    unique("snippets_owner_client_snippet_id_uq").on(
      t.ownerId,
      t.clientSnippetId,
    ),
    uniqueIndex("snippets_live_trigger_uq")
      .on(t.ownerId, t.trigger)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const transcriptions = pgTable(
  "transcriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    clientTranscriptionId: text("client_transcription_id").notNull(),
    text: text("text").notNull(),
    rawText: text("raw_text"),
    provider: text("provider"),
    model: text("model"),
    audioDurationMs: integer("audio_duration_ms"),
    status: text("status").notNull().default("completed"),
    ...syncTimes,
  },
  (t) => [
    index("transcriptions_updated_idx").on(t.ownerId, t.updatedAt, t.id),
    index("transcriptions_created_idx").on(t.ownerId, t.createdAt, t.id),
    unique("transcriptions_owner_client_transcription_id_uq").on(
      t.ownerId,
      t.clientTranscriptionId,
    ),
  ],
);
