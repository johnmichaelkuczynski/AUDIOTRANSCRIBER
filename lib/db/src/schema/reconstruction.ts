import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { transcriptionsTable } from "./transcriptions";

export const reconstructionJobsTable = pgTable(
  "reconstruction_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transcriptionId: integer("transcription_id")
      .notNull()
      .references(() => transcriptionsTable.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    fidelityMode: text("fidelity_mode").notNull().default("adaptive"),
    status: text("status").notNull().default("pending"),
    originalText: text("original_text").notNull(),
    manualSpecifications: text("manual_specifications").notNull().default(""),
    targetWordCount: integer("target_word_count").notNull(),
    sourceWordCount: integer("source_word_count").notNull(),
    sourceMetrics: jsonb("source_metrics").notNull().default({}),
    targetMetrics: jsonb("target_metrics").notNull().default({}),
    lengthRatio: numeric("length_ratio", { precision: 12, scale: 6 }).notNull(),
    skeleton: jsonb("skeleton"),
    progress: integer("progress").notNull().default(0),
    currentChunk: integer("current_chunk").notNull().default(0),
    totalChunks: integer("total_chunks").notNull().default(0),
    finalOutput: text("final_output"),
    finalWordCount: integer("final_word_count"),
    warnings: jsonb("warnings").notNull().default([]),
    error: text("error"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("reconstruction_jobs_transcription_idx").on(table.transcriptionId),
    index("reconstruction_jobs_status_idx").on(table.status),
    index("reconstruction_jobs_created_idx").on(table.createdAt),
  ],
);

export const reconstructionChunksTable = pgTable(
  "reconstruction_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => reconstructionJobsTable.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    inputText: text("input_text").notNull(),
    inputWordCount: integer("input_word_count").notNull(),
    outputText: text("output_text"),
    outputWordCount: integer("output_word_count"),
    targetWordCount: integer("target_word_count").notNull(),
    minimumWordCount: integer("minimum_word_count").notNull(),
    maximumWordCount: integer("maximum_word_count").notNull(),
    delta: jsonb("delta"),
    status: text("status").notNull().default("pending"),
    retries: integer("retries").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("reconstruction_chunks_job_chunk_unique").on(table.jobId, table.chunkIndex),
    index("reconstruction_chunks_job_idx").on(table.jobId),
    index("reconstruction_chunks_status_idx").on(table.status),
  ],
);

export const tractatusTiersTable = pgTable(
  "tractatus_tiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => reconstructionJobsTable.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    tier: integer("tier").notNull(),
    tree: jsonb("tree").notNull(),
    nodeCount: integer("node_count").notNull().default(0),
    parentTierId: uuid("parent_tier_id"),
    compressionCount: integer("compression_count").notNull().default(0),
    lastUpdate: timestamp("last_update", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tractatus_tiers_job_type_tier_unique").on(table.jobId, table.jobType, table.tier),
    index("tractatus_tiers_job_idx").on(table.jobId, table.jobType),
  ],
);

export const tractatusArchiveTable = pgTable(
  "tractatus_archive",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => reconstructionJobsTable.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    tier: integer("tier").notNull(),
    treeSnapshot: jsonb("tree_snapshot").notNull(),
    nodeCountAtSnapshot: integer("node_count_at_snapshot").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tractatus_archive_job_created_idx").on(table.jobId, table.jobType, table.createdAt),
    index("tractatus_archive_tier_idx").on(table.jobId, table.tier),
  ],
);

export const insertReconstructionJobSchema = createInsertSchema(reconstructionJobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertReconstructionChunkSchema = createInsertSchema(reconstructionChunksTable).omit({ id: true, createdAt: true, updatedAt: true });
export type ReconstructionJob = typeof reconstructionJobsTable.$inferSelect;
export type ReconstructionChunk = typeof reconstructionChunksTable.$inferSelect;
export type InsertReconstructionJob = z.infer<typeof insertReconstructionJobSchema>;
export type InsertReconstructionChunk = z.infer<typeof insertReconstructionChunkSchema>;