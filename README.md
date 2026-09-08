# Codex Review Agent

An AI-powered code review agent built on Cloudflare. You paste code or a diff into a chat, the agent runs it through a durable multi-step review workflow, and it remembers facts about your project so later reviews get better.

Live: https://codex-review-agent.vikashmaddi-569.workers.dev

Built for the Cloudflare Developer Productivity take-home. The theme comes straight from the job description: turn engineering standards (an "Engineering Codex") into automated guardrails, and put an agent in front of them.

## What it does

- **Chat with an agent** that knows a small Engineering Codex (eight policy-as-code rules: hardcoded secrets, debug logging, missing timeouts, swallowed errors, bare TODOs, `any`, string-built SQL, unbounded retries).
- **Paste code and get a review.** The agent starts a Cloudflare Workflow that runs the rules, asks Llama 3.3 for a design and correctness review with the rule findings as context, then scores the change and returns a verdict: approve, request changes, or block.
- **Memory that survives reloads.** Tell it "this project is a Go service deployed with ArgoCD" and it stores that in the Durable Object's SQLite. Every later review, in any later session, gets that context. Chat history is persisted too.
- **Follow-ups.** Ask it to remind you to re-review something in ten minutes and it schedules the task on the Durable Object.
- **MCP.** You can attach remote MCP servers from the header and their tools become available to the agent.

## How the pieces map to the assignment

| Requirement | Where |
| --- | --- |
| LLM | Workers AI. Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) runs the review step and repairs malformed tool calls. `@cf/openai/gpt-oss-120b` runs the chat loop and its tool calls. See "Why two models" below |
| Workflow / coordination | `CodexReviewWorkflow` in `src/workflow.ts` runs as a Cloudflare Workflow with three retryable steps. The agent itself is a Durable Object (`ChatAgent`) |
| User input via chat | React chat UI on Workers static assets (`src/app.tsx`), WebSocket to the agent |
| Memory or state | Durable Object SQLite: `project_facts` and `reviews` tables plus persisted chat messages (`src/server.ts`) |

## Architecture

```
Browser (React, WebSocket)
   │
   ▼
Worker  ──routeAgentRequest──▶  ChatAgent (Durable Object, SQLite)
                                   │  streamText with Llama 3.3 + tools
                                   │
                                   ├─ rememberProjectFact / recallProjectFacts  ──▶ project_facts table
                                   ├─ runCodexReview  ──runWorkflow──▶  CodexReviewWorkflow
                                   │                                      1. run Codex rules
                                   │                                      2. Llama 3.3 review (Workers AI)
                                   │                                      3. score, saveReview() RPC back to agent
                                   └─ onWorkflowComplete  ──broadcast──▶ toast in the browser
```

The agent starts the workflow and waits a short while for the result so the answer shows up inline. If the model step is slow the tool returns the review id, the workflow finishes on its own, writes the result back over RPC, and the browser gets a toast.

## Run it

```bash
npm install
npx wrangler login       # Workers AI has no local simulator, so dev runs against your account
npm run dev              # http://localhost:5173
```

Deploy:

```bash
npm run deploy
```

Try these in the chat:

1. "Remember that this project is a TypeScript Worker deployed with Wrangler and GitHub Actions."
2. Paste a function with a `fetch` and no timeout, or a hardcoded key, and say "review this".
3. "Which Codex rules do you enforce?"
4. Reload the page and ask "What do you remember about my project?"

## Project layout

```
src/
  codex.ts      Engineering Codex rules (policy-as-code) and scoring
  workflow.ts   CodexReviewWorkflow: rules -> LLM review -> score and persist
  server.ts     ChatAgent (AIChatAgent): tools, memory tables, workflow callbacks
  app.tsx       Chat UI (Kumo components)
  client.tsx    React entry
wrangler.jsonc  AI, Durable Object and Workflow bindings
PROMPT_HISTORY.md  How this was built with an AI coding assistant
```

## Prompt history

AI-assisted coding was used throughout. The full record of prompts and decisions is in [PROMPT_HISTORY.md](./PROMPT_HISTORY.md).

## Why two models

The assignment recommends Llama 3.3, and it does the actual review. It was also the first choice for the chat loop, but on Workers AI its streamed tool-call arguments arrive with duplicated fragments through the AI SDK, so `{"topic": "language"}` shows up as `{"topic": "{"topic": "language"language"...` and the tool call fails. Llama 4 Scout and Qwen3 30B had the same problem. gpt-oss-120b was clean across every test, so it drives the chat and tool calls.

Two guardrails remain for the cases that slip through:

- `experimental_repairToolCall` hands a malformed argument string plus the tool's JSON schema to Llama 3.3 and asks for the corrected object. If the result is not valid JSON the original error stands.
- The UI collapses a failed tool call into a one-line note when a later call to the same tool in the same turn succeeded, so a retry does not look like a crash.

The full debugging trail is in `PROMPT_HISTORY.md`.

## Notes and trade-offs

- The Codex rules are intentionally simple regex checks. The point is the shape: deterministic checks first, model second, one durable pipeline. Real rules would come from the team's Codex and run as proper AST or linter passes.
- Workflows give each step its own retry and timeout, so a flaky model call does not redo the rule pass and a crash mid-run resumes where it left off.
- Everything is per chat session (one Durable Object per agent name). A production version would key the agent on a user or a repo.
- Remembered facts are deduplicated by text, and the side panel lets you delete one. Clear in the header only clears the chat, memory survives on purpose.
