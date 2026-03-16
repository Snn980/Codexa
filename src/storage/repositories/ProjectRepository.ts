/**
 * @file     ProjectRepository.ts
 * @module   storage/repositories
 * @version  1.1.0
 * @since    Phase 1 — Foundation
 *
 * @description
 *   IProjectRepository kontratının SQLite implementasyonu.
 *
 * ── v1.1.0 değişiklikleri ────────────────────────────────────────────────────
 *
 *  [1] Optimistic Locking  (TOCTOU race condition fix)
 *      UPDATE / DELETE sorgularına  WHERE id = ? AND version = ?  koşulu eklendi.
 *      rowsAffected = 0  →  OPTIMISTIC_LOCK_CONFLICT hatası döner.
 *      Çağıran taraf retry veya kullanıcı bildirimi seçer.
 *
 *      Bağımlı güncelleme gerektiren dosyalar:
 *        • core.ts        → ErrorCode.OPTIMISTIC_LOCK_CONFLICT eklenmeli
 *        • core.ts        → IProject.version: number eklenmeli
 *        • Database.ts    → IDatabaseDriver.execute() → Promise<ExecuteResult>
 *                           ExecuteResult = { rowsAffected: number; lastInsertId: number | null }
 *        • LibSQLDriver   → execute() runAsync().changes değerini döndürmeli
 *        • Database.ts    → MIGRATIONS[5]: ALTER TABLE projects ADD COLUMN version
 *
 *  [2] Enum cache  (module-level Set)
 *      Object.values(...).includes()  →  Set.has()
 *      Modül yüklenirken bir kez oluşturulur; her çağrıda allocation yok. O(1).
 */

import type {
  AsyncResult,
  CreateProjectDto,
  IProject,
  IProjectRepository,
  UpdateProjectDto,
  UUID,
} from "../../types/core";

import {
  ErrorCode,
  PROJECT_CONSTRAINTS,
  PROJECT_STATUS_TRANSITIONS,
  ProjectLanguage,
  ProjectStatus,
} from "../../types/core";

import type { IDatabaseDriver } from "../Database";
import { err, ok, tryResultAsync } from "../../utils/result";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Module-Level Enum Cache   ← [2]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Modül yüklenirken bir kez oluşturulur.
 * hydrateProject her çağrıldığında yeni dizi allocation olmaz.
 *
 * Neden module scope?
 *   • Class static field → instance yokken bile bellekte
 *   • Fonksiyon içi     → her çağrıda yeniden oluşturulur  ← istemediğimiz
 *   • Module scope      → modül ömrü boyunca tek kopya, lazy yükleme uyumlu
 */
const VALID_LANGUAGES = new Set<string>(Object.values(ProjectLanguage));
const VALID_STATUSES  = new Set<string>(Object.values(ProjectStatus));

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Veritabanı Satır Tipi
// ─────────────────────────────────────────────────────────────────────────────

/** SQLite ham satırı — yalnızca bu modülde kullanılır. */
interface ProjectRow {
  id:          string;
  name:        string;
  description: string;
  language:    string;
  status:      string;
  version:     number;    // ← [1] optimistic lock sayacı
  createdAt:   number;
  updatedAt:   number;
  metaJson:    string;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Genişletilmiş IProject  (version dahil)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository'nin döndürdüğü tip.
 * `version` alanı optimistic lock için opak sayı olarak taşınır.
 *
 * TODO: Phase 1 sonu refactor'ında core.ts → IProject.version eklenmeli;
 *       bu local interface kaldırılacak.
 */
export interface IProjectWithVersion extends IProject {
  readonly version: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. SQL Sabitleri
// ─────────────────────────────────────────────────────────────────────────────

const SQL = Object.freeze({
  FIND_BY_ID: `
    SELECT id, name, description, language, status, version,
           created_at AS createdAt, updated_at AS updatedAt,
           meta_json  AS metaJson
    FROM   projects
    WHERE  id = ?
  `,
  FIND_ALL: `
    SELECT id, name, description, language, status, version,
           created_at AS createdAt, updated_at AS updatedAt,
           meta_json  AS metaJson
    FROM   projects
    WHERE  status != ?
    ORDER  BY updated_at DESC
  `,
  FIND_BY_STATUS: `
    SELECT id, name, description, language, status, version,
           created_at AS createdAt, updated_at AS updatedAt,
           meta_json  AS metaJson
    FROM   projects
    WHERE  status = ?
    ORDER  BY updated_at DESC
  `,
  FIND_RECENT: `
    SELECT id, name, description, language, status, version,
           created_at AS createdAt, updated_at AS updatedAt,
           meta_json  AS metaJson
    FROM   projects
    WHERE  status != ?
    ORDER  BY updated_at DESC
    LIMIT  ?
  `,
  EXISTS: `
    SELECT COUNT(*) AS count FROM projects WHERE id = ?
  `,
  INSERT: `
    INSERT INTO projects
      (id, name, description, language, status, version, created_at, updated_at, meta_json)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `,
  /**
   * ← [1] Optimistic lock:
   *   version = version + 1  →  başarılı her yazım sayacı artırır
   *   AND version = ?         →  başka istemci araya girdiyse rowsAffected = 0
   */
  UPDATE: `
    UPDATE projects
    SET    name        = ?,
           description = ?,
           status      = ?,
           updated_at  = ?,
           meta_json   = ?,
           version     = version + 1
    WHERE  id      = ?
    AND    version = ?
  `,
  DELETE: `
    UPDATE projects
    SET    status     = ?,
           updated_at = ?,
           version    = version + 1
    WHERE  id      = ?
    AND    version = ?
  `,
} as const);

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Validasyon
// ─────────────────────────────────────────────────────────────────────────────

function validateCreateDto(dto: CreateProjectDto): string | null {
  const name = dto.name?.trim() ?? "";

  if (name.length < PROJECT_CONSTRAINTS.NAME_MIN)
    return `name en az ${PROJECT_CONSTRAINTS.NAME_MIN} karakter olmalı`;

  if (name.length > PROJECT_CONSTRAINTS.NAME_MAX)
    return `name en fazla ${PROJECT_CONSTRAINTS.NAME_MAX} karakter olabilir`;

  if (!VALID_LANGUAGES.has(dto.language))           // ← O(1)
    return `geçersiz language: "${dto.language}"`;

  return null;
}

function isValidTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return (PROJECT_STATUS_TRANSITIONS[from] as readonly string[]).includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Hydration
// ─────────────────────────────────────────────────────────────────────────────

function hydrateProject(row: ProjectRow): IProjectWithVersion {
  return Object.freeze({
    id:          row.id as UUID,
    name:        row.name,
    description: row.description,
    language:    (VALID_LANGUAGES.has(row.language)   // ← O(1) Set.has()
      ? row.language
      : ProjectLanguage.JavaScript) as ProjectLanguage,
    status:      (VALID_STATUSES.has(row.status)       // ← O(1) Set.has()
      ? row.status
      : ProjectStatus.Active) as ProjectStatus,
    version:     row.version,
    createdAt:   row.createdAt,
    updatedAt:   row.updatedAt,
    meta:        safeParseJSON(row.metaJson),
  }) as IProjectWithVersion;
}

function safeParseJSON(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7. ProjectRepository
// ─────────────────────────────────────────────────────────────────────────────

export class ProjectRepository implements IProjectRepository {
  constructor(
    private readonly driver:     IDatabaseDriver,
    private readonly createUUID: () => UUID,
  ) {}

  // ── Okuma ────────────────────────────────────────────────────

  async findById(id: UUID): AsyncResult<IProjectWithVersion> {
    const result = await tryResultAsync(
      () => this.driver.queryOne<ProjectRow>(SQL.FIND_BY_ID, [id]),
      ErrorCode.DB_QUERY_FAILED,
      `Project sorgulanamadı: id="${id}"`,
      { projectId: id },
    );

    if (!result.ok) return result;
    if (!result.data) {
      return err(
        ErrorCode.RECORD_NOT_FOUND,
        `Project bulunamadı: id="${id}"`,
        { projectId: id },
      );
    }

    return ok(hydrateProject(result.data));
  }

  async findAll(): AsyncResult<IProjectWithVersion[]> {
    const result = await tryResultAsync(
      () => this.driver.query<ProjectRow>(SQL.FIND_ALL, [ProjectStatus.PendingGC]),
      ErrorCode.DB_QUERY_FAILED,
      "Projeler listelenemedi",
    );
    if (!result.ok) return result;
    return ok(result.data.rows.map(hydrateProject));
  }

  async findByStatus(status: ProjectStatus): AsyncResult<IProjectWithVersion[]> {
    const result = await tryResultAsync(
      () => this.driver.query<ProjectRow>(SQL.FIND_BY_STATUS, [status]),
      ErrorCode.DB_QUERY_FAILED,
      `Status="${status}" projeleri listelenemedi`,
      { status },
    );
    if (!result.ok) return result;
    return ok(result.data.rows.map(hydrateProject));
  }

  async findRecent(limit: number): AsyncResult<IProjectWithVersion[]> {
    if (limit < 1 || !Number.isInteger(limit)) {
      return err(ErrorCode.VALIDATION_ERROR, `limit pozitif tam sayı olmalı: ${limit}`, { limit });
    }
    const result = await tryResultAsync(
      () => this.driver.query<ProjectRow>(SQL.FIND_RECENT, [ProjectStatus.PendingGC, limit]),
      ErrorCode.DB_QUERY_FAILED,
      "Son projeler listelenemedi",
      { limit },
    );
    if (!result.ok) return result;
    return ok(result.data.rows.map(hydrateProject));
  }

  async exists(id: UUID): AsyncResult<boolean> {
    const result = await tryResultAsync(
      () => this.driver.queryOne<{ count: number }>(SQL.EXISTS, [id]),
      ErrorCode.DB_QUERY_FAILED,
      `Varlık kontrolü başarısız: id="${id}"`,
      { projectId: id },
    );
    if (!result.ok) return result;
    return ok((result.data?.count ?? 0) > 0);
  }

  // ── Yazma ────────────────────────────────────────────────────

  async create(dto: CreateProjectDto): AsyncResult<IProjectWithVersion> {
    const validationError = validateCreateDto(dto);
    if (validationError) {
      return err(ErrorCode.VALIDATION_ERROR, validationError, {
        dto: dto as unknown as Record<string, unknown>,
      });
    }

    const now  = Date.now();
    const id   = this.createUUID();
    const meta = JSON.stringify(dto.meta ?? {});

    const insertResult = await tryResultAsync(
      () => this.driver.execute(SQL.INSERT, [
        id, dto.name.trim(), dto.description?.trim() ?? "",
        dto.language, ProjectStatus.Empty, now, now, meta,
      ]),
      ErrorCode.DB_QUERY_FAILED,
      `Project oluşturulamadı: name="${dto.name}"`,
    );

    if (!insertResult.ok) return insertResult;
    return this.findById(id);
  }

  /**
   * Projeyi günceller. Optimistic lock ile TOCTOU korunması.
   *
   * @param expectedVersion  findById'dan alınan project.version değeri.
   *
   * Conflict senaryosu:
   *   A ve B aynı anda findById → her ikisi de version=5 alır
   *   A update() → version 5→6, rowsAffected=1  ✅
   *   B update() → WHERE version=5, artık 6 → rowsAffected=0
   *             → OPTIMISTIC_LOCK_CONFLICT döner  ✅
   */
  async update(
    id:              UUID,
    dto:             UpdateProjectDto,
    expectedVersion: number,
  ): AsyncResult<IProjectWithVersion> {
    const current = await this.findById(id);
    if (!current.ok) return current;

    const project = current.data;

    // Durum geçiş kuralı
    if (dto.status && dto.status !== project.status) {
      if (!isValidTransition(project.status, dto.status)) {
        return err(
          ErrorCode.VALIDATION_ERROR,
          `Geçersiz durum geçişi: "${project.status}" → "${dto.status}"`,
          { projectId: id, from: project.status, to: dto.status },
        );
      }
    }

    const updatedMeta = dto.meta
      ? JSON.stringify({ ...project.meta, ...dto.meta })
      : JSON.stringify(project.meta);

    const execResult = await tryResultAsync(
      () => this.driver.execute(SQL.UPDATE, [
        dto.name?.trim()        ?? project.name,
        dto.description?.trim() ?? project.description,
        dto.status              ?? project.status,
        Date.now(),
        updatedMeta,
        id,
        expectedVersion,        // ← WHERE version = ?
      ]),
      ErrorCode.DB_QUERY_FAILED,
      `Project güncellenemedi: id="${id}"`,
      { projectId: id },
    );

    if (!execResult.ok) return execResult;

    // rowsAffected = 0 → conflict veya kayıt yok
    if (execResult.data.rowsAffected === 0) {
      const existsResult = await this.exists(id);

      if (existsResult.ok && !existsResult.data) {
        return err(ErrorCode.RECORD_NOT_FOUND, `Project bulunamadı: id="${id}"`, { projectId: id });
      }

      return err(
        ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
        `Optimistic lock çakışması — kaydı yeniden çekip tekrar deneyin`,
        { projectId: id, expectedVersion },
      );
    }

    return this.findById(id);
  }

  /** Soft-delete — PendingGC'ye alır. Optimistic lock uygulanır. */
  async delete(id: UUID): AsyncResult<void> {
    const current = await this.findById(id);
    if (!current.ok) return current;

    if (current.data.status === ProjectStatus.PendingGC) return ok(undefined);

    const execResult = await tryResultAsync(
      () => this.driver.execute(SQL.DELETE, [
        ProjectStatus.PendingGC,
        Date.now(),
        id,
        current.data.version,   // ← WHERE version = ?
      ]),
      ErrorCode.DB_QUERY_FAILED,
      `Project silinemedi: id="${id}"`,
      { projectId: id },
    );

    if (!execResult.ok) return execResult;

    if (execResult.data.rowsAffected === 0) {
      return err(
        ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
        `Silme sırasında lock çakışması: id="${id}"`,
        { projectId: id, version: current.data.version },
      );
    }

    return ok(undefined);
  }
}
