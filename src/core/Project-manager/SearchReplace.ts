/**
 * @file     SearchReplace.ts
 * @module   core/project-manager
 * @version  1.0.1
 *
 * Proje genelinde metin arama ve degistirme motoru.
 * Tasarim: senkron regex + async dosya okuma, MAX_RESULTS_PER_FILE=500,
 * basit glob filtre (Phase 3'te minimatch ile degistirilebilir).
 */

import type { AsyncResult, IFile, UUID } from "../../types/core";
import { ErrorCode } from "../../types/core";
import { err, ok } from "../../utils/result";
import type { FileService } from "../services/FileService";

export interface SearchOptions {
  readonly caseSensitive?: boolean;
  readonly wholeWord?:     boolean;
  readonly useRegex?:      boolean;
  readonly includeGlob?:   string;
  readonly excludeGlob?:   string;
}

export interface SearchMatch {
  readonly line: number; readonly column: number;
  readonly length: number; readonly lineText: string; readonly matchText: string;
}

export interface FileSearchResult {
  readonly fileId: UUID; readonly filePath: string; readonly fileName: string;
  readonly matches: readonly SearchMatch[];
}

export interface SearchResult {
  readonly query: string; readonly totalMatches: number;
  readonly fileResults: readonly FileSearchResult[]; readonly truncated: boolean;
}

export interface ReplaceResult {
  readonly fileId: UUID; readonly filePath: string;
  readonly replacements: number; readonly newContent: string;
}

const MAX_RESULTS_PER_FILE = 500;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(q: string, o: SearchOptions): { regex: RegExp } | { error: string } {
  let p = o.useRegex ? q : escapeRegex(q);
  if (o.wholeWord) p = `\\b${p}\\b`;
  try { return { regex: new RegExp(p, o.caseSensitive ? "g" : "gi") }; }
  catch (e) { return { error: `Invalid regex: ${(e as Error).message}` }; }
}

function globMatch(pattern: string, path: string): boolean {
  if (!pattern) return true;
  const r = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
                   // FIX #2: (.+) → (.*) — ** bos path segment de eslestirebilmeli
                   // ornegin "src/**" → "src/" yolunu da kapsamali.
                   .replace(/\*\*/g, "(.*)").replace(/\*/g, "([^/]*)");
  try { return new RegExp(`^${r}$`).test(path); } catch { return false; }
}

function shouldInclude(file: IFile, o: SearchOptions): boolean {
  if (o.excludeGlob && globMatch(o.excludeGlob, file.path)) return false;
  if (o.includeGlob && !globMatch(o.includeGlob, file.path)) return false;
  return true;
}

function searchInContent(content: string, regex: RegExp, fileId: UUID, filePath: string, fileName: string): FileSearchResult {
  const lines = content.split("\n");
  const matches: SearchMatch[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(lineText)) !== null) {
      if (matches.length >= MAX_RESULTS_PER_FILE) { truncated = true; break; }
      matches.push({ line: i + 1, column: m.index + 1, length: m[0].length, lineText, matchText: m[0] });
      if (m[0].length === 0) regex.lastIndex++;
    }
    if (truncated) break;
  }
  return Object.freeze({ fileId, filePath, fileName, matches: Object.freeze(matches) });
}

export class SearchReplace {
  constructor(private readonly fileService: FileService) {}

  async search(projectId: UUID, query: string, options: SearchOptions = {}): AsyncResult<SearchResult> {
    if (!query.trim()) return ok({ query, totalMatches: 0, fileResults: [], truncated: false });
    const built = buildRegex(query, options);
    if ("error" in built) return err(ErrorCode.VALIDATION_ERROR, built.error, { context: {query} });
    const fr = await this.fileService.getProjectFiles(projectId);
    if (!fr.ok) return fr;
    const fileResults: FileSearchResult[] = [];
    let totalMatches = 0, truncated = false;
    for (const file of fr.data) {
      if (!shouldInclude(file, options)) continue;
      const regex  = new RegExp(built.regex.source, built.regex.flags);
      const result = searchInContent(file.content, regex, file.id, file.path, file.name);
      if (result.matches.length > 0) {
        fileResults.push(result);
        totalMatches += result.matches.length;
        if (result.matches.length >= MAX_RESULTS_PER_FILE) truncated = true;
      }
    }
    return ok(Object.freeze({ query, totalMatches, fileResults: Object.freeze(fileResults), truncated }));
  }

  async replace(fileId: UUID, query: string, replacement: string, options: SearchOptions = {}): AsyncResult<ReplaceResult> {
    // FIX #1a: search'teki gibi bos query guard eklendi.
    // Bos regex her karakter sinirinda eslesir, tum icerik bozulabilir.
    if (!query.trim()) return ok({ fileId, filePath: "", replacements: 0, newContent: "" });
    const built = buildRegex(query, options);
    if ("error" in built) return err(ErrorCode.VALIDATION_ERROR, built.error, { context: {query} });
    const fr = await this.fileService.getFile(fileId);
    if (!fr.ok) return fr;
    // Her cagri icin yeni RegExp — built.regex'in lastIndex durumuna bagimlilik kalmadi.
    const regex      = new RegExp(built.regex.source, built.regex.flags);
    const newContent = fr.data.content.replace(regex, replacement);
    if (newContent === fr.data.content) return ok({ fileId, filePath: fr.data.path, replacements: 0, newContent });
    const sr = await this.fileService.saveFile(fileId, newContent);
    if (!sr.ok) return sr;
    const n = (fr.data.content.match(new RegExp(built.regex.source, built.regex.flags)) ?? []).length;
    return ok(Object.freeze({ fileId, filePath: fr.data.path, replacements: n, newContent }));
  }

  async replaceAll(projectId: UUID, query: string, replacement: string, options: SearchOptions = {}): AsyncResult<ReplaceResult[]> {
    // FIX #1b: replace ile tutarli bos query guard.
    if (!query.trim()) return ok([]);
    const built = buildRegex(query, options);
    if ("error" in built) return err(ErrorCode.VALIDATION_ERROR, built.error, { context: {query} });
    const fr = await this.fileService.getProjectFiles(projectId);
    if (!fr.ok) return fr;

    // FIX #3: Kismi basarisizlik korumasi — once tum degisiklikler hesaplanir,
    // hicbir dosya kaydedilmeden once. Boylece saveFile hatasinda hicbir dosya
    // degistirilmemis olur (atomik "ya hepsi ya hicbiri" semantigi).
    const pending: Array<{ file: IFile; newContent: string; n: number }> = [];
    for (const file of fr.data) {
      if (!shouldInclude(file, options)) continue;
      const regex      = new RegExp(built.regex.source, built.regex.flags);
      const newContent = file.content.replace(regex, replacement);
      if (newContent === file.content) continue;
      const n = (file.content.match(new RegExp(built.regex.source, built.regex.flags)) ?? []).length;
      pending.push({ file, newContent, n });
    }

    const results: ReplaceResult[] = [];
    for (const { file, newContent, n } of pending) {
      const sr = await this.fileService.saveFile(file.id, newContent);
      if (!sr.ok) return sr;
      results.push(Object.freeze({ fileId: file.id, filePath: file.path, replacements: n, newContent }));
    }
    return ok(results);
  }
}
