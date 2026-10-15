'use client';

import { cn } from '@/lib/utils';
import type { SuggestedPrompt } from './types';
import { StarMark } from '@/app/_components/star-mark';

const KEYFRAMES = `
@keyframes su-msg-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
`;

export type ChatEmptyStateVariant = 'Default' | 'Centered';

export interface ChatEmptyStateProps {
  title?: string;
  subtitle?: string;
  prompts?: SuggestedPrompt[];
  onSelectPrompt?: (prompt: SuggestedPrompt) => void;
  variant?: ChatEmptyStateVariant;
  className?: string;
}

export function ChatEmptyState({
  title = 'What do you want to know?',
  subtitle = 'Ask a question, or start from one of these.',
  prompts = [],
  onSelectPrompt,
  variant = 'Default',
  className,
}: ChatEmptyStateProps) {
  const centered = variant === 'Centered';

  return (
    <div
      className={cn(
        'w-full max-w-[680px]',
        centered && 'flex flex-col items-center text-center',
        className,
      )}
    >
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400">
        <StarMark className="size-3" />
        <span>California Legislative Information</span>
      </div>

      <h3 className="mt-2 max-w-[680px] text-balance text-[30px] font-medium leading-[1.14] tracking-[-1.1px] text-neutral-950 dark:text-neutral-50 sm:text-[38px] sm:tracking-[-1.6px]">
        {title}
      </h3>
      <p className="mt-3 max-w-[520px] text-[14px] leading-[1.75] text-neutral-500 dark:text-neutral-400 sm:text-[15px]">
        {subtitle}
      </p>

      {prompts.length > 0 && (
        <div
          className={cn(
            'mt-8 grid w-full grid-cols-1 gap-2 sm:grid-cols-2',
            centered && 'justify-center',
          )}
        >
          {prompts.map((prompt, index) => (
            <button
              key={prompt.id}
              type="button"
              onClick={() => onSelectPrompt?.(prompt)}
              style={{ animationDelay: `${Math.min(index, 5) * 50}ms` }}
              className={cn(
                'min-h-[64px] rounded-xl bg-neutral-50 px-4 py-3 text-left text-[13px] leading-[1.5] text-neutral-700',
                'transition-[background-color,color,transform] duration-150 active:scale-[0.99]',
                'hover:bg-neutral-100 hover:text-neutral-950',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-neutral-400',
                'motion-safe:animate-[su-msg-in_240ms_cubic-bezier(0.23,1,0.32,1)_both]',
                'dark:bg-white/[0.045] dark:text-neutral-300 dark:hover:bg-white/[0.075] dark:hover:text-neutral-50',
              )}
            >
              {prompt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default ChatEmptyState;
