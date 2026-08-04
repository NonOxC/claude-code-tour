export interface TourStep {
  file: string;
  startLine: number;
  endLine: number;
  title: string;
  explanation: string;
  /**
   * The first line of the range, copied verbatim. Line numbers go stale the moment
   * the user edits the file, so this is used to re-locate the range at display time;
   * the line numbers are only a proximity hint.
   */
  anchor?: string;
  /**
   * The code this step was explaining, captured from disk when the tour was built.
   * Filled in locally - never requested from the model, which would just be paying
   * to duplicate text we can read for free and exactly.
   *
   * This is what makes an unresolvable step recoverable instead of merely honest: if
   * the file has changed so much the anchor is gone, we can still show the learner
   * the code the explanation is actually about.
   */
  snapshot?: string;
}

/** How confidently a step's range was located in the current document. */
export type StepResolution = 'exact' | 'relocated' | 'line-only' | 'unresolved' | 'missing-file';

export interface TourPlan {
  question: string;
  summary: string;
  steps: TourStep[];
  /** Reported by the CLI. Surfaced because a tour measurably costs real money. */
  costUsd?: number;
  durationMs?: number;
}

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'ask'; question: string }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; index: number }
  | { type: 'cancel' }
  | { type: 'end' };

export type ExtensionToWebviewMessage =
  | { type: 'loading'; question: string }
  | { type: 'error'; message: string }
  | { type: 'plan'; plan: TourPlan; index: number }
  /**
   * `resolution` tells the webview how much to trust the highlight. Anything other
   * than 'exact' must be surfaced to the user - silently explaining the wrong lines
   * is the worst failure mode for a teaching tool.
   */
  | { type: 'step'; index: number; resolution: StepResolution; note?: string }
  /** Put the cursor in the panel's own Ask box, optionally seeding it. */
  | { type: 'focusInput'; prefill?: string }
  | { type: 'idle' };

export const TOUR_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One or two sentence plain-English overview of the answer, shown before the step-by-step tour.',
    },
    steps: {
      type: 'array',
      description:
        'The ordered walkthrough steps, in the sequence a teacher would present them (not necessarily file order).',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Path to the file, relative to the workspace root.',
          },
          startLine: {
            type: 'integer',
            description: '1-based inclusive start line of the range to highlight.',
          },
          endLine: {
            type: 'integer',
            description: '1-based inclusive end line of the range to highlight.',
          },
          anchor: {
            type: 'string',
            description:
              "The first line of the highlighted range, copied VERBATIM from the file including its exact leading indentation. Used to re-locate the range if the file has been edited since. Copy it character for character; do not paraphrase, trim, or reformat it.",
          },
          title: {
            type: 'string',
            description: 'Short heading for this step (a few words).',
          },
          explanation: {
            type: 'string',
            description: 'Plain-English explanation of what this range does and why it matters to the question, written for someone reading it as a teaching step.',
          },
        },
        required: ['file', 'startLine', 'endLine', 'anchor', 'title', 'explanation'],
      },
    },
  },
  required: ['summary', 'steps'],
} as const;
