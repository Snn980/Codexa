/**
 * @file     ProjectService.ts
 * @module   core/services
 * @version  1.0.0
 * @since    Phase 1 — Foundation
 *
 * @description
 *   Proje iş mantığı katmanı.
 *   ProjectRepository üzerinde orkestrasyon yapar;
 *   her başarılı mutasyonun ardından EventBus'a ilgili olayı yayar.
 *
 * Tasarım kararları:
 *   • Service, repository'nin optimistic lock sürümünü yönetir:
 *       update(id, dto)  →  findById (sürümü al)  →  repo.update(id, dto, version)
 *       Çakışmada Result<OPTIMISTIC_LOCK_CONFLICT> çağırana iletilir; retry UI katmanına bırakılır.
 *   • Olaylar yalnızca başarılı operasyonlarda yayılır (EventBus fire-and-forget).
 *   • status değişikliği her zaman hem "project:updated" hem "project:status:changed" yayar.
 *   • openProject() DB'yi güncellemiyor; yalnızca event yayıp proje verisini döner.
 *     (lastOpenedAt gerekirse Phase 2'de meta alanına eklenir.)
 *   • deleteProject() soft-delete — PendingGC'ye alır; fiziksel silme GC servisi işi.
 */

import type {
  AsyncResult,
  CreateProjectDto,
  IEventBus,
  IProject,
  ProjectStatus,
  UpdateProjectDto,
  UUID,
} from "../../types/core";

import { ok } from "../../utils/result";
import type { ProjectRepository } from "../../storage/repositories/ProjectRepository";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Kontrat
// ─────────────────────────────────────────────────────────────────────────────

export interface IProjectService {
  createProject(dto: CreateProjectDto):                   AsyncResult<IProject>;
  getProject(id: UUID):                                   AsyncResult<IProject>;
  getAllProjects():                                        AsyncResult<IProject[]>;
  getRecentProjects(limit: number):                       AsyncResult<IProject[]>;
  getProjectsByStatus(status: ProjectStatus):             AsyncResult<IProject[]>;
  projectExists(id: UUID):                                AsyncResult<boolean>;
  updateProject(id: UUID, dto: UpdateProjectDto):         AsyncResult<IProject>;
  openProject(id: UUID):                                  AsyncResult<IProject>;
  deleteProject(id: UUID):                                AsyncResult<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. ProjectService
// ─────────────────────────────────────────────────────────────────────────────

export class ProjectService implements IProjectService {
  constructor(
    /**
     * Concrete tip — optimistic lock versiyonlu update() için.
     * IProjectRepository.update() imzası version parametresi içermediğinden
     * servis katmanı concrete repository'yi alır.
     * Phase 2 refactor'ında IVersionedProjectRepository ayrılabilir.
     */
    private readonly projectRepo: ProjectRepository,
    private readonly eventBus:    IEventBus,
  ) {}

  // ── Okuma ──────────────────────────────────────────────────────

  async getProject(id: UUID): AsyncResult<IProject> {
    return this.projectRepo.findById(id);
  }

  async getAllProjects(): AsyncResult<IProject[]> {
    return this.projectRepo.findAll();
  }

  async getRecentProjects(limit: number): AsyncResult<IProject[]> {
    return this.projectRepo.findRecent(limit);
  }

  async getProjectsByStatus(status: ProjectStatus): AsyncResult<IProject[]> {
    return this.projectRepo.findByStatus(status);
  }

  async projectExists(id: UUID): AsyncResult<boolean> {
    return this.projectRepo.exists(id);
  }

  // ── Mutasyon ───────────────────────────────────────────────────

  /**
   * Yeni proje oluşturur ve "project:created" yayar.
   *
   * @example
   *   const result = await projectService.createProject({
   *     name: "My App",
   *     language: ProjectLanguage.TypeScript,
   *   });
   */
  async createProject(dto: CreateProjectDto): AsyncResult<IProject> {
    const result = await this.projectRepo.create(dto);
    if (!result.ok) return result;

    this.eventBus.emit("project:created", { project: result.data });
    return ok(result.data);
  }

  /**
   * Proje alanlarını günceller.
   *
   * Akış:
   *   findById (mevcut version) → repo.update(id, dto, version)
   *   → "project:updated" yayar
   *   → status değiştiyse "project:status:changed" de yayar
   *
   * Conflict senaryosu:
   *   Başka bir istemci aynı anda update ettiyse OPTIMISTIC_LOCK_CONFLICT döner.
   *   Çağıran yeniden çekip tekrar denemeli veya kullanıcıya bildirmeli.
   *
   * @param id  — güncellenecek proje ID'si
   * @param dto — güncellenecek alanlar (partial)
   */
  async updateProject(id: UUID, dto: UpdateProjectDto): AsyncResult<IProject> {
    // Mevcut sürümü al — optimistic lock için gerekli
    const current = await this.projectRepo.findById(id);
    if (!current.ok) return current;

    const prevStatus = current.data.status;

    const result = await this.projectRepo.update(id, dto, current.data.version);
    if (!result.ok) return result;

    // ── Event yayını ───────────────────────────────────────────────
    this.eventBus.emit("project:updated", { project: result.data });

    if (dto.status !== undefined && dto.status !== prevStatus) {
      this.eventBus.emit("project:status:changed", {
        projectId: id,
        from:      prevStatus,
        to:        dto.status,
      });
    }

    return ok(result.data);
  }

  /**
   * Projeyi açar — DB mutasyonu YOK, yalnızca event yayar.
   * "project:opened" UI katmanına tab/editor hazırlığı için sinyal verir.
   *
   * @example
   *   const result = await projectService.openProject(projectId);
   */
  async openProject(id: UUID): AsyncResult<IProject> {
    const result = await this.projectRepo.findById(id);
    if (!result.ok) return result;

    this.eventBus.emit("project:opened", { project: result.data });
    return ok(result.data);
  }

  /**
   * Projeyi soft-delete eder (PendingGC durumuna alır).
   * Fiziksel silme ilerideki GC servisine bırakılır.
   * Başarı halinde "project:deleted" yayar.
   *
   * @example
   *   const result = await projectService.deleteProject(projectId);
   */
  async deleteProject(id: UUID): AsyncResult<void> {
    const result = await this.projectRepo.delete(id);
    if (!result.ok) return result;

    this.eventBus.emit("project:deleted", { projectId: id });
    return ok(undefined);
  }
}
