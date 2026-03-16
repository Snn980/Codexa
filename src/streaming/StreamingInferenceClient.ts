// src/streaming/StreamingInferenceClient.ts
// § 17 / § 38 — Streaming inference
//
// Düzeltilen kritik hatalar:
//   FIX-6  AbortSignal.any() Hermes'te yok → manuel anySignal() helper
//   FIX-7  SSE satır sonu \n → /\r?\n/ regex (proxy \r\n gönderebilir)
//   FIX-8  Heartbeat timer reconnect'te leak → clearTimeout her döngüde
//   FIX-9  Backpressure queue → MAX_CHUNK_BUFFER_BYTES aşılınca consumer bekler

import { ok, err, type Result } from '../core/Result';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS       = 30_000;
const HEARTBEAT_TIMEOUT_MS   = 45_000;
const MAX_RECONNECT          = 3;
const RECONNECT_BASE_MS      = 1_000;
/** FIX-9 — backpressure: kuyruk bu bayt limitini aşarsa consumer bekler */
const MAX_CHUNK_BUFFER_BYTES  = 1024 * 1024; // 1 MB

// ─── FIX-6: anySignal — Hermes polyfill ──────────────────────────────────────
// React Native Hermes ortamı (0.73 ve öncesi) AbortSignal.any() desteklemiyor.
// Manuel implementasyon: ilk abort edilen signal diğerlerini de tetikler.

function anySignal(signals: AbortSignal[]): AbortSignal {
  // Zaten abort edilmiş signal varsa hemen döndür
  const already = signals.find((s) => s.aborted);
  if (already) return already;

  // Native destek varsa kullan (Hermes 0.74+, modern Safari, Chrome)
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }

  const controller = new AbortController();

  const onAbort = () => {
    controller.abort();
    // Memory leak önlemi: diğer listener'ları temizle
    for (const s of signals) s.removeEventListener('abort', onAbort);
  };

  for (const s of signals) {
    s.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}

// ─── Tipler ───────────────────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openai';

export interface StreamMessage {
  readonly role:    'user' | 'assistant' | 'system';
  readonly content: string;
}

export interface StreamOptions {
  provider:    Provider;
  apiKey:      string;
  model:       string;
  messages:    readonly StreamMessage[];
  maxTokens?:  number;
  signal:      AbortSignal;
  onChunk:     (chunk: string) => void;
  onComplete?: (fullText: string) => void;
  onError?:    (err: string) => void;
}

// ─── FIX-9: Backpressure chunk queue ─────────────────────────────────────────
// Consumer (onChunk) yavaşsa sınırsız bellek büyümesini önler.
// Kuyruk MAX_CHUNK_BUFFER_BYTES'ı aşarsa async generator yeni chunk üretmeyi
// consumer boşalana kadar erteler.

class ChunkQueue {
  private readonly _chunks: string[] = [];
  private _byteSize     = 0;
  private _waiters:       Array<() => void> = [];
  private _closed        = false;

  enqueue(chunk: string): Promise<void> {
    this._chunks.push(chunk);
    this._byteSize += chunk.length * 2; // UTF-16

    // Bekleyen consumer'ı uyandır
    this._waiters.shift()?.();

    // FIX-9 — buffer doluysa backpressure: producer bekler
    if (this._byteSize > MAX_CHUNK_BUFFER_BYTES) {
      return new Promise<void>((res) => this._waiters.push(res));
    }
    return Promise.resolve();
  }

  async dequeue(): Promise<string | null> {
    if (this._chunks.length > 0) {
      const chunk = this._chunks.shift()!;
      this._byteSize -= chunk.length * 2;
      this._waiters.shift()?.(); // producer'ı serbest bırak
      return chunk;
    }
    if (this._closed) return null;
    // Boş — producer gelene kadar bekle
    await new Promise<void>((res) => this._waiters.push(res));
    return this.dequeue();
  }

  close(): void {
    this._closed = true;
    for (const w of this._waiters) w();
    this._waiters = [];
  }

  get byteSize(): number { return this._byteSize; }
}

// ─── FIX-7: SSE parser — \r\n ve \r destekli ────────────────────────────────

function* parseAnthropicSSE(line: string): Generator<string> {
  if (!line.startsWith('data: ')) return;
  const data = line.slice(6).trim();
  if (!data || data === '[DONE]') return;

  try {
    const event = JSON.parse(data) as Record<string, unknown>;
    const type  = event['type'] as string | undefined;

    if (type === 'content_block_delta') {
      const delta = event['delta'] as Record<string, unknown> | undefined;
      if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        yield delta['text'];
      }
    }
    if (type === 'error') {
      const errorObj = event['error'] as Record<string, unknown> | undefined;
      throw new Error(String(errorObj?.['message'] ?? 'Anthropic API error'));
    }
  } catch (e) {
    if (e instanceof Error) throw e;
  }
}

function* parseOpenAISSE(line: string): Generator<string> {
  if (!line.startsWith('data: ')) return;
  const data = line.slice(6).trim();
  if (data === '[DONE]' || !data) return;

  try {
    const event   = JSON.parse(data) as Record<string, unknown>;
    const choices = event['choices'] as Array<Record<string, unknown>> | undefined;
    const delta   = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
    if (typeof delta?.['content'] === 'string') yield delta['content'];
  } catch { /* bilinmeyen format → atla */ }
}

// ─── SSE fetch + FIX-6/7/8/9 ─────────────────────────────────────────────────

async function* fetchSSEStream(
  url:      string,
  headers:  Record<string, string>,
  body:     string,
  signal:   AbortSignal,
  provider: Provider,
): AsyncGenerator<string> {
  // FIX-6 — anySignal Hermes uyumlu
  const timeoutSignal  = AbortSignal.timeout
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : (() => { const c = new AbortController(); setTimeout(() => c.abort(), FETCH_TIMEOUT_MS); return c.signal; })();

  const combinedSignal = anySignal([signal, timeoutSignal]);

  const response = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body,
    signal:  combinedSignal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const reader  = response.body?.getReader();
  if (!reader)  throw new Error('No response body reader');

  const decoder = new TextDecoder();
  const queue   = new ChunkQueue(); // FIX-9 — backpressure queue
  let   buffer  = '';

  // FIX-8 — timer referansı: reconnect öncesi temizlemek için
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  const resetHeartbeat = () => {
    // FIX-8 — önceki timer'ı her zaman temizle (leak önlemi)
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      reader.cancel('heartbeat timeout').catch(() => {});
    }, HEARTBEAT_TIMEOUT_MS);
  };

  // Reader'ı arka planda oku, queue'ya besle
  const readLoop = async (): Promise<void> => {
    resetHeartbeat();
    try {
      while (true) {
        if (combinedSignal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        resetHeartbeat();

        buffer += decoder.decode(value, { stream: true });

        // FIX-7 — \r\n ve \r da satır sonu olarak işlenir
        const lines = buffer.split(/\r?\n|\r/);
        // Son eleman yarım satır olabilir — buffer'da tut
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const parser = provider === 'anthropic' ? parseAnthropicSSE : parseOpenAISSE;
          for (const chunk of parser(trimmed)) {
            await queue.enqueue(chunk); // FIX-9 — backpressure uygular
          }
        }
      }
    } finally {
      // FIX-8 — finally'de timer garantili temizlik
      if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
      reader.releaseLock();
      queue.close();
    }
  };

  // readLoop'u arkada başlat; consumer generator olarak döner
  const readPromise = readLoop();

  try {
    while (true) {
      const chunk = await queue.dequeue();
      if (chunk === null) break;
      yield chunk;
    }
  } finally {
    await readPromise.catch(() => {});
  }
}

// ─── Request builder'lar ──────────────────────────────────────────────────────

function buildAnthropicRequest(opts: StreamOptions) {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key':         opts.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'messages-2023-12-15',
    },
    body: JSON.stringify({
      model:      opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      stream:     true,
      system:     opts.messages.find((m) => m.role === 'system')?.content,
      messages:   opts.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
    }),
  };
}

function buildOpenAIRequest(opts: StreamOptions) {
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { 'Authorization': `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model:      opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      stream:     true,
      messages:   opts.messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  };
}

// ─── Ana streaming fonksiyonu ─────────────────────────────────────────────────

export async function streamInference(opts: StreamOptions): Promise<Result<string>> {
  const builder = opts.provider === 'anthropic' ? buildAnthropicRequest : buildOpenAIRequest;
  const { url, headers, body } = builder(opts);

  let fullText  = '';
  let attempt   = 0;
  let lastError = '';

  while (attempt <= MAX_RECONNECT) {
    if (opts.signal.aborted) return err('ABORTED', 'Stream aborted by user');

    try {
      for await (const chunk of fetchSSEStream(url, headers, body, opts.signal, opts.provider)) {
        if (opts.signal.aborted) break;
        fullText += chunk;
        opts.onChunk(chunk);
      }
      opts.onComplete?.(fullText);
      return ok(fullText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.signal.aborted || msg.includes('AbortError')) return err('ABORTED', 'Stream aborted');

      lastError = msg;
      attempt++;

      if (attempt <= MAX_RECONNECT) {
        await new Promise<void>((res) => setTimeout(res, RECONNECT_BASE_MS * 2 ** (attempt - 1)));
      }
    }
  }

  opts.onError?.(lastError);
  return err('STREAM_FAILED', lastError);
}

// ─── WebSocket fallback ───────────────────────────────────────────────────────

export async function streamInferenceWS(opts: StreamOptions): Promise<Result<string>> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://api.example.com/ws/stream?provider=${opts.provider}`);
    let fullText = '';

    const cleanup = () => ws.close();
    opts.signal.addEventListener('abort', cleanup, { once: true });

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        if (msg['type'] === 'chunk' && typeof msg['text'] === 'string') {
          fullText += msg['text'];
          opts.onChunk(msg['text']);
        }
        if (msg['type'] === 'done') {
          opts.onComplete?.(fullText);
          cleanup();
          resolve(ok(fullText));
        }
        if (msg['type'] === 'error') {
          const errMsg = String(msg['message'] ?? 'WebSocket error');
          opts.onError?.(errMsg);
          cleanup();
          resolve(err('WS_STREAM_ERROR', errMsg));
        }
      } catch { /* unknown format */ }
    };

    ws.onerror = () => { cleanup(); resolve(err('WS_CONNECTION_ERROR', 'WebSocket connection failed')); };
    ws.onopen  = () => ws.send(JSON.stringify({ provider: opts.provider, model: opts.model, messages: opts.messages }));
  });
}
