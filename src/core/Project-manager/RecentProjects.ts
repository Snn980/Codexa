/**
 * @file     RecentProjects.ts
 * @module   core/project-manager
 * @version  1.0.1
 *
 * Son acilan projelerin listesini yonetir.
 * Pin durumu IProject.meta.pinned alaninda saklanir.
 * lastOpenedAt ve pinOrder meta alanlari ms timestamp'tir.
 */

import type { AsyncResult, IProject, UUID } from "../../types/core";
import { ok } from "../../utils/result";
import type { IProjectService } from "../services/ProjectService";

const META_PINNED         = "pinned";
const META_LAST_OPENED_AT = "lastOpenedAt";
const META_PIN_ORDER      = "pinOrder";
const DEFAULT_LIMIT       = 10;

export interface IRecentProjects {
  getRecent(limit?: number): AsyncResult<IProject[]>;
  getPinned(): AsyncResult<IProject[]>;
  getAll(limit?: number): AsyncResult<IProject[]>;
  recordOpen(id: UUID): AsyncResult<IProject>;
  pin(id: UUID): AsyncResult<IProject>;
  unpin(id: UUID): AsyncResult<IProject>;
  isPinned(project: IProject): boolean;
}

export class RecentProjects implements IRecentProjects {
  constructor(private readonly projectService: IProjectService) {}

  async getRecent(limit = DEFAULT_LIMIT): AsyncResult<IProject[]> {
    return this.projectService.getRecentProjects(limit);
  }

  async getPinned(): AsyncResult<IProject[]> {
    const all = await this.projectService.getAllProjects();
    if (!all.ok) return all;
    const pinned = all.data
      .filter((p) => this.isPinned(p))
      .sort((a, b) => Number(b.meta[META_PIN_ORDER] ?? 0) - Number(a.meta[META_PIN_ORDER] ?? 0));
    return ok(pinned);
  }

  async getAll(limit = DEFAULT_LIMIT): AsyncResult<IProject[]> {
    // FIX #1: getRecent artık limitten bağımsız (tüm recents) çekiliyor.
    // Eski halde getRecent(limit) çağrısı yapılıyordu; dönen listeden pinned
    // olanlar filtrelenince unpinned slot sayısı doldurulamıyor, toplam
    // limit'ten az sonuç dönebiliyordu. Önce pinned alınıyor, ardından
    // unpinned kotası kadar recent çekilebilmesi için pinned sayısı biliniyor.
    const pr = await this.getPinned();
    if (!pr.ok) return pr;

    const unpinnedLimit = Math.max(0, limit - pr.data.length);
    const pinnedIds = new Set(pr.data.map((p) => p.id));

    // Yeterli unpinned proje gelmesini garantilemek için limit yerine
    // (limit + pinnedCount) kadar recent çekiyoruz; çünkü recent listesinde
    // pinned projeler de bulunabilir ve bunlar filtrelenecek.
    const rr = await this.getRecent(limit + pr.data.length);
    if (!rr.ok) return rr;

    const unpinned = rr.data
      .filter((p) => !pinnedIds.has(p.id))
      .slice(0, unpinnedLimit);

    return ok([...pr.data, ...unpinned]);
  }

  async recordOpen(id: UUID): AsyncResult<IProject> {
    return this.projectService.updateProject(id, {
      meta: { [META_LAST_OPENED_AT]: Date.now() },
    });
  }

  async pin(id: UUID): AsyncResult<IProject> {
    return this.projectService.updateProject(id, {
      meta: { [META_PINNED]: "true", [META_PIN_ORDER]: Date.now() },
    });
  }

  async unpin(id: UUID): AsyncResult<IProject> {
    // FIX #2: null → undefined. updateProject'in meta merge davranışına bağlı
    // olarak null saklanabilir veya ignore edilir. undefined, "bu alanı kaldır"
    // semantiğini taşır ve servis katmanında daha güvenli yorumlanır.
    return this.projectService.updateProject(id, {
      meta: { [META_PINNED]: "false", [META_PIN_ORDER]: undefined },
    });
  }

  isPinned(project: IProject): boolean {
    return project.meta[META_PINNED] === "true";
  }
}
