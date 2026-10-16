'use client';

import { useRef, useState } from 'react';
import { CitationSources } from '@/components/spectrumui/blocks/ai-assistants/citation-sources';
import { ConversationList } from '@/components/spectrumui/blocks/ai-assistants/conversation-list';
import { ModelSelector } from '@/components/spectrumui/blocks/ai-assistants/model-selector';
import { VoiceInput } from '@/components/spectrumui/blocks/ai-assistants/voice-input';
import type { Citation, ModelOption } from '@/components/spectrumui/blocks/ai-assistants/types';

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

export function SpectrumBlockWorkbench({
  onClose, question, answer, citations, models, selectedModel,
  onModelChange, busy, questions, onSelectQuestion, onVoiceText,
}: Props) {
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

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label="Research workspace">
      <button aria-label="Close workspace" onClick={onClose} className="absolute inset-0 cursor-default" />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-background text-foreground shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Research workspace</h2>
            <p className="mt-1 text-xs text-muted-foreground">Your session, model, and cited sources</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm hover:bg-muted">Close</button>
        </header>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Conversation</h3>
            {questions.length ? (
              <ConversationList
                conversations={questions}
                activeId={questions[questions.length - 1]?.id}
                onSelect={onSelectQuestion}
                variant="Compact"
                className="max-w-none border-0 bg-transparent p-0 shadow-none"
              />
            ) : (
              <p className="text-sm text-muted-foreground">Your questions will appear here.</p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Model</h3>
            <ModelSelector models={models} value={selectedModel} onChange={onModelChange} variant="List" />
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Voice input</h3>
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
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Answer sources</h3>
            {citations.length && answer ? (
              <CitationSources text={answer} citations={citations} variant="Footnotes" className="max-w-none" />
            ) : (
              <p className="text-sm text-muted-foreground">Citations from the current answer will appear here.</p>
            )}
          </section>
          {busy && <p className="text-sm text-muted-foreground" role="status">Research is in progress…</p>}
          {question && <p className="text-xs text-muted-foreground">Current question: {question}</p>}
        </div>
      </aside>
    </div>
  );
}

export default SpectrumBlockWorkbench;
