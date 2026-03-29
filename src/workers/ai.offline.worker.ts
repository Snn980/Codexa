/**
 * workers/ai.offline.worker.ts — Offline AI Worker thread entry
 *
 * Expo Go: MLC native modül yok → MockLlamaCppLoader (hata döner → cloud fallback)
 * Native build: MlcLlmLoader kullanılır
 */

import { bootstrapWorker }    from "../ai/AIWorker";
import { OfflineRuntime,
         MockLlamaCppLoader } from "../ai/OfflineRuntime";
import { MlcLlmLoader }       from "../ai/MlcLlmBinding";
import { AIModelId }          from "../ai/AIModels";

declare const self: DedicatedWorkerGlobalScope;

function createRuntime(): OfflineRuntime {
  // Expo Go'da @react-native-ai/mlc mock'lanmış → hata döner → cloud fallback
  // Native build'de EXPO_GO=false env değişkeni set edilir
  const isExpoGo = typeof process !== 'undefined'
    ? process.env.EXPO_GO !== 'false'
    : true;

  if (isExpoGo) {
    // Expo Go: boş token yerine hata fırlat → ParallelExecutor cloud'a escalate eder
    return new OfflineRuntime(new FailingLoader());
  }

  const loader = new MlcLlmLoader(AIModelId.OFFLINE_GEMMA3_1B, { n_ctx: 4096 });
  return new OfflineRuntime(loader);
}

// Expo Go için: offline model yok hatası → cloud fallback tetiklenir
import type { ILlamaCppLoader, ILlamaCppBinding } from "../ai/OfflineRuntime";

class FailingLoader implements ILlamaCppLoader {
  async loadBinding(): Promise<ILlamaCppBinding> {
    return {
      async loadModel() {
        throw new Error('Offline model Expo Go\'da desteklenmiyor. Cloud modeli kullanın.');
      },
      tokenize: (text: string) => text.split(' ').map((_: string, i: number) => i),
      async *nextToken(): AsyncGenerator<string, void, unknown> {
        throw new Error('Offline model yüklü değil.');
      },
      free() {},
    };
  }
}

const runtime = createRuntime();
bootstrapWorker(runtime, self);
