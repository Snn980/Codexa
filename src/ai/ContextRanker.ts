import type { ContextItem, EditorSnapshot } from "./ContextCollector";

export interface IImportGraphReader {
  getHopCount(fromFileId: unknown, toFileId: unknown): Promise<number | null>;
}

export interface IRecencyReader {
  getLastEditedAt(fileId: unknown): number;
}

export interface RankedItem extends ContextItem {
  score: number;
}

export class ContextRanker {
  private _importGraph: IImportGraphReader;
  private _recency:     IRecencyReader;

  constructor(deps: { importGraph: IImportGraphReader; recency: IRecencyReader }) {
    this._importGraph = deps.importGraph;
    this._recency     = deps.recency;
  }

  async rank(items: ContextItem[], snapshot: EditorSnapshot): Promise<RankedItem[]> {
    const now = Date.now();
    const ranked: RankedItem[] = [];

    for (const item of items) {
      let score = 0.5;

      // Pinned → yüksek skor
      if (item.pinned) { score += 10; }

      // Active file → bonus
      if (String(item.fileId) === String(snapshot.activeFileId)) { score += 5; }

      // Recency
      if (item.fileId != null) {
        const ts = this._recency.getLastEditedAt(item.fileId);
        const ageSec = (now - ts) / 1000;
        score += Math.max(0, 3 - ageSec / 60);
      }

      // Import graph hop count
      if (item.fileId != null && item.fileId !== snapshot.activeFileId) {
        const hops = await this._importGraph.getHopCount(snapshot.activeFileId, item.fileId);
        if (hops !== null) score += Math.max(0, 2 - hops);
      }

      ranked.push({ ...item, score });
    }

    return ranked.sort((a, b) => b.score - a.score);
  }
}
