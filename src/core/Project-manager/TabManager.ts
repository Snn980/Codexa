/**
 * @file     TabManager.ts
 * @module   core/project-manager
 * @version  1.0.1
 */

import type { AsyncResult, CursorPosition, IEventBus, IFile, ITab, UUID } from "../../types/core";
import { DEFAULT_SETTINGS, ErrorCode } from "../../types/core";
import { err, ok } from "../../utils/result";
import type { FileService } from "../Service/FileService";

interface MutableTab {
  id: UUID; fileId: UUID; title: string;
  isActive: boolean; isDirty: boolean; openedAt: number;
  cursorPosition?: CursorPosition; scrollTop?: number;
}

const freezeTab = (t: MutableTab): ITab => Object.freeze({ ...t }) as ITab;

export interface ITabManager {
  readonly tabs: readonly ITab[];
  readonly activeTab: ITab | null;
  openTab(file: IFile): AsyncResult<ITab>;
  closeTab(tabId: UUID): AsyncResult<void>;
  focusTab(tabId: UUID): AsyncResult<ITab>;
  updateTabPosition(tabId: UUID, cursor: CursorPosition, scrollTop?: number): void;
  closeAllTabs(): AsyncResult<void>;
  // FIX #1: setMaxTabs artık Promise<void> döndürüyor — async closeTab çağrılarını
  // doğru şekilde await edebilmek ve hataları yüzeye çıkarmak için gerekli.
  setMaxTabs(n: number): Promise<void>;
  dispose(): void;
}

export class TabManager implements ITabManager {
  private _tabs: MutableTab[] = [];
  private _maxTabs = DEFAULT_SETTINGS.maxTabs;
  private readonly unsubs: Array<() => void> = [];

  constructor(
    private readonly fileService: FileService,
    private readonly eventBus: IEventBus,
    private readonly createUUID: () => UUID,
    maxTabs?: number,
  ) {
    if (maxTabs !== undefined) this._maxTabs = maxTabs;
    this.bindEvents();
  }

  get tabs(): readonly ITab[] { return Object.freeze(this._tabs.map(freezeTab)); }
  get activeTab(): ITab | null {
    const a = this._tabs.find((t) => t.isActive);
    return a ? freezeTab(a) : null;
  }

  async openTab(file: IFile): AsyncResult<ITab> {
    const existing = this._tabs.find((t) => t.fileId === file.id);
    if (existing) return this.focusTab(existing.id);

    if (this._tabs.length >= this._maxTabs) {
      const oldest = [...this._tabs].sort((a, b) => a.openedAt - b.openedAt)[0];
      if (oldest) { const r = await this.closeTab(oldest.id); if (!r.ok) return r; }
    }

    for (const t of this._tabs) t.isActive = false;
    const tab: MutableTab = {
      id: this.createUUID(), fileId: file.id, title: file.name,
      isActive: true, isDirty: file.isDirty, openedAt: Date.now(),
    };
    this._tabs.push(tab);
    this.eventBus.emit("editor:tab:opened", { file });
    this.eventBus.emit("editor:tab:focused", { fileId: file.id });
    return ok(freezeTab(tab));
  }

  async closeTab(tabId: UUID): AsyncResult<void> {
    const idx = this._tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return err(ErrorCode.RECORD_NOT_FOUND, `Tab not found: "${tabId}"`, { context: {tabId} });

    const tab = this._tabs[idx];

    // FIX #2: Dirty tab kapatılırken dosya servisten alınamazsa (fr.ok === false)
    // artık hata döndürülüyor; değişiklikler sessizce kaybolmuyor.
    if (tab.isDirty) {
      const fr = await this.fileService.getFile(tab.fileId);
      if (!fr.ok) return fr;
      const sr = await this.fileService.saveFile(tab.fileId, fr.data.content);
      if (!sr.ok) return sr;
    }

    const wasActive = tab.isActive;
    this._tabs.splice(idx, 1);
    if (wasActive && this._tabs.length > 0) {
      const ni = Math.min(idx, this._tabs.length - 1);
      this._tabs[ni].isActive = true;
      this.eventBus.emit("editor:tab:focused", { fileId: this._tabs[ni].fileId });
    }
    this.eventBus.emit("editor:tab:closed", { fileId: tab.fileId });
    return ok(undefined);
  }

  async focusTab(tabId: UUID): AsyncResult<ITab> {
    const tab = this._tabs.find((t) => t.id === tabId);
    if (!tab) return err(ErrorCode.RECORD_NOT_FOUND, `Tab not found: "${tabId}"`, { context: {tabId} });
    for (const t of this._tabs) t.isActive = false;
    tab.isActive = true;
    this.eventBus.emit("editor:tab:focused", { fileId: tab.fileId });
    return ok(freezeTab(tab));
  }

  updateTabPosition(tabId: UUID, cursor: CursorPosition, scrollTop?: number): void {
    const tab = this._tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.cursorPosition = cursor;
    if (scrollTop !== undefined) tab.scrollTop = scrollTop;
  }

  async closeAllTabs(): AsyncResult<void> {
    const ids = this._tabs.map((t) => t.id);
    for (const id of ids) { const r = await this.closeTab(id); if (!r.ok) return r; }
    return ok(undefined);
  }

  // FIX #1 (devam): forEach yerine for...of + await kullanılıyor.
  // Eski haliyle closeTab'ın promise'ı beklenmiyordu; dirty tab'lar
  // kaydedilmeden kapanıyor, hatalar tamamen yutuluyordu.
  async setMaxTabs(n: number): Promise<void> {
    this._maxTabs = Math.max(1, n);
    const excess = this._tabs.length - this._maxTabs;
    if (excess > 0) {
      const toClose = [...this._tabs]
        .sort((a, b) => a.openedAt - b.openedAt)
        .slice(0, excess);
      for (const t of toClose) {
        await this.closeTab(t.id);
      }
    }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.unsubs.length = 0; }

  private bindEvents(): void {
    this.unsubs.push(this.eventBus.on("file:dirty", ({ fileId, isDirty }) => {
      const t = this._tabs.find((t) => t.fileId === fileId);
      if (t) t.isDirty = isDirty;
    }));
    this.unsubs.push(this.eventBus.on("file:saved", ({ file }) => {
      const t = this._tabs.find((t) => t.fileId === file.id);
      if (t) { t.isDirty = false; t.title = file.name; }
    }));
    // FIX #3: settings:changed event'i artık setMaxTabs'ın döndürdüğü
    // promise'ı .catch ile handle ediyor; unhandled rejection önleniyor.
    this.unsubs.push(this.eventBus.on("settings:changed", ({ next }) => {
      this.setMaxTabs(next.maxTabs).catch((e) => {
        this.eventBus.emit("editor:error", { error: e });
      });
    }));
    this.unsubs.push(this.eventBus.on("file:deleted", ({ fileId }) => {
      const tab = this._tabs.find((t) => t.fileId === fileId);
      if (!tab) return;
      const idx = this._tabs.indexOf(tab);
      const wasActive = tab.isActive;
      this._tabs.splice(idx, 1);
      if (wasActive && this._tabs.length > 0) {
        const ni = Math.min(idx, this._tabs.length - 1);
        this._tabs[ni].isActive = true;
        this.eventBus.emit("editor:tab:focused", { fileId: this._tabs[ni].fileId });
      }
      this.eventBus.emit("editor:tab:closed", { fileId });
    }));
  }
}
