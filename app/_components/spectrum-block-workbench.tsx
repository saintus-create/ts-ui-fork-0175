'use client';

import { useRef, useState } from 'react';
import { AgentPlan } from '@/components/spectrumui/blocks/ai-assistants/agent-plan';
import { AgentSteps } from '@/components/spectrumui/blocks/ai-assistants/agent-steps';
import { ApprovalCard } from '@/components/spectrumui/blocks/ai-assistants/approval-card';
import { CitationSources } from '@/components/spectrumui/blocks/ai-assistants/citation-sources';
import { CodeBlock } from '@/components/spectrumui/blocks/ai-assistants/code-block';
import { ConversationList } from '@/components/spectrumui/blocks/ai-assistants/conversation-list';
import { DiffView } from '@/components/spectrumui/blocks/ai-assistants/diff-view';
import { InlineEdit } from '@/components/spectrumui/blocks/ai-assistants/inline-edit';
import { InsightCards } from '@/components/spectrumui/blocks/ai-assistants/insight-cards';
import { LoadingState } from '@/components/spectrumui/blocks/ai-assistants/loading-state';
import { MemoryChips } from '@/components/spectrumui/blocks/ai-assistants/memory-chips';
import { ModelSelector } from '@/components/spectrumui/blocks/ai-assistants/model-selector';
import { QuotaBanner } from '@/components/spectrumui/blocks/ai-assistants/quota-banner';
import { ReasoningTrace } from '@/components/spectrumui/blocks/ai-assistants/reasoning-trace';
import { StatusTracker } from '@/components/spectrumui/blocks/ai-assistants/status-tracker';
import { TaskRows } from '@/components/spectrumui/blocks/ai-assistants/task-rows';
import { ToolChips } from '@/components/spectrumui/blocks/ai-assistants/tool-chips';
import { UsageMeter } from '@/components/spectrumui/blocks/ai-assistants/usage-meter';
import { VoiceInput } from '@/components/spectrumui/blocks/ai-assistants/voice-input';
import { WebSearch } from '@/components/spectrumui/blocks/ai-assistants/web-search';
import type { Citation, ModelOption, ToolCall } from '@/components/spectrumui/blocks/ai-assistants/types';

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

type Props = {
  onClose: () => void;
  onRunPrompt: (prompt: string) => void;
  question: string;
  answer: string;
  citations: Citation[];
  models: ModelOption[];
  selectedModel: string;
  onModelChange: (id: string) => void;
  busy: boolean;
  questions: Array<{ id: string; title: string; group: string }>;
  onSelectQuestion: (id: string) => void;
  onVoiceText: (text: string) => void;
};

const plan = [
  { id: 'identify', title: 'Identify governing California authority', detail: 'Start with the relevant code, rule, or case.' },
  { id: 'verify', title: 'Verify the source and current text', detail: 'Check the cited authority before relying on it.' },
  { id: 'apply', title: 'Apply the rule to the facts provided', detail: 'Separate the text of the law from analysis.' },
];

const demoDiff = [{
  id: 'answer-revision',
  path: 'answer.md',
  additions: 1,
  deletions: 1,
  lines: [
    { type: 'remove' as const, text: 'The rule always applies.' },
    { type: 'add' as const, text: 'The rule applies when its stated elements are satisfied.' },
  ],
}];

export function SpectrumBlockWorkbench({
  onClose, onRunPrompt, question, answer, citations, models, selectedModel,
  onModelChange, busy, questions, onSelectQuestion, onVoiceText,
}: Props) {
  const [memory, setMemory] = useState<Array<{ id: string; fact: string }>>([]);
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [voiceMessage, setVoiceMessage] = useState('');
  const recognition = useRef<SpeechRecognitionLike | null>(null);

  function startVoice() {
    const speechWindow = window as SpeechWindow;
    const Constructor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Constructor) {
      setVoiceMessage('Voice input is not supported by this browser.');
      return;
    }
    setVoiceMessage('');
    const instance = new Constructor();
    instance.lang = 'en-US';
    instance.interimResults = false;
    instance.maxAlternatives = 1;
    instance.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? '').join(' ').trim();
      if (transcript) onVoiceText(transcript);
    };
    instance.onerror = () => {
      setVoiceMessage('Voice recognition stopped. You can type your question instead.');
      setVoiceState('idle');
    };
    instance.onend = () => setVoiceState('idle');
    recognition.current = instance;
    try {
      instance.start();
      setVoiceState('recording');
    } catch {
      setVoiceMessage('The browser could not start voice recognition.');
      setVoiceState('idle');
    }
  }
  const [approved, setApproved] = useState(false);
  const [diffDecision, setDiffDecision] = useState('');
  const prompt = question || 'California legal research';
  const answerText = answer || 'Ask a question in the chat to populate answer-aware components.';
  const tools: ToolCall[] = [
    { id: 'statutes', name: 'Statute lookup', status: busy ? 'running' : 'pending', result: 'Lookup status is illustrative until the API exposes tool events.' },
    { id: 'sources', name: 'Source verification', status: busy ? 'pending' : 'pending' },
  ];
  const steps = [
    { id: 'request', title: 'Question received', detail: 'The chat has the current user prompt.', status: 'completed' as const },
    { id: 'research', title: 'Research response', detail: 'Response state follows the chat request.', status: busy ? 'running' as const : answer ? 'completed' as const : 'queued' as const },
    { id: 'sources', title: 'Source review', detail: 'Review the returned authorities below.', status: citations.length ? 'completed' as const : 'queued' as const },
  ];
  const usage = {
    promptTokens: Math.ceil(prompt.length / 4),
    completionTokens: Math.ceil(answer.length / 4),
    contextWindow: 128000,
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label="Spectrum chat blocks">
      <button aria-label="Close block workspace" onClick={onClose} className="absolute inset-0 cursor-default" />
      <section className="relative flex h-full w-full max-w-2xl flex-col bg-background text-foreground shadow-2xl">
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <p className="text-sm font-semibold">Spectrum chat blocks</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Composed from the repository components, connected to this session where data is available.</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">Close</button>
        </header>
        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-5">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Session</h3>
            <ConversationList
              conversations={questions.length ? questions : [{ id: 'current', title: 'Current session', group: 'Today' }]}
              activeId={questions[questions.length - 1]?.id ?? 'current'}
              onSelect={onSelectQuestion}
              variant="Compact"
              className="max-w-none border-0 bg-transparent p-0 shadow-none"
            />
            <InsightCards variant="Row" insights={[
              { id: 'questions', label: 'Questions in session', value: String(questions.length) },
              { id: 'sources', label: 'Returned authorities', value: String(citations.length) },
              { id: 'answer', label: 'Current answer', value: answer ? 'Available' : 'Pending' },
            ]} />
            <MemoryChips
              memories={memory}
              title="Session notes"
              variant="Panel"
              onRemove={(id) => setMemory((items) => items.filter((item) => item.id !== id))}
              onAdd={() => setMemory((items) => [...items, { id: String(Date.now()), fact: prompt.slice(0, 90) }])}
              className="max-w-none"
            />
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Model and input</h3>
            <ModelSelector models={models} value={selectedModel} onChange={onModelChange} variant="List" />
            <VoiceInput
              state={voiceState}
              onStart={startVoice}
              onConfirm={() => {
                setVoiceState('processing');
                recognition.current?.stop();
              }}
              onCancel={() => {
                recognition.current?.abort();
                setVoiceState('idle');
                setVoiceMessage('');
              }}
            />
            {voiceMessage && <p role="status" className="text-xs text-muted-foreground">{voiceMessage}</p>}
            <p className="text-xs text-muted-foreground">Voice input uses the browser's speech-recognition support when available.</p>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Research workflow</h3>
            <AgentPlan
              title="Suggested legal research plan"
              steps={plan}
              runLabel="Run research plan"
              onRun={(ids) => onRunPrompt(`Follow this California legal research plan for: ${prompt}\nSelected steps: ${plan.filter((s) => ids.includes(s.id)).map((s) => s.title).join('; ')}\nUse primary authorities and identify anything you cannot verify.`)}
              className="max-w-none"
            />
            <StatusTracker
              stages={[{ id: 'question', label: 'Question' }, { id: 'answer', label: 'Answer' }, { id: 'sources', label: 'Sources' }]}
              activeIndex={busy ? 1 : citations.length ? 3 : answer ? 2 : 0}
              progress={busy ? 0.5 : 0}
              detail={busy ? 'Waiting for the research response.' : citations.length ? `${citations.length} source(s) returned` : 'Source count reflects parsed authorities.'}
            />
            <TaskRows tasks={steps} />
            <AgentSteps steps={tools} variant="Compact" />
            <ToolChips calls={tools} variant="Row" />
            <ReasoningTrace
              steps={[
                { id: 'scope', content: 'Interpret the legal question and identify the jurisdiction.' },
                { id: 'authority', content: 'Review authorities returned by the service.' },
                { id: 'limits', content: 'Distinguish supported conclusions from gaps in the record.' },
              ]}
              status={busy ? 'thinking' : 'complete'}
              defaultOpen={false}
            />
            {busy && <LoadingState label="Waiting for the research service" variant="Dots" />}
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Answer and authorities</h3>
            {citations.length > 0 ? (
              <CitationSources text={answerText} citations={citations} variant="Footnotes" className="max-w-none" />
            ) : (
              <p className="text-sm text-muted-foreground">Authorities appear here when the response includes parsed citations.</p>
            )}
            <WebSearch
              query={prompt}
              results={citations.map((c) => ({ id: c.id, title: c.title, domain: (() => { try { return new URL(c.url).hostname; } catch { return 'source'; } })(), snippet: c.snippet, state: 'read' as const }))}
              className="max-w-none"
            />
            <UsageMeter usage={usage} variant="Inline" />
            <p className="text-xs text-muted-foreground">Token figures are rough character-based estimates, not provider telemetry. Context window shown is a display estimate.</p>
            <QuotaBanner used={questions.length} limit={100} variant="Compact" />
            <p className="text-xs text-muted-foreground">Session counter is a local display cap, not an account or provider quota.</p>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Drafting and review blocks</h3>
            <p className="text-xs text-muted-foreground">The diff below is a component example, not a change proposed to your answer.</p>
            <InlineEdit
              before="A legal conclusion should "
              selection="state the rule without qualification"
              after="."
              suggestion="state the rule and identify its required elements"
              actionLabel="Review wording"
              onAccept={() => onRunPrompt(`Revise the answer to this question with precise legal elements and no unsupported generalizations: ${prompt}`)}
              onReject={() => undefined}
            />
            <DiffView
              diffs={demoDiff}
              onAccept={() => setDiffDecision('Accepted the illustrative wording revision.')}
              onReject={() => setDiffDecision('Rejected the illustrative wording revision.')}
              variant="Default"
            />
            {diffDecision && <p className="text-xs text-muted-foreground">{diffDecision}</p>}
            <CodeBlock
              filename="current-question.json"
              language="json"
              code={JSON.stringify({ question: prompt, model: selectedModel || null, authorityCount: citations.length }, null, 2)}
              variant="Numbered"
            />
            <ApprovalCard
              title="Approve a focused follow-up?"
              description="Send a follow-up asking the assistant to distinguish verified authority from any unsupported portion of the current answer."
              meta="Action: send a follow-up prompt"
              approveLabel="Send follow-up"
              rejectLabel="Not now"
              approvedMessage="Follow-up approved"
              decision={approved ? 'approved' : null}
              onDecide={(decision) => {
                if (decision === 'approved') {
                  setApproved(true);
                  onRunPrompt(`Review the answer to: ${prompt}. Separate verified primary authority from unsupported statements and identify the limits of the available sources.`);
                }
              }}
              className="max-w-none"
            />
          </section>
        </div>
      </section>
    </div>
  );
}

export default SpectrumBlockWorkbench;
