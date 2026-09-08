# Prompt history

This project was built with Claude Code (Anthropic's CLI coding agent) in one working session on 8 September 2026. Cloudflare asked for the prompt history alongside the repo, so here it is, in order, with the decisions that came out of each step and the bugs we hit on the way.

Two notes on how to read this:

- My prompts are reproduced as I typed them, with only spelling cleaned up. I type fast and badly.
- Under each prompt I have written what the assistant actually did and where I stepped in. The assistant made most of the low-level implementation calls on its own. The product shape, the acceptance decisions, and the calls about my own accounts were mine.

## 1. Framing the assignment

**Prompt**

> There is a task in this Cloudflare application and they need prompt history. Please check everything properly. Ask me if any details are required.

**What happened**

The assistant read the job posting, found the optional assignment (LLM, workflow or coordination, chat or voice input, memory or state, all on Cloudflare, with AI-assisted coding allowed as long as prompt history is submitted) and came back with a set of questions instead of guessing. I answered: build the assignment first, then apply.

## 2. Choosing what to build

The assistant proposed the theme and I approved it. Its reasoning:

- The role is on the Developer Productivity team and the description talks about an Engineering Codex, policy-as-code, MCP servers, agents and evals.
- So the app should be an agent that reviews code against a small Codex, with deterministic checks running first and an LLM review layered on top.
- Workflows fit a multi-step review because each step gets its own retry and timeout.
- The Durable Object behind the agent already has SQLite, so project memory goes there, not in a separate store.

Model plan at this point: Llama 3.3 70B on Workers AI for everything, which is what the assignment recommends. That changed later, see section 7.

## 3. Scaffolding

Scaffolded from Cloudflare's official `agents-starter` template with `npm create cloudflare@latest`. Before changing anything the assistant read the generated `server.ts`, `wrangler.jsonc` and the `agents` package type definitions from `node_modules` rather than working from memory of the API. That is how it found `runWorkflow`, `getWorkflowStatus`, `step.reportComplete` and the `this.agent` RPC stub that the workflow uses to write results back.

## 4. Building the pieces

**`src/codex.ts`**: eight policy-as-code rules (hardcoded secrets, debug logging, fetch without timeout, empty catch, bare TODO, `any`, string-built SQL, unbounded retry loop), a scorer, and a helper that renders the rules into the system prompt. Every rule is a pure function over lines of code so it can be tested without Cloudflare.

**`src/workflow.ts`**: `CodexReviewWorkflow extends AgentWorkflow`. Three `step.do` calls: run the rules, call Llama 3.3 with the findings and remembered project facts as context, then score and write the result back to the agent over RPC. The LLM step has its own retry policy and a two minute timeout.

**`src/server.ts`**: `ChatAgent extends AIChatAgent`. Creates `project_facts` and `reviews` tables in `onStart`. Tools: `runCodexReview`, `getReviewResult`, `listReviews`, `listCodexRules`, `rememberProjectFact`, `recallProjectFacts`, `forgetProjectFact`, plus the scheduling tools from the starter. Remembered facts are injected into the system prompt on every turn. `onWorkflowComplete` broadcasts a toast to the browser.

**`wrangler.jsonc`**: added the Workflow binding and a `/health` route.

**`src/app.tsx`**: renamed, new suggested prompts, toast handling for review completion and failure. The starter's client-side timezone tool was removed because every tool here runs on the server.

## 5. Verification before I looked at it

- `tsc --noEmit`, `oxlint` and `oxfmt` clean.
- A smoke test of the rules module against a deliberately bad snippet: all eight rules fired, score 0. A clean snippet: zero findings, score 100. One bug found and fixed here: a rule that matched a line twice reported the line twice, so hits are now deduplicated.

## 6. Getting it deployed

**Prompt**

> Can you run these commands yourself?

I had been asked to run `wrangler login` and `gh auth login` by hand. I asked the assistant to drive them instead. Two things came out of that:

- The GitHub CLI's OAuth screen listed my employer's GitHub organization under "Organization access" with no way to exclude it. I stopped that flow. The assistant switched to plain git over SSH, which was already set up for my personal account, and I created the empty repo in the browser myself. No CLI token with org access was ever issued.
- The Cloudflare account had no `workers.dev` subdomain yet, which blocks both remote dev and deploy. The assistant tried to register one through the API, that was blocked by its own permission guard, and I registered it from the dashboard instead. Right call on both sides.

## 7. The first live run failed, and the debugging that followed

**Prompt**

> Before you submit, show me what you built as well.

The assistant drove the deployed app with Playwright: store a fact, paste a bad function, reload, ask what it remembers. Every tool that took arguments failed with "An error occurred." and the model retried in a loop. Read-only tools with empty schemas worked. The trail:

1. Worker logs showed no server exception, so the failure was between the model and the AI SDK. The assistant captured the WebSocket frames instead. The tool input arrived as `{"topic": "{"topic": "language"language", "fact": ", "fact": "ThisThis project project uses uses Go"} Go"}`. Every streamed argument fragment was duplicated.
2. First fix attempt: switch the chat model to Kimi K2.7, the model the starter template uses. Added an `onError` hook to `streamText` so the real error would be logged. Result: "Model is not available on the Workers Free plan." So that was not an option on my account.
3. Back to Llama 3.3 and a systematic test of free-plan models with function calling, each run against a fresh chat: Llama 3.3, Llama 4 Scout and Qwen3 30B all produced the duplicated fragments on at least one call. gpt-oss-120b was clean every time.
4. Decision: gpt-oss-120b drives the chat and its tool calls. Llama 3.3 stays where the assignment wants it, doing the actual code review inside the workflow, where it is a plain generation call with no tools.
5. Even the clean model had one malformed call out of roughly ten in a longer test, and it recovered by retrying. Two guardrails went in for that case: `experimental_repairToolCall` asks Llama 3.3 to reconstruct the JSON against the tool schema, and the UI collapses a failed call into a one-line note when a later call to the same tool in the same turn succeeded.

Root cause, as far as we could tell from the provider source: Workers AI streams tool-call argument deltas and `workers-ai-provider` emits a `tool-input-delta` per chunk. For some models the same fragment shows up twice in the stream, so the accumulated arguments are corrupted. It looks like a model-side or provider-side streaming issue rather than anything in this app, and the fix above works around it without patching `node_modules`.

## 8. Frontend

**Prompt**

> Can we work on the frontend as well if we need to, and also make sure we have the prompt history, so plan properly.

Changes:

- The agent now keeps `{ facts, reviews }` in Agent state, which the SDK syncs to every connected browser. A side panel shows project memory with a delete button per fact (wired to a `@callable()` method) and the recent reviews with verdict and score.
- Review results render as a card: title, language, verdict badge, score bar, one line per Codex finding with severity, and the Llama review folded under a disclosure. Raw JSON is still there in debug mode.
- While a review runs, the tool call shows the code being reviewed rather than a spinner with JSON under it.
- Remembered facts get a compact "Remembered [topic] fact" line instead of the generic tool card.
- `rememberProjectFact` now deduplicates by text, because repeated test runs had filled the panel with copies.

Verified locally with Playwright screenshots, then deployed and verified again against the live URL: fact stored, review returned request-changes at 60/100 with two findings and a model review that cited the remembered logging convention, toast fired, memory and last verdict survived a reload.

## 9. The prompt history itself

**Prompt**

> The prompt history should be top class and read like a human wrote it. No em dashes or anything like that if you write generally.

That is the one rule this document follows on purpose. There are no em dashes in the README, in this file, or in any user-visible string in the app, and the agent's system prompt asks the model to avoid them too.
