/**
 * @file     core.ts
 * @module   types
 * @version  0.5.0
 * @since    Phase 1 — Foundation
 *
 * @description
 *   Mobile AI IDE — merkezi tip ve kontrat sistemi.
 *
 * ── v0.5.0 değişiklikleri (Phase 3) ─────────────────────────────────────────
 *  [5] ErrorCode — Phase 3 dil/LSP/graph hataları eklendi
 *      (PARSE_ERROR, INDEX_FAILED, LSP_INIT_FAILED, GRAPH_CYCLE,
 *       GRAPH_CORRUPT, STORAGE_INIT, SYMBOL_NOT_FOUND, DEP_RESOLVE_FAILED)
 *  [6] AppEventMap — language, index, graph, lsp event'leri eklendi
 *  [7] Position, Diagnostic, DiagnosticSeverity — LSP uyumlu tipler eklendi
 *
 * ── v0.4.0 değişiklikleri ────────────────────────────────────────────────────
 *  [1] ErrorCode.OPTIMISTIC_LOCK_CONFLICT  — repository'lerin optimistic lock hatası
 *  [2] ErrorCode.SQLITE_CONSTRAINT         — DB unique/FK kısıt ihlali (atomic duplicate guard)
 *  [3] IProject.version                    — optimistic lock sayacı (ProjectRepository)
 *  [4] IFile.version                       — optimistic lock sayacı (FileRepository)
 *      IProjectWithVersion / IFileWithVersion local arayüzleri artık gerekmiyor;
 *      repository'ler IProject / IFile döndürebilir.
 */

// ─────────────────────────────────────────────────────────────────────────────
// § 0. Tip Yardımcıları
// ─────────────────────────────────────────────────────────────────────────────

export type Values<T extends Record<string, string>> = T[keyof T];

export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

export type RequireFields<T, K extends keyof T> =
  Required<Pick<T, K>> & Partial<Omit<T, K>>;

export type UUID      = string & { readonly _brand: "UUID" };
export type Timestamp = number;
export type MetaRecord = Record<string, string | number | boolean | null>;

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Hata Sistemi
// ─────────────────────────────────────────────────────────────────────────────

export const ErrorCode = {
  // Storage
  DB_CONNECTION_FAILED:      "DB_CONNECTION_FAILED",
  DB_QUERY_FAILED:           "DB_QUERY_FAILED",
  DB_MIGRATION_FAILED:       "DB_MIGRATION_FAILED",
  RECORD_NOT_FOUND:          "RECORD_NOT_FOUND",
  DUPLICATE_RECORD:          "DUPLICATE_RECORD",
  /** ← [2] SQLite unique/FK kısıt ihlali — atomic duplicate guard için */
  SQLITE_CONSTRAINT:         "SQLITE_CONSTRAINT",
  /** ← [1] Optimistic lock çakışması — çağıran yeniden çekip tekrar dener */
  OPTIMISTIC_LOCK_CONFLICT:  "OPTIMISTIC_LOCK_CONFLICT",

  // Dosya Sistemi
  FILE_READ_ERROR:           "FILE_READ_ERROR",
  FILE_WRITE_ERROR:          "FILE_WRITE_ERROR",
  FILE_NOT_FOUND:            "FILE_NOT_FOUND",
  PATH_INVALID:              "PATH_INVALID",

  // Proje
  PROJECT_LIMIT_EXCEEDED:    "PROJECT_LIMIT_EXCEEDED",
  PROJECT_CORRUPT:           "PROJECT_CORRUPT",
  PROJECT_NOT_FOUND:         "PROJECT_NOT_FOUND",

  // Validasyon
  VALIDATION_ERROR:          "VALIDATION_ERROR",
  INVALID_DTO:               "INVALID_DTO",

  // Runtime  (Phase 2)
  EXECUTION_TIMEOUT:         "EXECUTION_TIMEOUT",
  MEMORY_LIMIT_EXCEEDED:     "MEMORY_LIMIT_EXCEEDED",
  SANDBOX_INIT_FAILED:       "SANDBOX_INIT_FAILED",

  // AI  (Phase 4)
  AI_MODEL_NOT_LOADED:       "AI_MODEL_NOT_LOADED",
  AI_REQUEST_FAILED:         "AI_REQUEST_FAILED",
  AI_PERMISSION_DENIED:      "AI_PERMISSION_DENIED",
  AI_RATE_LIMIT_EXCEEDED:    "AI_RATE_LIMIT_EXCEEDED",

  // Genel
  NOT_IMPLEMENTED:           "NOT_IMPLEMENTED",
  UNKNOWN:                   "UNKNOWN",

  // Language / LSP / Graph  (Phase 3)
  /** ← [5] Kaynak dosya parse hatası (tree-sitter / tsc) */
  PARSE_ERROR:               "PARSE_ERROR",
  /** ← [5] Sembol indeksleme başarısız */
  INDEX_FAILED:              "INDEX_FAILED",
  /** ← [5] LSP sunucusu başlatılamadı */
  LSP_INIT_FAILED:           "LSP_INIT_FAILED",
  /** ← [5] Bağımlılık grafiğinde döngüsel bağımlılık */
  GRAPH_CYCLE:               "GRAPH_CYCLE",
  /** ← [5] Depolama tutarsızlığı — grafik bütünlüğü bozuk */
  GRAPH_CORRUPT:             "GRAPH_CORRUPT",
  /** ← [5] LevelDB / SQLite başlatma hatası */
  STORAGE_INIT:              "STORAGE_INIT",
  /** ← [5] İstenen sembol indekste bulunamadı */
  SYMBOL_NOT_FOUND:          "SYMBOL_NOT_FOUND",
  /** ← [5] Bağımlılık çözümleme başarısız */
  DEP_RESOLVE_FAILED:        "DEP_RESOLVE_FAILED",
} as const;

export type ErrorCode = Values<typeof ErrorCode>;

export interface AppError {
  readonly code:      ErrorCode;
  readonly message:   string;
  readonly context?:  MetaRecord;
  readonly cause?:    unknown;
  readonly timestamp: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Result<T> Monad
// ─────────────────────────────────────────────────────────────────────────────

export type Result<T, E extends AppError = AppError> =
  | { readonly ok: true;  readonly data:  T }
  | { readonly ok: false; readonly error: E };

export type AsyncResult<T, E extends AppError = AppError> =
  Promise<Result<T, E>>;

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Proje Modeli
// ─────────────────────────────────────────────────────────────────────────────

export const ProjectLanguage = {
  JavaScript: "javascript",
  TypeScript: "typescript",
  JSX:        "jsx",
  TSX:        "tsx",
} as const;
export type ProjectLanguage = Values<typeof ProjectLanguage>;

export const ProjectStatus = {
  Empty:     "empty",
  Active:    "active",
  Archived:  "archived",
  PendingGC: "pending_gc",
} as const;
export type ProjectStatus = Values<typeof ProjectStatus>;

export const PROJECT_STATUS_TRANSITIONS: Readonly<
  Record<ProjectStatus, ReadonlyArray<ProjectStatus>>
> = Object.freeze({
  [ProjectStatus.Empty]:     [ProjectStatus.Active],
  [ProjectStatus.Active]:    [ProjectStatus.Archived, ProjectStatus.PendingGC],
  [ProjectStatus.Archived]:  [ProjectStatus.Active,   ProjectStatus.PendingGC],
  [ProjectStatus.PendingGC]: [],
});

export interface ProjectMeta extends MetaRecord {
  entryFile?:      string;
  totalFiles?:     number;
  lastOpenedFile?: string;
  accentColor?:    string;
}

/**
 * ← [3] version alanı eklendi.
 * Optimistic lock sayacı — repository katmanında yönetilir,
 * UI katmanına opak sayı olarak iletilir.
 */
export type IProject = DeepReadonly<{
  id:          UUID;
  name:        string;
  description: string;
  language:    ProjectLanguage;
  status:      ProjectStatus;
  version:     number;          // ← [3]
  createdAt:   Timestamp;
  updatedAt:   Timestamp;
  meta:        ProjectMeta;
}>;

export const PROJECT_CONSTRAINTS = Object.freeze({
  NAME_MIN: 1,
  NAME_MAX: 80,
  DESC_MAX: 300,
});

export type CreateProjectDto = RequireFields<
  Pick<IProject, "name" | "language" | "description" | "meta">,
  "name" | "language"
>;

export type UpdateProjectDto = Partial<
  Pick<IProject, "name" | "description" | "status" | "meta">
>;

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Dosya Modeli
// ─────────────────────────────────────────────────────────────────────────────

export const FileType = {
  JavaScript: "javascript",
  TypeScript: "typescript",
  JSX:        "jsx",
  TSX:        "tsx",
  JSON:       "json",
  Markdown:   "md",
  CSS:        "css",
  HTML:       "html",
  PlainText:  "txt",
  Unknown:    "unknown",
} as const;
export type FileType = Values<typeof FileType>;

export const FILE_EXTENSION_MAP: Readonly<Record<string, FileType>> =
  Object.freeze({
    js:   FileType.JavaScript,
    ts:   FileType.TypeScript,
    jsx:  FileType.JSX,
    tsx:  FileType.TSX,
    json: FileType.JSON,
    md:   FileType.Markdown,
    css:  FileType.CSS,
    html: FileType.HTML,
    txt:  FileType.PlainText,
  });

/**
 * ← [4] version alanı eklendi.
 */
export type IFile = DeepReadonly<{
  id:        UUID;
  projectId: UUID;
  path:      string;
  name:      string;
  type:      FileType;
  content:   string;
  checksum:  string;
  size:      number;
  version:   number;    // ← [4]
  createdAt: Timestamp;
  updatedAt: Timestamp;
  isDirty:   boolean;
}>;

export const FILE_CONSTRAINTS = Object.freeze({
  MAX_SIZE_BYTES:  5 * 1024 * 1024,
  MAX_PATH_LENGTH: 512,
  MAX_NAME_LENGTH: 128,
});

export type CreateFileDto = RequireFields<
  Pick<IFile, "projectId" | "path" | "name" | "content" | "type">,
  "projectId" | "path" | "name" | "content"
>;

export type UpdateFileDto = Partial<Pick<IFile, "content" | "path" | "name">>;

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Ayarlar Modeli
// ─────────────────────────────────────────────────────────────────────────────

export const EditorTheme = {
  Dark:         "dark",
  Light:        "light",
  HighContrast: "high-contrast",
} as const;
export type EditorTheme = Values<typeof EditorTheme>;

export const KeyboardLayout = {
  Default: "default",
  Vim:     "vim",
} as const;
export type KeyboardLayout = Values<typeof KeyboardLayout>;

export type ISettings = DeepReadonly<{
  fontSize:         number;
  lineHeight:       number;
  tabSize:          number;
  insertSpaces:     boolean;
  wordWrap:         boolean;
  showLineNumbers:  boolean;
  showMinimap:      boolean;
  theme:            EditorTheme;
  keyboardLayout:   KeyboardLayout;
  autoSaveInterval: number;
  maxTabs:          number;
  /** § 68 — Terminal otomatik çalıştırma; file:saved → terminal:run */
  autoRun:          boolean;
}>;

export const DEFAULT_SETTINGS: ISettings = Object.freeze({
  fontSize:         14,
  lineHeight:       1.5,
  tabSize:          2,
  insertSpaces:     true,
  wordWrap:         true,
  showLineNumbers:  true,
  showMinimap:      false,
  theme:            EditorTheme.Dark,
  keyboardLayout:   KeyboardLayout.Default,
  autoSaveInterval: 3_000,
  maxTabs:          8,
  autoRun:          false, // § 68
});

// ─────────────────────────────────────────────────────────────────────────────
// § 6. AI Sistemi & Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

export const AIProvider = {
  Offline:   "offline",
  Anthropic: "anthropic",
  OpenAI:    "openai",
  Custom:    "custom",
} as const;
export type AIProvider = Values<typeof AIProvider>;

export const AIPermissionState = {
  Disabled:     "disabled",
  LocalOnly:    "local_only",
  CloudEnabled: "cloud_enabled",
} as const;
export type AIPermissionState = Values<typeof AIPermissionState>;

export interface AIRateLimitPolicy {
  readonly maxCallsPerMinute: number;
  readonly windowMs:          number;
  remainingCalls():    number;
  nextAvailableAt():   Timestamp;
}

export const DEFAULT_AI_RATE_LIMIT = Object.freeze({
  maxCallsPerMinute: 6,
  windowMs:          60_000,
} as const);

export type IAISession = DeepReadonly<{
  id:          UUID;
  provider:    AIProvider;
  messages:    AIMessage[];
  totalTokens: number;
  createdAt:   Timestamp;
  updatedAt:   Timestamp;
}>;

export type AIMessage = DeepReadonly<{
  role:      "user" | "assistant" | "system";
  content:   string;
  timestamp: Timestamp;
  tokens?:   number;
}>;

// ─────────────────────────────────────────────────────────────────────────────
// § 7. Repository Kontratları
// ─────────────────────────────────────────────────────────────────────────────

export interface IRepository<T, C, U> {
  findById(id: UUID):        AsyncResult<T>;
  findAll():                 AsyncResult<T[]>;
  create(dto: C):            AsyncResult<T>;
  update(id: UUID, dto: U):  AsyncResult<T>;
  delete(id: UUID):          AsyncResult<void>;
}

export interface IProjectRepository
  extends IRepository<IProject, CreateProjectDto, UpdateProjectDto> {
  findByStatus(status: ProjectStatus):        AsyncResult<IProject[]>;
  findRecent(limit: number):                  AsyncResult<IProject[]>;
  exists(id: UUID):                           AsyncResult<boolean>;
}

export interface IFileRepository
  extends IRepository<IFile, CreateFileDto, UpdateFileDto> {
  findByProject(projectId: UUID):             AsyncResult<IFile[]>;
  findByPath(projectId: UUID, path: string):  AsyncResult<IFile>;
  updateContent(id: UUID, content: string):   AsyncResult<IFile>;
  markDirty(id: UUID, dirty: boolean):        AsyncResult<void>;
  countByProject(projectId: UUID):            AsyncResult<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 8. Olay Sistemi
// ─────────────────────────────────────────────────────────────────────────────

export interface AppEventMap {
  "project:created":         { project: IProject };
  "project:updated":         { project: IProject };
  "project:deleted":         { projectId: UUID };
  "project:opened":          { project: IProject };
  "project:status:changed":  { projectId: UUID; from: ProjectStatus; to: ProjectStatus };
  "file:created":            { file: IFile };
  "file:updated":            { file: IFile };
  "file:deleted":            { fileId: UUID };
  "file:saved":              { file: IFile };
  "file:dirty":              { fileId: UUID; isDirty: boolean };
  "editor:tab:opened":       { file: IFile };
  "editor:tab:closed":       { fileId: UUID };
  "editor:tab:focused":      { fileId: UUID };
  "editor:content:changed":  { fileId: UUID; content: string; cursor: CursorPosition };
  "settings:changed":        { prev: ISettings; next: ISettings };
  "runtime:started":         { executionId: UUID };
  "runtime:finished":        { executionId: UUID; durationMs: number };
  "runtime:error":           { executionId: UUID; error: AppError };
  "runtime:output":          { executionId: UUID; line: string; stream: "stdout" | "stderr" };
  "ai:request:started":      { requestId: UUID; provider: AIProvider };
  "ai:request:completed":    { requestId: UUID; tokens: number };
  "ai:rate:limited":         { provider: AIProvider; nextAvailableAt: Timestamp };

  // Language service lifecycle  (Phase 3) ← [6]
  "language:ready":          { languages: string[] };
  "language:parsed":         { fileId: UUID; symbols: number; durationMs: number };
  "language:error":          { fileId: UUID; error: AppError };

  // Symbol indexing  (Phase 3) ← [6]
  "index:started":           { fileId: UUID };
  "index:finished":          { fileId: UUID; durationMs: number; symbolCount: number };
  "index:error":             { fileId: UUID; error: AppError };
  "index:invalidated":       { fileId: UUID; reason: "edit" | "delete" | "rename" };

  // Dependency graph  (Phase 3) ← [6]
  "graph:edge:added":        { from: UUID; to: UUID };
  "graph:edge:removed":      { from: UUID; to: UUID };
  "graph:cycle:detected":    { cycle: UUID[] };

  // LSP diagnostics  (Phase 3) ← [6]
  "lsp:diagnostic":          { fileId: UUID; diagnostics: Diagnostic[] };
  "lsp:ready":               { fileId: UUID };

  // App lifecycle  (App.tsx)
  "app:foreground":          Record<string, never>;
  "app:background":          Record<string, never>;
  "nav:error":               { error: string };
}

export type EventListener<K extends keyof AppEventMap> =
  (payload: AppEventMap[K]) => void | Promise<void>;

export interface IEventBus {
  emit<K extends keyof AppEventMap>(event: K, payload: AppEventMap[K]): void;
  on<K extends keyof AppEventMap>(event: K, listener: EventListener<K>): () => void;
  off<K extends keyof AppEventMap>(event: K, listener: EventListener<K>): void;
  once<K extends keyof AppEventMap>(event: K, listener: EventListener<K>): void;
  onError(handler: (event: string, error: unknown) => void): void;
  removeAllListeners(event?: keyof AppEventMap): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 9. Editör Modeli
// ─────────────────────────────────────────────────────────────────────────────

export type CursorPosition = DeepReadonly<{
  line:   number;
  column: number;
}>;

export type ITab = DeepReadonly<{
  id:              UUID;
  fileId:          UUID;
  title:           string;
  isActive:        boolean;
  isDirty:         boolean;
  openedAt:        Timestamp;
  cursorPosition?: CursorPosition;
  scrollTop?:      number;
}>;

// ─────────────────────────────────────────────────────────────────────────────
// § 10. Validasyon Kontratları
// ─────────────────────────────────────────────────────────────────────────────

export interface IValidator<T> {
  validate(input: unknown): ValidationResult<T>;
}

export type ValidationResult<T> =
  | { readonly valid: true;  readonly data:   T }
  | { readonly valid: false; readonly errors: ValidationError[] };

export interface ValidationError {
  readonly field:   string;
  readonly message: string;
  readonly value?:  unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 11. LSP Tipleri  (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

/** LSP protokolüyle uyumlu satır/karakter konumu (0-indexed). ← [7] */
export interface Position {
  readonly line:      number;   // 0-indexed
  readonly character: number;   // 0-indexed
}

/** LSP DiagnosticSeverity sabitleri. ← [7] */
export const DiagnosticSeverity = {
  Error:       1,
  Warning:     2,
  Information: 3,
  Hint:        4,
} as const;
export type DiagnosticSeverity = Values<typeof DiagnosticSeverity>;

/**
 * LSP uyumlu tanılama (hata/uyarı) kaydı. ← [7]
 * `source` alanı hangi aracın ürettiğini belirtir: "eslint" | "tsc" | "tree-sitter"
 */
export interface Diagnostic {
  readonly range:    { start: Position; end: Position };
  readonly severity: DiagnosticSeverity;
  readonly message:  string;
  readonly source?:  string;
  readonly code?:    string | number;
}
// ───────────────────────────────────────────────────────────
