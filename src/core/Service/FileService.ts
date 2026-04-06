/**
 * @file     FileService.ts
 * @module   core/services
 * @version  1.0.0
 * @since    Phase 1 — Foundation
 *
 * @description
 *   Dosya iş mantığı katmanı.
 *   FileRepository üzerinde orkestrasyon yapar;
 *   auto-save, dirty tracking ve checksum diff gibi üst düzey davranışları sağlar.
 *
 * Temel özellikler:
 *
 *   Auto-save (debounce)
 *     scheduleAutoSave(fileId, content) çağrısı mevcut zamanlayıcıyı iptal eder,
 *     yenisini `autoSaveIntervalMs` ms sonra başlatır.
 *     Timer tetiklendiğinde checksum diff çalıştırılır; içerik değişmemişse DB'ye dokunulmaz.
 *
 *   Dirty tracking
 *     onContentChange() → markDirty(true) + scheduleAutoSave()
 *     Auto-save tamamlandığında repo.updateContent() is_dirty=0 yazar,
 *     ardından "file:dirty" (false) yayılır.
 *
 *   Checksum diff (FNV-1a — FileRepository ile tutarlı)
 *     In-memory cache (checksumCache) son kaydedilen checksum'u tutar.
 *     Aynı içerik tekrar gönderilirse DB yazımı atlanır.
 *     Cache yalnızca başarılı kayıt sonrası güncellenir.
 *
 *   Optimistic lock
 *     saveFile / onContentChange versiyonu repo'dan çeker.
 *     Conflict halinde OPTIMISTIC_LOCK_CONFLICT çağırana iletilir.
 *
 * Tasarım kararları:
 *   • FileRepository concrete tip — versiyonlu updateContent() için (IFileRepository 2-param).
 *   • dispose() tüm bekleyen zamanlayıcıları iptal eder — bellek sızıntısı yok.
 *   • EventBus çağrıları fire-and-forget; hata fırlatsa da servis devam eder.
 *   • autoSaveIntervalMs sıfır veya negatifse auto-save devre dışı kalır.
 */

import type {
  AsyncResult,
  CreateFileDto,
  IEventBus,
  IFile,
  UUID,
} from "../../types/core";

import { ErrorCode } from "../../types/core";
import { err, ok }   from "../../utils/result";
import type { FileRepository } from "../../storage/repositories/FileRepository";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Yardımcı — FNV-1a 32-bit (FileRepository ile aynı algoritma)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * İçerik değişiklik tespiti için FNV-1a 32-bit.
 * FileRepository.computeChecksum() ile birebir aynı implementasyon;
 * DB'den okunan checksum ile karşılaştırılabilir.
 * Kriptografik güvenlik hedeflenmez.
 */
function computeChecksum(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash  = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Kontrat
// ─────────────────────────────────────────────────────────────────────────────

export interface IFileService {
  /** Dosya oluşturur ve "file:created" yayar. */
  createFile(dto: CreateFileDto):                        AsyncResult<IFile>;

  /** ID ile dosya getirir. */
  getFile(id: UUID):                                     AsyncResult<IFile>;

  /** Projeye ait tüm dosyaları döner. */
  getProjectFiles(projectId: UUID):                      AsyncResult<IFile[]>;

  /**
   * Editör içerik değişikliği için ana giriş noktası.
   * markDirty(true) → scheduleAutoSave() — debounced.
   */
  onContentChange(fileId: UUID, content: string):        AsyncResult<void>;

  /**
   * Dosyayı anında kaydeder.
   * Checksum diff — içerik değişmemişse DB yazımı atlanır.
   */
  saveFile(fileId: UUID, content: string):               AsyncResult<IFile>;

  /** Bekleyen auto-save'i iptal eder ve dosyayı siler. */
  deleteFile(id: UUID):                                  AsyncResult<void>;

  /** Dosyayı yeniden adlandırır (aynı klasörde, sadece name + path son segmenti değişir). */
  renameFile(id: UUID, newName: string):                 AsyncResult<IFile>;

  /**
   * Dosyayı farklı bir klasöre taşır.
   * newFolderPath: '' → proje kökü, 'utils' → utils/ klasörü.
   */
  moveFile(id: UUID, newFolderPath: string):             AsyncResult<IFile>;

  /** Dosyayı aynı projede kopyalar. Yeni dosya adı copyName ile belirlenir. */
  copyFile(id: UUID, copyName: string):                  AsyncResult<IFile>;

  /** Tüm bekleyen zamanlayıcıları iptal eder — servis kapatılmadan önce çağrılmalı. */
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. FileService
// ─────────────────────────────────────────────────────────────────────────────

export class FileService implements IFileService {
  /**
   * Bekleyen auto-save zamanlayıcıları.
   * key: fileId  →  value: setTimeout handle
   */
  private readonly pendingSaves   = new Map<UUID, ReturnType<typeof setTimeout>>();

  /**
   * In-memory checksum cache — son başarılı kayıt sonrası güncellenir.
   * key: fileId  →  value: FNV-1a hex string
   *
   * Neden cache?
   *   updateContent() öncesi DB'den checksum okumak ekstra round-trip gerektirir.
   *   Cache ile O(1) karşılaştırma yapılır; DB yazımı yalnızca fark varsa gerçekleşir.
   */
  private readonly checksumCache  = new Map<UUID, string>();

  /**
   * Bekleyen content değişiklikleri.
   * Auto-save tetiklenmeden dispose() çağrılırsa içerik kaybolmaz;
   * arayan katman "file:dirty" eventinden haberdar olduğundan kayıp kabul edilebilir.
   * (Phase 2'de crash-recovery için bu buffer kalıcı hale getirilebilir.)
   */
  private readonly pendingContent = new Map<UUID, string>();

  constructor(
    /**
     * Concrete tip — versiyonlu updateContent(id, content, version) için.
     * IFileRepository.updateContent() imzası version parametresi içermediğinden
     * servis katmanı concrete repository'yi alır.
     * Phase 2 refactor'ında IVersionedFileRepository ayrılabilir.
     */
    private readonly fileRepo:          FileRepository,
    private readonly eventBus:          IEventBus,
    /** Milisaniye cinsinden auto-save gecikmesi. 0 veya negatifse auto-save devre dışı. */
    private readonly autoSaveIntervalMs: number,
  ) {}

  // ── Okuma ──────────────────────────────────────────────────────

  async getFile(id: UUID): AsyncResult<IFile> {
    return this.fileRepo.findById(id);
  }

  async getProjectFiles(projectId: UUID): AsyncResult<IFile[]> {
    return this.fileRepo.findByProject(projectId);
  }

  // ── Oluşturma ──────────────────────────────────────────────────

  /**
   * Yeni dosya oluşturur.
   * Checksum cache'e ilk değeri ekler; oluşturma anındaki içerik "temiz" kabul edilir.
   *
   * @example
   *   const result = await fileService.createFile({
   *     projectId, path: "src/index.ts", name: "index.ts", content: "",
   *   });
   */
  async createFile(dto: CreateFileDto): AsyncResult<IFile> {
    const result = await this.fileRepo.create(dto);
    if (!result.ok) return result;

    // Oluşturma anındaki checksum'u cache'e al
    this.checksumCache.set(result.data.id, result.data.checksum);

    this.eventBus.emit("file:created", { file: result.data });
    return ok(result.data);
  }

  // ── İçerik Değişikliği (Editör Giriş Noktası) ──────────────────

  /**
   * Editörden gelen her içerik değişikliğinde çağrılır.
   *
   * Akış:
   *   1. DB'de is_dirty=1 yaz → "file:dirty" (true) yay
   *   2. Bekleyen content'i in-memory buffer'a al
   *   3. Auto-save zamanlayıcısını (yeniden) başlat
   *
   * Performans notu:
   *   markDirty() version artırmaz (MARK_DIRTY SQL) — editörden yüksek frekanslı çağrı güvenlidir.
   *
   * @param fileId  — değişen dosyanın ID'si
   * @param content — editördeki güncel içerik
   */
  async onContentChange(fileId: UUID, content: string): AsyncResult<void> {
    // 1. Dirty flag — version artırmayan hızlı yazım
    const dirtyResult = await this.fileRepo.markDirty(fileId, true);
    if (!dirtyResult.ok) return dirtyResult;

    this.eventBus.emit("file:dirty", { fileId, isDirty: true });

    // 2. Bekleyen içeriği buffer'a al
    this.pendingContent.set(fileId, content);

    // 3. Zamanlayıcı — debounce
    this.scheduleAutoSave(fileId);

    return ok(undefined);
  }

  /**
   * Dosyayı anında kaydeder (manuel kayıt veya auto-save tetiklemesi).
   *
   * Checksum diff:
   *   Yeni içerik cache'deki ile aynıysa DB'ye dokunulmaz; ok(mevcut_dosya) döner.
   *
   * Optimistic lock:
   *   Mevcut version findById'dan alınır. Conflict halinde OPTIMISTIC_LOCK_CONFLICT döner.
   *
   * @param fileId  — kaydedilecek dosyanın ID'si
   * @param content — kaydedilecek içerik
   */
  async saveFile(fileId: UUID, content: string): AsyncResult<IFile> {
    // ── Checksum diff ──────────────────────────────────────────────
    const newChecksum = computeChecksum(content);
    const cachedChecksum = this.checksumCache.get(fileId);

    if (cachedChecksum !== undefined && cachedChecksum === newChecksum) {
      // İçerik değişmemiş — DB yazımı atla, mevcut dosyayı döndür
      const current = await this.fileRepo.findById(fileId);
      if (!current.ok) return current;
      return ok(current.data);
    }

    // ── Optimistic lock için mevcut version ────────────────────────
    const current = await this.fileRepo.findById(fileId);
    if (!current.ok) return current;

    // ── İçerik boyutu kontrolü repo içinde yapılıyor; buraya taşınmıyor ──

    const result = await this.fileRepo.updateContent(
      fileId,
      content,
      current.data.version,
    );
    if (!result.ok) return result;

    // ── Kayıt başarılı — cache ve event güncellemesi ───────────────
    this.checksumCache.set(fileId, newChecksum);
    this.pendingContent.delete(fileId);

    this.eventBus.emit("file:saved",  { file: result.data });
    this.eventBus.emit("file:dirty",  { fileId, isDirty: false });
    this.eventBus.emit("file:updated", { file: result.data });

    return ok(result.data);
  }

  // ── Silme ──────────────────────────────────────────────────────

  /**
   * Bekleyen auto-save'i iptal eder ve dosyayı hard-delete eder.
   * Cache ve buffer temizlenir.
   *
   * @example
   *   await fileService.deleteFile(fileId);
   */
  async deleteFile(id: UUID): AsyncResult<void> {
    // Bekleyen zamanlayıcı ve buffer'ı temizle
    this.cancelPendingSave(id);
    this.checksumCache.delete(id);
    this.pendingContent.delete(id);

    const result = await this.fileRepo.delete(id);
    if (!result.ok) return result;

    this.eventBus.emit("file:deleted", { fileId: id });
    return ok(undefined);
  }

  // ── Dosya Yönetimi İşlemleri ──────────────────────────────────

  /**
   * Dosyayı yeniden adlandırır.
   * Klasör prefix korunur: "utils/old.ts" → "utils/new.ts"
   */
  async renameFile(id: UUID, newName: string): AsyncResult<IFile> {
    const found = await this.fileRepo.findById(id);
    if (!found.ok) return found;

    const file    = found.data;
    const trimmed = newName.trim();
    if (!trimmed) return err('VALIDATION_ERROR' as any, 'Dosya adı boş olamaz');

    // Klasör prefix'i koru
    const segments = file.path.split('/');
    segments[segments.length - 1] = trimmed;
    const newPath = segments.join('/');

    this.cancelPendingSave(id);
    const result = await this.fileRepo.update(id, { name: trimmed, path: newPath });
    if (!result.ok) return result;

    this.eventBus.emit('file:renamed' as any, { fileId: id, oldName: file.name, newName: trimmed });
    return result;
  }

  /**
   * Dosyayı farklı bir klasöre taşır.
   * newFolderPath = '' → proje kökü  |  'utils' → utils/ altı
   */
  async moveFile(id: UUID, newFolderPath: string): AsyncResult<IFile> {
    const found = await this.fileRepo.findById(id);
    if (!found.ok) return found;

    const file    = found.data;
    const folder  = newFolderPath.trim();
    const newPath = folder ? `${folder}/${file.name}` : file.name;

    this.cancelPendingSave(id);
    const result = await this.fileRepo.update(id, { path: newPath });
    if (!result.ok) return result;

    this.eventBus.emit('file:moved' as any, { fileId: id, oldPath: file.path, newPath });
    return result;
  }

  /**
   * Dosyayı aynı projede kopyalar.
   * Yeni dosya aynı klasöre, copyName adıyla oluşturulur.
   */
  async copyFile(id: UUID, copyName: string): AsyncResult<IFile> {
    const found = await this.fileRepo.findById(id);
    if (!found.ok) return found;

    const file    = found.data;
    const trimmed = copyName.trim();
    if (!trimmed) return err('VALIDATION_ERROR' as any, 'Kopya adı boş olamaz');

    // Aynı klasör prefix'i koru
    const segments = file.path.split('/');
    segments[segments.length - 1] = trimmed;
    const copyPath = segments.join('/');

    return this.createFile({
      projectId: file.projectId,
      name:      trimmed,
      path:      copyPath,
      content:   file.content ?? '',
      type:      file.type as any,
    });
  }

  // ── Kaynakları Serbest Bırakma ─────────────────────────────────

  /**
   * Tüm bekleyen zamanlayıcıları iptal eder.
   * Servis kapatılmadan, proje değiştirilmeden veya uygulama arka plana geçmeden önce çağrılmalı.
   *
   * ⚠ dispose() sonrası kaydetilmemiş "dirty" içerik kaybolabilir.
   *    UI katmanı "file:dirty" eventini izleyerek kullanıcıyı uyarmalıdır.
   */
  dispose(): void {
    for (const [fileId] of this.pendingSaves) {
      this.cancelPendingSave(fileId);
    }
    this.pendingContent.clear();
    this.checksumCache.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § 4. Dahili Yardımcılar
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Auto-save zamanlayıcısını (yeniden) başlatır.
   * Var olan bir zamanlayıcı iptal edilir — debounce davranışı.
   * autoSaveIntervalMs ≤ 0 ise hiçbir şey yapılmaz.
   */
  private scheduleAutoSave(fileId: UUID): void {
    if (this.autoSaveIntervalMs <= 0) return;

    this.cancelPendingSave(fileId);

    const handle = setTimeout(() => {
      this.pendingSaves.delete(fileId);
      this.flushAutoSave(fileId);
    }, this.autoSaveIntervalMs);

    this.pendingSaves.set(fileId, handle);
  }

  /**
   * Auto-save zamanlayıcısını iptal eder.
   * Map'ten de kaldırır — bellek sızıntısı yok.
   */
  private cancelPendingSave(fileId: UUID): void {
    const handle = this.pendingSaves.get(fileId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.pendingSaves.delete(fileId);
    }
  }

  /**
   * Auto-save zamanlayıcısı tetiklendiğinde çalışır.
   * Buffer'daki içerik yoksa (başka bir kayıt tamamlandıysa) sessizce çıkar.
   * Hata durumunda EventBus yoksa log düşülür; servis durumunu bozmaz.
   */
  private flushAutoSave(fileId: UUID): void {
    const content = this.pendingContent.get(fileId);
    if (content === undefined) return;  // Zaten kaydedildi veya silinmiş

    this.saveFile(fileId, content).then((result) => {
      if (!result.ok) {
        // Auto-save hatası kritik değil; UI "file:dirty" üzerinden takip eder
        // Phase 2'de merkezi logger entegrasyonu buraya eklenir
        console.warn(
          `[FileService] Auto-save başarısız: fileId="${fileId}" code="${result.error.code}" msg="${result.error.message}"`,
        );
      }
    });
  }
}
