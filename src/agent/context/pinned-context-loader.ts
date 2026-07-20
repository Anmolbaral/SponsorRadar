import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export type ContextPurpose =
  | "peer_rationale"
  | "grounded_report_wording";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SectionSchema = z
  .object({
    id: z.string().min(1).max(80),
    selector: z.discriminatedUnion("type", [
      z.object({ type: z.literal("document") }).strict(),
      z
        .object({
          type: z.literal("markdown_heading_path"),
          path: z.array(z.string().min(1).max(100)).min(1).max(6)
        })
        .strict()
    ]),
    section_sha256: HashSchema,
    content_bytes: z.number().int().positive().max(16_000)
  })
  .strict();
const FileSchema = z
  .object({
    id: z.string().min(1).max(80),
    path: z.string().min(1).max(160),
    authority: z.enum(["system_policy", "untrusted_reference"]),
    source: z.string().min(1).max(300),
    upstream_version: z.string().max(80).nullable(),
    fetched_at: z.iso.date(),
    file_sha256: HashSchema,
    file_bytes: z.number().int().positive().max(64_000),
    runtime_loadable: z.boolean(),
    sections: z.array(SectionSchema).max(12)
  })
  .strict();
const PurposeBundleSchema = z
  .object({
    section_ids: z.array(z.string().min(1).max(80)).min(1).max(4),
    max_sections: z.number().int().min(1).max(4),
    max_context_bytes: z.number().int().positive().max(16_000)
  })
  .strict();
const ManifestSchema = z
  .object({
    schema_version: z.literal(2),
    manifest_id: z.literal("sponsor-radar-phase4-context-v1"),
    hash_algorithm: z.literal("sha256"),
    review: z
      .object({
        status: z.literal("approved"),
        reviewed_at: z.iso.date(),
        reviewer: z.string().min(1).max(100)
      })
      .strict(),
    files: z.array(FileSchema).min(3).max(12),
    purposes: z
      .object({
        peer_rationale: PurposeBundleSchema,
        grounded_report_wording: PurposeBundleSchema
      })
      .strict(),
    runtime_policy: z
      .object({
    executable: z.literal(false),
        load_mode: z.literal("purpose_bound"),
    allowed_consumer: z.literal("src/agent/context"),
    network_permission_granted_by_context: z.literal(false)
  })
      .strict()
  })
  .strict();

type ContextManifest = z.infer<typeof ManifestSchema>;

export interface LoadedContextSection {
  id: string;
  file: string;
  authority: "system_policy" | "untrusted_reference";
  source: string;
  upstreamVersion: string | null;
  fileSha256: string;
  sectionSha256: string;
  section: string;
  content: string;
}

export interface LoadedContextBundle {
  manifestId: string;
  manifestSha256: string;
  purpose: ContextPurpose;
  sections: LoadedContextSection[];
  totalContextBytes: number;
}

export async function verifyPinnedUpriverContext(
  repositoryRoot: string
): Promise<void> {
  const { contextRoot, manifest } = await readManifest(repositoryRoot);
  await readAndVerifyFiles(contextRoot, manifest);
}

export async function loadPinnedUpriverSections(
  repositoryRoot: string,
  requests: Array<{
    file: "SKILL.md" | "llms.txt";
    section: string;
  }>
): Promise<LoadedContextSection[]> {
  if (requests.length === 0) {
    throw new Error("Context loading must name at least one relevant section");
  }
  if (requests.length > 2) {
    throw new Error("Context loading is limited to two reviewed sections");
  }
  const ids = requests.map((request) => {
    if (request.file === "SKILL.md" && request.section === "Creators") {
      return "upriver.creators";
    }
    if (request.file === "SKILL.md" && request.section === "Sponsorships") {
      return "upriver.sponsorships";
    }
    throw new Error(
      `Context section "${request.section}" was not found in the reviewed allowlist`
    );
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Duplicate context sections are not allowed");
  }
  const purpose: ContextPurpose = ids.includes("upriver.creators")
    ? "peer_rationale"
    : "grounded_report_wording";
  const bundle = await loadPinnedContextBundle(repositoryRoot, purpose);
  return ids.map((id) => {
    const section = bundle.sections.find((candidate) => candidate.id === id);
    if (!section) {
      throw new Error(`Context section "${id}" was not found`);
    }
    return section;
  });
}

export function extractMarkdownSection(
  markdown: string,
  requestedHeading: string
): string {
  const lines = markdown.split(/\r?\n/);
  const normalizedRequest = requestedHeading.trim().toLowerCase();
  const start = lines.findIndex((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    return match?.[2].toLowerCase() === normalizedRequest;
  });
  if (start === -1) {
    throw new Error(`Context section "${requestedHeading}" was not found`);
  }

  const headingLevel = /^(#{1,6})/.exec(lines[start])?.[1].length ?? 1;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index]);
    if (match && match[1].length <= headingLevel) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}

export async function loadPinnedContextBundle(
  repositoryRoot: string,
  purpose: ContextPurpose
): Promise<LoadedContextBundle> {
  const { contextRoot, manifest, manifestBytes } =
    await readManifest(repositoryRoot);
  const files = await readAndVerifyFiles(contextRoot, manifest);
  const bundle = manifest.purposes[purpose];
  if (bundle.section_ids.length > bundle.max_sections) {
    throw new Error(`Context purpose ${purpose} exceeds its section limit`);
  }
  if (new Set(bundle.section_ids).size !== bundle.section_ids.length) {
    throw new Error(`Context purpose ${purpose} contains duplicate sections`);
  }

  const sections = bundle.section_ids.map((sectionId) => {
    const matches = manifest.files.flatMap((file) =>
      file.sections
        .filter((section) => section.id === sectionId)
        .map((section) => ({ file, section }))
    );
    if (matches.length !== 1) {
      throw new Error(
        `Reviewed section ${sectionId} must resolve exactly once`
      );
    }
    const { file, section } = matches[0];
    if (!file.runtime_loadable) {
      throw new Error(`Reviewed section ${sectionId} is not runtime-loadable`);
    }
    const content = extractReviewedSection(
      files.get(file.id) ?? fail(`Verified file ${file.id} was not loaded`),
      section.selector
    );
    const contentBytes = Buffer.byteLength(content, "utf8");
    const actualHash = sha256(Buffer.from(content, "utf8"));
    if (
      contentBytes !== section.content_bytes ||
      actualHash !== section.section_sha256
    ) {
      throw new Error(
        `${section.id} differs from its reviewed section hash`
      );
    }
    return {
      id: section.id,
      file: file.path,
      authority: file.authority,
      source: file.source,
      upstreamVersion: file.upstream_version,
      fileSha256: file.file_sha256,
      sectionSha256: section.section_sha256,
      section: selectorLabel(section.selector),
      content
    };
  });
  const totalContextBytes = sections.reduce(
    (total, section) => total + Buffer.byteLength(section.content, "utf8"),
    0
  );
  if (totalContextBytes > bundle.max_context_bytes) {
    throw new Error(`Context purpose ${purpose} exceeds its byte limit`);
  }
  return {
    manifestId: manifest.manifest_id,
    manifestSha256: sha256(manifestBytes),
    purpose,
    sections,
    totalContextBytes
  };
}

async function readManifest(repositoryRoot: string): Promise<{
  contextRoot: string;
  manifest: ContextManifest;
  manifestBytes: Buffer;
}> {
  const contextRoot = path.resolve(repositoryRoot, "agent-context");
  const manifestBytes = await readFile(
    path.join(contextRoot, "manifest.json")
  );
  const text = decodeUtf8(manifestBytes, "context manifest");
  const manifest = ManifestSchema.parse(JSON.parse(text) as unknown);
  validateManifestSemantics(manifest);
  return { contextRoot, manifest, manifestBytes };
}

function validateManifestSemantics(manifest: ContextManifest): void {
  assertUnique(manifest.files.map((file) => file.id), "file IDs");
  assertUnique(manifest.files.map((file) => file.path), "file paths");
  assertUnique(
    manifest.files.flatMap((file) =>
      file.sections.map((section) => section.id)
    ),
    "section IDs"
  );
  for (const file of manifest.files) {
    assertSafeRelativePath(file.path);
    if (
      file.authority === "untrusted_reference" &&
      !file.source.startsWith("https://docs.upriver.ai/")
    ) {
      throw new Error(`${file.id} must use the reviewed Upriver HTTPS origin`);
    }
    if (
      file.authority === "system_policy" &&
      file.source !== "local:agent-context/APP_POLICY.md"
    ) {
      throw new Error("System policy must come from the reviewed local file");
    }
    if (!file.runtime_loadable && file.sections.length > 0) {
      throw new Error(`${file.id} is not loadable but declares sections`);
    }
  }
}

async function readAndVerifyFiles(
  contextRoot: string,
  manifest: ContextManifest
): Promise<Map<string, string>> {
  const rootRealPath = await realpath(contextRoot);
  const loaded = new Map<string, string>();
  for (const file of manifest.files) {
    const absolute = path.join(contextRoot, file.path);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${file.path} must be a regular non-symlink file`);
    }
    const resolved = await realpath(absolute);
    if (!isWithinRoot(rootRealPath, resolved)) {
      throw new Error(`${file.path} escapes the reviewed context root`);
    }
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    let bytes: Buffer;
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile() || openedMetadata.size !== file.file_bytes) {
        throw new Error(`${file.path} differs from its reviewed byte size`);
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (
      bytes.length !== file.file_bytes ||
      sha256(bytes) !== file.file_sha256
    ) {
      throw new Error(
        `${file.path} differs from its reviewed manifest hash; review changes before loading it`
      );
    }
    loaded.set(file.id, decodeUtf8(bytes, file.path));
  }
  return loaded;
}

function extractReviewedSection(
  markdown: string,
  selector: z.infer<typeof SectionSchema>["selector"]
): string {
  if (selector.type === "document") {
    return markdown.trim();
  }
  const lines = markdown.split(/\r?\n/);
  const stack: Array<{ level: number; title: string }> = [];
  const matches: Array<{ start: number; level: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    const level = match[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    stack.push({ level, title: match[2] });
    if (
      stack.map((entry) => entry.title).join("\0") ===
      selector.path.join("\0")
    ) {
      matches.push({ start: index, level });
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Context heading path "${selector.path.join(" / ")}" must occur exactly once`
    );
  }
  const [{ start, level }] = matches;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index]);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function selectorLabel(
  selector: z.infer<typeof SectionSchema>["selector"]
): string {
  return selector.type === "document"
    ? "document"
    : selector.path.join(" / ");
}

function assertSafeRelativePath(value: string): void {
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`Unsafe context path ${value}`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Context manifest contains duplicate ${label}`);
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message: string): never {
  throw new Error(message);
}
