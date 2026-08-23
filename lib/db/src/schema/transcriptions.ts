import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const transcriptionsTable = pgTable("transcriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  filename: text("filename").notNull(),
  fileSize: integer("file_size").notNull(),
  text: text("text").notNull().default(""),
  status: text("status").notNull().default("processing"),
  errorMessage: text("error_message"),
  audioPath: text("audio_path"),
  processingMode: text("processing_mode").notNull().default("segmented"),
  verificationStatus: text("verification_status"),
  verificationRunA: text("verification_run_a"),
  verificationRunB: text("verification_run_b"),
  verificationWordCountA: integer("verification_word_count_a"),
  verificationWordCountB: integer("verification_word_count_b"),
  verificationVarianceBps: integer("verification_variance_bps"),
  knownTerms: text("known_terms"),
  batchId: text("batch_id"),
  batchPosition: integer("batch_position"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTranscriptionSchema = createInsertSchema(transcriptionsTable).omit({ id: true, createdAt: true });
export type InsertTranscription = z.infer<typeof insertTranscriptionSchema>;
export type Transcription = typeof transcriptionsTable.$inferSelect;
