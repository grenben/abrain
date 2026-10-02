/** Lazy, statically discoverable construction for subprocess-backed models. */
export function instantiateCliLanguageModel(
  implementation: 'claude-cli' | 'codex-cli',
  modelId: string,
): any {
  if (implementation === 'claude-cli') {
    const { ClaudeCliLanguageModel } = require('./claude-cli-language-model.ts');
    return new ClaudeCliLanguageModel(modelId);
  }
  const { CodexCliLanguageModel } = require('./codex-cli-language-model.ts');
  return new CodexCliLanguageModel(modelId);
}
