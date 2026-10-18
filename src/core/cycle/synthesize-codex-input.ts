import { resolve, dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { isQuarantined } from '../quarantine.ts';
import { parseMarkdown } from '../markdown.ts';
import { sha256 } from '../persistence/digest.ts';
import { claudeCliSelfSessionIds } from '../ai/providers/claude-cli-scratch.ts';
import { discoverTranscripts, readSingleTranscript, withConversationPages, CONVERSATION_PAGE_URI_PREFIX,
  type DiscoveredTranscript } from './transcript-discovery.ts';
import { buildDreamSummarySlug, type SynthConfig, type SynthesizePhaseOpts } from './synthesize.ts';
import { loadPatternsOutputSlugPrefix } from './patterns.ts';
import type { PublicationEvidence } from './codex-publication-plan.ts';
import { snapshotPublicationFile, type PublicationFileEvidence } from './codex-publication-files.ts';

export interface SynthesisInput { transcript: DiscoveredTranscript; evidence: PublicationEvidence[]; files: PublicationFileEvidence[] }
export async function discoverPrivateSynthesis(engine: BrainEngine, config: SynthConfig, opts: SynthesizePhaseOpts): Promise<DiscoveredTranscript[]> {
  const single = opts.inputFile ? readSingleTranscript(resolve(opts.inputFile), { minChars: config.minChars,
    excludePatterns: config.excludePatterns, bypassGuard: opts.bypassDreamGuard, readContent: path => snapshotPublicationFile(path).content }) : null;
  const corpus = opts.inputFile ? single ? [single] : [] : !config.corpusDir ? [] : discoverTranscripts({
    readContent: path => snapshotPublicationFile(path).content,
    corpusDir: config.corpusDir, meetingTranscriptsDir: config.meetingTranscriptsDir ?? undefined,
    minChars: config.minChars, excludePatterns: config.excludePatterns, date: opts.date, from: opts.from, to: opts.to,
    bypassGuard: opts.bypassDreamGuard, selfCaptureSessionIds: claudeCliSelfSessionIds(),
    excludeDirs: opts.bypassDreamGuard ? [] : [config.reflectionsPrefix, config.originalsPrefix,
      await loadPatternsOutputSlugPrefix(engine, config.outputRoot), dirname(buildDreamSummarySlug(config.outputRoot, 'x'))].map(p => join(opts.brainDir, p)),
  });
  return withConversationPages(engine, opts, config, corpus);
}
/** Filter visibility/quarantine before triage; retain host identities, not model-authored paths. */
export async function snapshotSynthesisInput(engine: BrainEngine, sourceId: string, transcript: DiscoveredTranscript): Promise<SynthesisInput | null> {
  if (transcript.filePath.startsWith(CONVERSATION_PAGE_URI_PREFIX)) {
    const prefix = `${CONVERSATION_PAGE_URI_PREFIX}${sourceId}/`;
    if (!transcript.filePath.startsWith(prefix)) throw new Error('codex_synthesis_source_changed');
    const slug = transcript.filePath.slice(prefix.length), snapshot = await engine.readPageSnapshot(slug, { sourceId, excludePrivate: true });
    if (!snapshot || isQuarantined(snapshot.page.frontmatter) || (snapshot.page.frontmatter?.visibility ?? 'world') !== 'world') return null;
    if (!transcript.pageRevision || snapshot.revision !== transcript.pageRevision || sha256(transcript.content) !== transcript.contentHash)
      throw new Error('codex_synthesis_input_changed');
    return { transcript, evidence: [{ slug, id: snapshot.page.id, revision: snapshot.revision, excerpt: '' }], files: [] };
  }
  const file = snapshotPublicationFile(transcript.filePath), parsed = parseMarkdown(file.content, 'transcript');
  if (isQuarantined(parsed.frontmatter) || (parsed.frontmatter.visibility ?? 'world') !== 'world') return null;
  if (sha256(file.content) !== transcript.contentHash) throw new Error('codex_synthesis_input_changed');
  return { transcript: { ...transcript, filePath: file.evidence.path }, evidence: [], files: [file.evidence] };
}
