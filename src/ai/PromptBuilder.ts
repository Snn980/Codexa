import type { RankedItem } from "./ContextRanker";

export interface BuiltPrompt {
  variant:  "offline" | "cloud";
  system:   string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export class PromptBuilder {
  build(
    items:      RankedItem[],
    userPrompt: string,
    variant:    "offline" | "cloud",
  ): BuiltPrompt {
    const contextParts: string[] = [];

    for (const item of items) {
      if (item.kind === "structure") {
        contextParts.push(`=== PROJECT STRUCTURE ===\n${item.content}`);
      } else if (item.kind === "diagnostic") {
        contextParts.push(`=== DIAGNOSTIC ===\n${item.content}`);
      } else if (item.kind === "symbol") {
        contextParts.push(`=== SYMBOL ===\n${item.content}`);
      } else {
        const label = item.label ?? String(item.fileId ?? "file");
        contextParts.push(`=== FILE: ${label} ===\n${item.content}`);
      }
    }

    const userContent = [
      ...contextParts,
      "=== USER REQUEST ===",
      userPrompt,
    ].join("\n\n");

    const system = variant === "cloud"
      ? "You are an expert coding assistant. Use the provided context to answer precisely."
      : null;

    return {
      variant,
      system,
      messages: [{ role: "user", content: userContent }],
    };
  }
}
