import { z } from "zod";

/** Swift source inventory is lexical evidence, independent of compiler execution. */
export const swiftSourceInputSchema = z.strictObject({
  input_path: z.string().min(1),
});
const location = z.strictObject({
  offset_utf16: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column_utf16: z.number().int().positive(),
});
export const swiftSourceFileSchema = z.strictObject({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative(),
  imports: z.array(z.strictObject({ module: z.string(), location })),
  declarations: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.enum([
        "class",
        "struct",
        "enum",
        "protocol",
        "actor",
        "extension",
        "func",
        "init",
        "deinit",
        "subscript",
        "typealias",
        "let",
        "var",
      ]),
      name: z.string(),
      parent_id: z.string().nullable(),
      location,
      end_offset_utf16: z.number().int().nonnegative(),
      has_body: z.boolean(),
    }),
  ),
  call_candidates: z.array(
    z.strictObject({
      name: z.string(),
      enclosing_declaration_id: z.string().nullable(),
      location,
      resolution: z.literal("unresolved"),
    }),
  ),
  diagnostics: z.array(z.string()),
});
export const swiftSourceAnalysisSchema = z.strictObject({
  language: z.literal("swift"),
  analysis_kind: z.literal("lexical-source-map"),
  files: z.array(swiftSourceFileSchema),
  coverage: z.strictObject({
    status: z.enum(["complete-within-lexical-scope", "partial"]),
    source_files: z.number().int().nonnegative(),
    bytes_read: z.number().int().nonnegative(),
    entries_examined: z.number().int().nonnegative(),
    non_swift_entries: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string()),
});
export type SwiftSourceFile = z.output<typeof swiftSourceFileSchema>;
