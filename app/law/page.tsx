"use client";

import { useCallback, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { ChatEmptyState } from "@/components/spectrumui/blocks/ai-assistants/chat-empty-state";
import { PromptComposer } from "@/components/spectrumui/blocks/ai-assistants/prompt-composer";
import { StreamingText } from "@/components/spectrumui/blocks/ai-assistants/streaming-text";
import { ThinkingDots } from "@/components/spectrumui/blocks/ai-assistants/thinking-dots";
import { ErrorState } from "@/components/spectrumui/blocks/ai-assistants/error-state";
import { MessageActions } from "@/components/spectrumui/blocks/ai-assistants/message-actions";
import type { Attachment, Citation, ModelOption, SuggestedPrompt } from "@/components/spectrumui/blocks/ai-assistants/types";
import { SuggestionBanner } from "@/components/spectrumui/blocks/ai-assistants/suggestion-banner";
import SpectrumBlockWorkbench from "@/app/_components/spectrum-block-workbench";

const modelOptions: ModelOption[] = [{ id: "sarvam-105b-conversations", name: "California law research" }];
type AttachedDocument = { name: string; content: string };
type Turn = { id: string; role: "user" | "assistant"; text: string; streaming?: boolean; citations?: Citation[]; documents?: AttachedDocument[] };
const prompts: SuggestedPrompt[] = [
  { id: "p1", label: "Explain a California statute", prompt: "Explain this California statute in plain English and identify each operative requirement." },
  { id: "p2", label: "Understand a court form", prompt: "How does a California Judicial Council form work, and what rules govern its use?" },
  { id: "p3", label: "Compare statutes and cases", prompt: "Find the California statutes and published appellate decisions governing a procedural due-process issue." },
  { id: "p4", label: "Trace a legal definition", prompt: "Find the statutory definition of a legal term and follow every cross-reference needed to understand it." },
];

function splitAnswer(raw: string) {
  const authAt = raw.search(/\n\s*AUTHORITIES:/i);
  const followAt = raw.search(/\n\s*FOLLOWUPS:/i);
  const cut = Math.min(authAt < 0 ? raw.length : authAt, followAt < 0 ? raw.length : followAt);
  const body = raw.slice(0, cut).trim();
  const authorities: Citation[] = [];
  if (authAt >= 0) {
    const rest = raw.slice(authAt);
    const end = followAt > authAt ? followAt - authAt : rest.length;
    for (const line of rest.slice(0, end).split("\n")) {
      const match = line.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
      if (!match) continue;
      const id = match[1].trim().split(/\s+/)[0];
      const label = match[1].trim().slice(id.length).trim() || match[2].trim();
      const link = match[2].match(/\(#law-authority:([^)]+)\)/);
      const rawUrl = link?.[1] || "";
      let url = "/";
      try { url = new URL(rawUrl, window.location.origin).href; } catch {}
      authorities.push({ id, index: authorities.length + 1, title: label || id, url });
    }
  }
  const byMarker = new Map(authorities.map((c) => [c.id.toLowerCase(), c.index]));
  const normalized = body.replace(/\[([a-z]{1,2}\d{1,3})\]/gi, (whole, marker: string) => {
    const index = byMarker.get(marker.toLowerCase());
    return index ? `[${index}]` : whole;
  });
  return { body: normalized, authorities };
}

export default function LawResearchPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryText, setRetryText] = useState("");
  const [attachments, setAttachments] = useState<Array<Attachment & { content: string }>>([]);
  const [fileError, setFileError] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState("sarvam-105b-conversations");
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (input: string) => {
    const question = input.trim();
    if (!question || busy) return;
    setError("");
    setRetryText(question);
    const attachedNow = attachments.map(({ name, content }) => ({ name, content }));
    const userTurn: Turn = { id: `u-${Date.now()}`, role: "user", text: question, documents: attachedNow };
    const assistantId = `a-${Date.now()}`;
    const allDocuments = [...turns.flatMap((turn) => turn.documents || []), ...attachedNow];
    const uniqueDocuments = [...new Map(allDocuments.map((doc) => [`${doc.name}\u0000${doc.content}`, doc])).values()];
    const history = [...turns, userTurn].map((turn) => ({
      id: turn.id,
      role: turn.role,
      parts: [{ type: "text" as const, text: turn.text }],
    }));
    setTurns((previous) => [...previous, userTurn, { id: assistantId, role: "assistant", text: "", streaming: true }]);
    setAttachments([]);
    setFileError("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history, documents: uniqueDocuments, model: selectedModel }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail || `Research request failed (${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const event = JSON.parse(payload);
            if (event.type === "text-delta" && event.delta) {
              accumulated += event.delta;
              setTurns((previous) => previous.map((turn) => turn.id === assistantId ? { ...turn, text: accumulated } : turn));
            }
          } catch { /* Ignore stream metadata that is not a text event. */ }
        }
      }
      const parsed = splitAnswer(accumulated);
      setTurns((previous) => previous.map((turn) => turn.id === assistantId ? { ...turn, text: parsed.body, citations: parsed.authorities, streaming: false } : turn));
      if (!accumulated.trim()) throw new Error("The research service returned an empty answer.");
    } catch (cause) {
      setTurns((previous) => previous.filter((turn) => turn.id !== assistantId));
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "The research service could not complete the request.");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
    }
  }, [busy, turns, attachments, selectedModel]);

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selected.length) return;
    const allowed = /\.(txt|md|csv|json|html?|xml)$/i;
    const additions: Array<Attachment & { content: string }> = [];
    for (const file of selected) {
      if (!allowed.test(file.name)) {
        setFileError(`${file.name}: use a text, Markdown, CSV, JSON, HTML, or XML file. PDF and Word files are not extracted by this upload control.`);
        continue;
      }
      if (file.size > 100_000) {
        setFileError(`${file.name}: maximum size is 100 KB per file.`);
        continue;
      }
      try {
        additions.push({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, size: file.size, type: file.type || "text/plain", content: await file.text() });
      } catch {
        setFileError(`Could not read ${file.name}.`);
      }
    }
    setAttachments((previous) => {
      const merged = [...previous, ...additions];
      if (merged.length > 5) { setFileError("Attach no more than five documents at once."); return merged.slice(0, 5); }
      return merged;
    });
  };

  const latestQuestion = [...turns].reverse().find((turn) => turn.role === "user")?.text || "";
  const latestAnswer = [...turns].reverse().find((turn) => turn.role === "assistant");

  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center border-b border-border/60 px-5 sm:px-8">
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">Spectrum UI</Link>
        <span className="mx-3 text-muted-foreground">/</span>
        <h1 className="text-sm font-semibold">California Law Research</h1>
        <button type="button" onClick={() => setWorkspaceOpen(true)} className="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-muted">Workspace</button>
        <span className="ml-3 hidden text-xs text-muted-foreground md:inline">Statutes · Bills · Cases · Rules · Forms</span>
      </header>
      <section ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-8 sm:px-8">
          {turns.length === 0 ? (
            <div className="flex flex-1 items-center">
              <ChatEmptyState
                title="What do you need to understand?"
                subtitle="Ask a California-law question. Answers are grounded in retrieved legal sources and include authorities when available."
                prompts={prompts}
                onSelectPrompt={(prompt) => void send(prompt.prompt)}
                variant="Centered"
              />
            </div>
          ) : (
            <div className="space-y-8">
              {turns.map((turn) => (
                <article key={turn.id} className={turn.role === "user" ? "ml-auto max-w-[88%]" : "mr-auto w-full max-w-3xl"}>
                  {turn.role === "user" ? (
                    <div className="rounded-2xl bg-muted px-4 py-3 text-sm leading-6 whitespace-pre-wrap">
                      {turn.text}
                      {turn.documents?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{turn.documents.map((doc) => <span key={`${doc.name}-${doc.content.length}`} className="rounded-md bg-background/70 px-2 py-1 text-xs text-muted-foreground">Document: {doc.name}</span>)}</div> : null}
                    </div>
                  ) : (
                    <div>
                      {turn.text ? <StreamingText text={turn.text} streaming={turn.streaming} citations={turn.citations || []} /> : turn.streaming ? <ThinkingDots label="Researching California law" /> : null}
                      {!turn.streaming && turn.text ? (
                        <div className="mt-3 space-y-3">
                          <MessageActions content={turn.text} onCopy={(text) => void navigator.clipboard?.writeText(text)} />
                          <SuggestionBanner suggestion="Map every conclusion to primary authority" detail="Ask for an element-by-element explanation with each claim tied to a verified source." applyLabel="Trace the authorities" onApply={() => void send("Map every conclusion in your last answer to the exact primary authority that supports it. Separate verified text, interpretation, and unresolved gaps.")} />
                        </div>
                      ) : null}
                    </div>
                  )}
                </article>
              ))}
              {busy ? <div className="py-2"><ThinkingDots label="Searching statutes, cases, bills, rules, and forms" /></div> : null}
              {error ? <ErrorState title="Research request failed" message={error} onRetry={() => void send(retryText)} variant="Inline" /> : null}
            </div>
          )}
        </div>
      </section>
      <footer className="shrink-0 border-t border-border/60 px-4 py-4 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <input ref={fileInput} type="file" multiple accept=".txt,.md,.csv,.json,.html,.htm,.xml" onChange={handleFiles} className="hidden" aria-label="Attach text documents" />
          {fileError ? <p role="status" className="mb-2 text-sm text-destructive">{fileError}</p> : null}
          <PromptComposer
            placeholder="Ask a question about California law..."
            onSend={(text) => void send(text)}
            isGenerating={busy}
            attachments={attachments}
            onRemoveAttachment={(id) => setAttachments((previous) => previous.filter((file) => file.id !== id))}
            onAttach={() => fileInput.current?.click()}
            onStop={() => abortRef.current?.abort()}
            variant="Default"
          />
          <p className="mt-2 text-center text-[11px] text-muted-foreground">Check cited source text and current status before relying on a legal conclusion.</p>
        </div>
      </footer>
      {workspaceOpen ? (
        <SpectrumBlockWorkbench
          onClose={() => setWorkspaceOpen(false)}
          onRunPrompt={(prompt) => void send(prompt)}
          question={latestQuestion}
          answer={latestAnswer?.text || ""}
          citations={latestAnswer?.citations || []}
          models={modelOptions}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          busy={busy}
          questions={turns.filter((turn) => turn.role === "user").map((turn) => ({ id: turn.id, title: turn.text.slice(0, 90), group: "Conversation" }))}
          onSelectQuestion={(id) => { const turn = turns.find((item) => item.id === id && item.role === "user"); if (turn) void send(turn.text); }}
          onVoiceText={(text) => void send(text)}
        />
      ) : null}
    </main>
  );
}
