/**
 * @file     FileRepository.ts
 * @module   storage/repositories
 * @version  1.1.0
 * @since    Phase 1 — Foundation
 *
 * ── v1.1.0 değişiklikleri ────────────────────────────────────────────────────
 *  [1] Atomic duplicate guard  (TOCTOU race condition fix)
 *
 *      Eski yaklaşım (TOCTOU):
 *        findByPath() → boş mu? → INSERT     ← Thread B araya girebilir
 *
 *      Yeni yaklaşım (atomik):
 *        Doğrudan INSERT → SQLITE_CONSTRAINT yakalanır → DUPLICATE_RECORD döner
 *        DB'deki UNIQUE INDEX (project_id, path) tek atomik garanti noktasıdır.
 *        findByPath() ön kontrolü tamamen kaldırıldı.
 *
 *      Neden DB unique index yeterli?
 *        SQLite serialized write modu; iki eş zamanlı INSERT aynı anda
 *        unique index'e çarparsa biri SQLITE_CONSTRAINT_UNIQUE alır.
 *        Bu hata yakalanıp DUPLICATE_RECORD'a çevrilir; uygulama tutarlı kalır.
 *
 *  [2] IFileWithVersion kaldırıldı
 *      core.ts v0.4.0'da IFile.version eklendi; local wrapper gereksiz.
 *      Tüm public metotlar artık AsyncResult<IFile> döner.
 *
 *  [3] isSQLiteConstraintError() helper
 *      expo-sqlite'ın fırlattığı constraint hatasını tanımlar;
 *      diğer DB hatalarından ayırt eder.
 */

import type {
  AsyncResult,
  CreateFileDto,
  IFile,
  IFileRepository,
  UpdateFileDto,
  UUID,
} from "../../types/core";

import {
  ErrorCode,
  FILE_CONSTRAINTS,
  FILE_EXTENSION_MAP,
  FileType,
} from "../../types/core";

import type { IDatabaseDriver } from "../Database";
import { err, ok, tryResultAsync } from "../../utils/result";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Module-Level Sabitler
// ─────────────────────────────────────────────────────────────────────────────

const VALID_FILE_TYPES = new Set<string>(Object.values(FileType));

// ─────────────────────────────────────────────────────────────────────────────
// § 2. SQLite Constraint Hata Tanımlayıcı  ← [3]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * expo-sqlite'ın fırlattığı UNIQUE kısıt hatasını tanır.
 *
 * expo-sqlite v14 hata mesajı formatı:
 *   "UNIQUE constraint failed: files.project_id, files.path"
 *
 * Farklı sürümlerde mesaj değişebileceği için hem message hem de
 * numeric error code kontrol edilir.
 */
function isSQLiteConstraintError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;

  const msg = cause.message.toUpperCase();

  // expo-sqlite v14 string mesaj
  if (msg.includes("UNIQUE CONSTRAINT FAILED")) return true;
  if (msg.includes("CONSTRAINT FAILED"))        return true;

  // SQLite numeric error code: 19 = SQLITE_CONSTRAINT
  const code = (cause as { errorCode?: number }).errorCode;
  if (code === 19) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Checksum & Boyut
// ─────────────────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit — değişiklik tespiti için, kriptografik değil */
function computeChecksum(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash  = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Gerçek UTF-8 byte boyutu — surrogate pair dahil */
function computeByteSize(content: string): number {
  let size = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if      (code < 0x0080) size += 1;
    else if (code < 0x0800) size += 2;
    else if (code < 0xd800 || code >= 0xe000) size += 3;
    else { i++; size += 4; }
  }
  return size;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. FileType Çözücü
// ─────────────────────────────────────────────────────────────────────────────

function resolveFileType(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (FILE_EXTENSION_MAP[ext] ?? FileType.Unknown) as FileType;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Veritabanı Satır Tipi
// ─────────────────────────────────────────────────────────────────────────────

interface FileRow {
  id:        string;
  projectId: string;
  path:      string;
  name:      string;
  type:      string;
  content:   string;
  checksum:  string;
  size:      number;
  version:   number;
  createdAt: number;
  updatedAt: number;
  isDirty:   number;   // SQLite boolean: 0 | 1
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. SQL Sabitleri
// ─────────────────────────────────────────────────────────────────────────────

const SQL = Object.freeze({
  FIND_BY_ID: `
    SELECT id, project_id AS projectId, path, name, type,
           content, checksum, size, version,
           created_at AS createdAt, updated_at AS updatedAt,
           is_dirty   AS isDirty
    FROM   files
    WHERE  id = ?
  `,
  FIND_ALL: `
    SELECT id, project_id AS projectId, path, name, type,
           content, checksum, size, version,
           created_at AS createdAt, updated_at AS updatedAt,
           is_dirty   AS isDirty
    FROM   files
    ORDER  BY path ASC
  `,
  FIND_BY_PROJECT: `
    SELECT id, project_id AS projectId, path, name, type,
           content, checksum, size, version,
           created_at AS createdAt, updated_at AS updatedAt,
           is_dirty   AS isDirty
    FROM   files
    WHERE  project_id = ?
    ORDER  BY path ASC
  `,
  FIND_BY_PATH: `
    SELECT id, project_id AS projectId, path, name, type,
           content, checksum, size, version,
           created_at AS createdAt, updated_at AS updatedAt,
           is_dirty   AS isDirty
    FROM   files
    WHERE  project_id = ?
    AND    path       = ?
  `,
  COUNT_BY_PROJECT: `
    SELECT COUNT(*) AS count FROM files WHERE project_id = ?
  `,
  INSERT: `
    INSERT INTO files
      (id, project_id, path, name, type, content, checksum,
       size, version, created_at, updated_at, is_dirty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)
  `,
  UPDATE: `
    UPDATE files
    SET    path       = ?,
           name       = ?,
           content    = ?,
           checksum   = ?,
           size       = ?,
           updated_at = ?,
           version    = version + 1,
           is_dirty   = 0
    WHERE  id      = ?
    AND    version = ?
  `,
  UPDATE_CONTENT: `
    UPDATE files
    SET    content    = ?,
           checksum   = ?,
           size       = ?,
           updated_at = ?,
           version    = version + 1,
           is_dirty   = 0
    WHERE  id      = ?
    AND    version = ?
  `,
  /** version artırmaz — editörün her tuş basışında çağırabilmesi için */
  MARK_DIRTY: `
    UPDATE files SET is_dirty = ? WHERE id = ?
  `,
  DELETE: `
    DELETE FROM files WHERE id = ? AND version = ?
  `,
} as const);

// ─────────────────────────────────────────────────────────────────────────────
// § 7. Validasyon
// ─────────────────────────────────────────────────────────────────────────────

function validateCreateDto(dto: CreateFileDto): string | null {
  if (!dto.projectId?.trim())                              return "projectId boş olamaz";
  if (!dto.path?.trim())                                   return "path boş olamaz";
  if (dto.path.length > FILE_CONSTRAINTS.MAX_PATH_LENGTH)  return `path max ${FILE_CONSTRAINTS.MAX_PATH_LENGTH} karakter`;
  if (!dto.name?.trim())                                   return "name boş olamaz";
  if (dto.name.length > FILE_CONSTRAINTS.MAX_NAME_LENGTH)  return `name max ${FILE_CONSTRAINTS.MAX_NAME_LENGTH} karakter`;

  const size = computeByteSize(dto.content ?? "");
  if (size > FILE_CONSTRAINTS.MAX_SIZE_BYTES)
    return `boyut sınırı aşıldı: ${size} / ${FILE_CONSTRAINTS.MAX_SIZE_BYTES} byte`;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 8. Hydration
// ─────────────────────────────────────────────────────────────────────────────

function hydrateFile(row: FileRow): IFile {
  return Object.freeze({
    id:        row.id        as UUID,
    projectId: row.projectId as UUID,
    path:      row.path,
    name:      row.name,
    type:      (VALID_FILE_TYPES.has(row.type) ? row.type : FileType.Unknown) as FileType,
    content:   row.content,
    checksum:  row.checksum,
    size:      row.size,
    version:   row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isDirty:   row.isDirty === 1,
  }) as IFile;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 9. FileRepository
// ─────────────────────────────────────────────────────────────────────────────

export class FileRepository implements IFileRepository {
  constructor(
    private readonly driver:     IDatabaseDriver,
    private readonly createUUID: () => UUID,
  ) {}

  // ── Okuma ────────────────────────────────────────────────────

  async findById(id: UUID): AsyncResult<IFile> {
    const result = await tryResultAsync(
      () => this.driver.queryOne<FileRow>(SQL.FIND_BY_ID, [id]),
      ErrorCode.DB_QUERY_FAILED,
      `File sorgulanamadı: id="${id}"`,
      { fileId: id },
    );
    if (!result.ok) return result;
    if (!result.data) return err(ErrorCode.FILE_NOT_FOUND, `File bulunamadı: id="${id}"`, { context: {fileId: id} });
    return ok(hydrateFile(result.data));
  }

  async findAll(): AsyncResult<IFile[]> {
    const result = await tryResultAsync(
      () => this.driver.query<FileRow>(SQL.FIND_ALL, []),
      ErrorCode.DB_QUERY_FAILED,
      "Dosyalar listelenemedi",
    );
    if (!result.ok) return result;
    return ok(result.data.rows.map(hydrateFile));
  }

  async findByProject(projectId: UUID): AsyncResult<IFile[]> {
    const result = await tryResultAsync(
      () => this.driver.query<FileRow>(SQL.FIND_BY_PROJECT, [projectId]),
      ErrorCode.DB_QUERY_FAILED,
      `Proje dosyaları listelenemedi: projectId="${projectId}"`,
      { projectId },
    );
    if (!result.ok) return result;
    return ok(result.data.rows.map(hydrateFile));
  }

  async findByPath(projectId: UUID, path: string): AsyncResult<IFile> {
    const result = await tryResultAsync(
      () => this.driver.queryOne<FileRow>(SQL.FIND_BY_PATH, [projectId, path]),
      ErrorCode.DB_QUERY_FAILED,
      `Dosya bulunamadı: path="${path}"`,
      { projectId, path },
    );
    if (!result.ok) return result;
    if (!result.data) return err(ErrorCode.FILE_NOT_FOUND, `Dosya bulunamadı: path="${path}"`, { context: {projectId, path} });
    return ok(hydrateFile(result.data));
  }

  async countByProject(projectId: UUID): AsyncResult<number> {
    const result = await tryResultAsync(
      () => this.driver.queryOne<{ count: number }>(SQL.COUNT_BY_PROJECT, [projectId]),
      ErrorCode.DB_QUERY_FAILED,
      `Dosya sayısı alınamadı: projectId="${projectId}"`,
      { projectId },
    );
    if (!result.ok) return result;
    return ok(result.data?.count ?? 0);
  }

  // ── Yazma ────────────────────────────────────────────────────

  /**
   * Yeni dosya oluşturur.
   *
   * ← [1] TOCTOU fix: findByPath() ön kontrolü KALDIRILDI.
   *
   * Akış:
   *   INSERT → başarı          → findById ile hydrate et → ok(file)
   *   INSERT → UNIQUE constraint → DUPLICATE_RECORD döner (atomik garanti)
   *   INSERT → diğer DB hatası  → FILE_WRITE_ERROR döner
   *
   * Thread A ve Thread B aynı anda aynı (projectId, path) ile INSERT yaparsa:
   *   Biri SQLITE_CONSTRAINT alır → DUPLICATE_RECORD'a çevrilir.
   *   Uygulama katmanında race condition yoktur.
   */
  async create(dto: CreateFileDto): AsyncResult<IFile> {
    const validationError = validateCreateDto(dto);
    if (validationError) {
      return err(ErrorCode.VALIDATION_ERROR, validationError, { context: {dto: dto as unknown as Record<string, unknown>,} });
    }

    const content  = dto.content ?? "";
    const id       = this.createUUID();
    const now      = Date.now();
    const checksum = computeChecksum(content);
    const size     = computeByteSize(content);
    const type     = dto.type ?? resolveFileType(dto.name);

    try {
      await this.driver.execute(SQL.INSERT, [
        id,
        dto.projectId,
        dto.path.trim(),
        dto.name.trim(),
        type,
        content,
        checksum,
        size,
        now,
        now,
      ]);
    } catch (cause) {
      // ← [1] UNIQUE constraint → DUPLICATE_RECORD (atomik)
      if (isSQLiteConstraintError(cause)) {
        return err(
          ErrorCode.DUPLICATE_RECORD,
          `Bu path zaten mevcut: "${dto.path}"`,
          { projectId: dto.projectId, path: dto.path },
          cause,
        );
      }
      // Diğer DB hataları
      return err(
        ErrorCode.FILE_WRITE_ERROR,
        `Dosya oluşturulamadı: path="${dto.path}"`,
        { dto: dto as unknown as Record<string, unknown> },
        cause,
      );
    }

    return this.findById(id);
  }

  /**
   * Path, name ve/veya içerik günceller.
   * Optimistic lock zorunludur.
   */
  async update(
    id:              UUID,
    dto:             UpdateFileDto,
    expectedVersion: number,
  ): AsyncResult<IFile> {
    const current = await this.findById(id);
    if (!current.ok) return current;

    const file    = current.data;
    const content = dto.content  ?? file.content;
    const path    = dto.path?.trim() ?? file.path;
    const name    = dto.name?.trim() ?? file.name;

    const checksum = dto.content !== undefined ? computeChecksum(content) : file.checksum;
    const size     = dto.content !== undefined ? computeByteSize(content) : file.size;

    if (size > FILE_CONSTRAINTS.MAX_SIZE_BYTES) {
      return err(ErrorCode.VALIDATION_ERROR, `Güncellenmiş boyut sınırı aşıyor: ${size} byte`, { context: {fileId: id, size} });
    }

    const execResult = await tryResultAsync(
      () => this.driver.execute(SQL.UPDATE, [path, name, content, checksum, size, Date.now(), id, expectedVersion]),
      ErrorCode.FILE_WRITE_ERROR,
      `Dosya güncellenemedi: id="${id}"`,
      { fileId: id },
    );
    if (!execResult.ok) return execResult;

    if (execResult.data.rowsAffected === 0) {
      return err(ErrorCode.OPTIMISTIC_LOCK_CONFLICT, "Optimistic lock çakışması — dosyayı yeniden çekip tekrar deneyin", { context: {fileId: id, expectedVersion} });
    }

    return this.findById(id);
  }

  /** Yalnızca içerik günceller. Auto-save akışında kullanılır. */
  async updateContent(
    id:               UUID,
    content:          string,
    expectedVersion?: number,
  ): AsyncResult<IFile> {
    const size = computeByteSize(content);
    if (size > FILE_CONSTRAINTS.MAX_SIZE_BYTES) {
      return err(ErrorCode.VALIDATION_ERROR, `İçerik boyutu sınırı aşıyor: ${size} byte`, { context: {fileId: id, size} });
    }

    // expectedVersion undefined ise önce mevcut version'ı çek
    let lockVersion = expectedVersion;
    if (lockVersion === undefined) {
      const cur = await this.findById(id);
      if (!cur.ok) return cur;
      lockVersion = cur.data.version;
    }

    const execResult = await tryResultAsync(
      () => this.driver.execute(SQL.UPDATE_CONTENT, [content, computeChecksum(content), size, Date.now(), id, lockVersion]),
      ErrorCode.FILE_WRITE_ERROR,
      `İçerik güncellenemedi: id="${id}"`,
      { fileId: id },
    );
    if (!execResult.ok) return execResult;

    if (execResult.data.rowsAffected === 0) {
      return err(ErrorCode.OPTIMISTIC_LOCK_CONFLICT, "İçerik güncelleme sırasında lock çakışması", { context: {fileId: id, expectedVersion} });
    }

    return this.findById(id);
  }

  /** isDirty günceller. Version artırmaz — editörden sık çağrılabilir. */
  async markDirty(id: UUID, dirty: boolean): AsyncResult<void> {
    const result = await tryResultAsync(
      () => this.driver.execute(SQL.MARK_DIRTY, [dirty ? 1 : 0, id]),
      ErrorCode.FILE_WRITE_ERROR,
      `isDirty güncellenemedi: id="${id}"`,
      { fileId: id, dirty },
    );
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  }

  /** Hard-delete. Optimistic lock uygulanır. */
  async delete(id: UUID): AsyncResult<void> {
    const current = await this.findById(id);
    if (!current.ok) return current;

    const execResult = await tryResultAsync(
      () => this.driver.execute(SQL.DELETE, [id, current.data.version]),
      ErrorCode.FILE_WRITE_ERROR,
      `Dosya silinemedi: id="${id}"`,
      { fileId: id },
    );
    if (!execResult.ok) return execResult;

    if (execResult.data.rowsAffected === 0) {
      return err(ErrorCode.OPTIMISTIC_LOCK_CONFLICT, `Silme sırasında lock çakışması: id="${id}"`, { context: {fileId: id} });
    }

    return ok(undefined);
  }
}
