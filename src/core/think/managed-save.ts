import type { BrainEngine } from '../engine.ts';
import { maintenancePreflight, publishMaintenancePage } from '../persistence/prepared-maintenance.ts';
import { serializeMarkdown } from '../markdown.ts';
import type { DerivationDeclaration } from '../trust/taint.ts';
/** API-mode saves also respect the managed canonical owner. Private Codex uses
 * its stronger retained plan, evidence checks and atomic citation publication. */
export async function saveManagedThink(engine: BrainEngine, slug: string, input: Parameters<BrainEngine['putPage']>[1], sourceId = 'default', derivation?: DerivationDeclaration) {
    const authority = await maintenancePreflight(engine, sourceId);
    if (!authority)
        return null;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    const content = serializeMarkdown(input.frontmatter ?? {}, input.compiled_truth ?? '', input.timeline ?? '', { type: input.type ?? 'synthesis', title: input.title ?? slug, tags: input.tags ?? [] });
    await publishMaintenancePage(engine, authority, slug, content, { expectedRevision: snapshot?.revision ?? null, derivation });
    const page = await engine.getPage(slug, { sourceId });
    if (!page)
        throw new Error('Managed think publication lost its committed page.');
    return page;
}
