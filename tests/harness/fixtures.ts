// fixture loader：不复制证据文件。manifest 登记来源路径与 SHA-256，loader 直接读
// aimaster接口文档/测试结果/ 并校验哈希；响应字节取自信封里 response_body 的原文片段。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type EvidenceLabel = "fixture_observed" | "smoke_verified" | "provider_failed";

export interface ManifestEntry {
  id: string;
  platform: "douyin" | "xiaohongshu";
  action: "media_user_info" | "user_video_list";
  mode: "sync" | "async";
  role: "response" | "submit" | "poll";
  source: string;
  sourceSha256: string;
  envelope: { responseKey: "response_body" | "body" };
  evidenceLabel: EvidenceLabel;
  use: "decoder_input" | "capability_evidence" | "failure_sample";
  observed: { httpStatus: number | null; taskStatus: string | null; action: string | null; errorCode: string | null };
}

export interface Manifest {
  schema: string;
  note: string;
  entries: ManifestEntry[];
}

const REPO_ROOT = new URL("../../", import.meta.url);

export class FixtureChecksumError extends Error {
  constructor(id: string) {
    super(`fixture ${id} 的来源文件 SHA-256 与 manifest 不一致`);
    this.name = "FixtureChecksumError";
  }
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(new URL("tests/fixtures/aimaster/manifest.json", REPO_ROOT), "utf8")) as Manifest;
}

export function readSource(entry: ManifestEntry): Buffer {
  return readFileSync(new URL(entry.source, REPO_ROOT));
}

export function verifyChecksum(entry: ManifestEntry, sourceBytes: Uint8Array): void {
  const actual = createHash("sha256").update(sourceBytes).digest("hex");
  if (actual !== entry.sourceSha256) throw new FixtureChecksumError(entry.id);
}

/** 返回 fixture 的响应字节：先校验来源哈希，再切出信封中响应 body 的原文片段。 */
export function loadFixtureBytes(id: string): Uint8Array {
  const entry = loadManifest().entries.find((e) => e.id === id);
  if (!entry) throw new Error(`manifest 中没有 fixture ${id}`);
  const source = readSource(entry);
  verifyChecksum(entry, source);
  return new TextEncoder().encode(sliceTopLevelValue(source.toString("utf8"), entry.envelope.responseKey));
}

const WS = new Set([" ", "\n", "\r", "\t"]);

function skipWs(t: string, i: number): number {
  while (i < t.length && WS.has(t[i]!)) i++;
  return i;
}

function endOfString(t: string, start: number): number {
  let i = start + 1;
  while (i < t.length) {
    const c = t[i];
    if (c === "\\") i += 2;
    else if (c === '"') return i + 1;
    else i++;
  }
  throw new Error("字符串未闭合");
}

function endOfValue(t: string, start: number): number {
  const c = t[start];
  if (c === '"') return endOfString(t, start);
  if (c === "{" || c === "[") {
    let depth = 0;
    let i = start;
    while (i < t.length) {
      const ch = t[i];
      if (ch === '"') {
        i = endOfString(t, i);
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error("对象或数组未闭合");
  }
  let i = start;
  while (i < t.length && !WS.has(t[i]!) && t[i] !== "," && t[i] !== "}" && t[i] !== "]") i++;
  return i;
}

/** 切出顶层对象中某个 key 的值的原文，只认顶层，不被嵌套同名 key 或字符串内容干扰。 */
export function sliceTopLevelValue(text: string, key: string): string {
  let i = skipWs(text, 0);
  if (text[i] !== "{") throw new Error("顶层不是对象");
  i++;
  for (;;) {
    i = skipWs(text, i);
    if (text[i] === "}") break;
    const keyEnd = endOfString(text, i);
    const k = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipWs(text, keyEnd);
    if (text[i] !== ":") throw new Error("缺少冒号");
    i = skipWs(text, i + 1);
    const end = endOfValue(text, i);
    if (k === key) return text.slice(i, end);
    i = skipWs(text, end);
    if (text[i] === ",") i++;
  }
  throw new Error(`没有顶层 key ${key}`);
}
