// _shared/prices.ts — what each AI model costs (USD per 1 million tokens).
//
// call-llm uses it for the llm_usage receipts and the agent_runs costs; the
// crew uses it to estimate an order's cost before it runs. A model missing
// from this list still works, but its cost is logged as 0, so add a model
// here BEFORE using it.

export type Price = {
  input: number;
  output: number;
  longThreshold?: number; // prompts bigger than this many tokens...
  longInput?: number;     // ...are billed at these higher rates
  longOutput?: number;
};

export const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": {
    input: 0.10,
    output: 0.50,
    longThreshold: 100_000,
    longInput: 0.50,
    longOutput: 2.50,
  },
};

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  const isLong = p.longThreshold !== undefined && promptTokens > p.longThreshold;
  const inRate = isLong && p.longInput !== undefined ? p.longInput : p.input;
  const outRate = isLong && p.longOutput !== undefined ? p.longOutput : p.output;
  return (promptTokens * inRate + completionTokens * outRate) / 1_000_000;
}
