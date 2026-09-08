# Prompt history

This project was built with Claude Code (Anthropic's CLI coding agent) in one working session on 8 September 2026. Cloudflare asked for the prompt history alongside the repo, so here it is, in order, with the decisions that came out of each step.

Two notes on how to read this:

- My prompts are reproduced as I typed them, with only spelling cleaned up. I type fast and badly.
- Under each prompt I have written what the assistant actually did and where I stepped in. The assistant made most of the low-level implementation calls on its own; the product shape, the theme, and the acceptance decisions were mine.

## 1. Framing the assignment

**Prompt**

> There is a task in this Cloudflare application and they need prompt history. Please check everything properly. Ask me if any details are required.

**What happened**

The assistant read the job posting, found the optional assignment (LLM, workflow or coordination, chat or voice input, memory or state, all on Cloudflare, with AI-assisted coding allowed as long as prompt history is submitted) and came back with a set of questions instead of guessing. I answered them: build the assignment first, and use my real GitHub account.

## 2. Choosing what to build

The assistant proposed the theme and I approved it. The reasoning, as it laid it out:

- The role is on the Developer Productivity team and the description talks about an Engineering Codex, policy-as-code, MCP servers, agents and evals.
- So the app should be an agent that reviews code against a small Codex, with the deterministic checks running first and an LLM review layered on top.
- Workflows are the natural fit for a multi-step review because each step gets its own retry and timeout.
- The Durable Object behind the agent already has SQLite, so project memory goes there, not in a separate store.

Model choice: Llama 3.3 70B on Workers AI, which is what the assignment recommends, used for both chat and the review step.

## 3. Scaffolding

**Prompt (assistant to itself, after I approved the plan)**

Scaffold from Cloudflare's official `agents-starter` template with `npm create cloudflare@latest`, then read the generated `server.ts`, `wrangler.jsonc` and the `agents` package type definitions before changing anything.

**What happened**

It read the `AgentWorkflow` and `AIChatAgent` type definitions from `node_modules` rather than relying on memory of the API. That is how it found `runWorkflow`, `getWorkflowStatus`, `step.reportComplete` and the `this.agent` RPC stub, which shaped the design below.

## 4. Building the pieces

The build was done as three files plus config, in this order.

**`src/codex.ts`**: eight policy-as-code rules (hardcoded secrets, debug logging, fetch without timeout, empty catch, bare TODO, `any`, string-built SQL, unbounded retry loop), a scorer, and a helper that renders the rules into the system prompt. Every rule is a pure function over lines of code so it can be unit tested without Cloudflare.

**`src/workflow.ts`**: `CodexReviewWorkflow extends AgentWorkflow`. Three `step.do` calls: run the rules, call Llama 3.3 with the findings and remembered project facts as context, then score and write the result back to the agent over RPC with `this.agent.saveReview()`. The LLM step has its own retry policy and a two minute timeout.

**`src/server.ts`**: `ChatAgent extends AIChatAgent`. Creates `project_facts` and `reviews` tables in `onStart`. Tools: `runCodexReview`, `getReviewResult`, `listReviews`, `listCodexRules`, `rememberProjectFact`, `recallProjectFacts`, `forgetProjectFact`, plus the scheduling tools from the starter. Remembered facts are injected into the system prompt on every turn. `onWorkflowComplete` broadcasts a toast to the browser.

**`wrangler.jsonc`**: added the Workflow binding and a `/health` route.

**`src/app.tsx`**: renamed, new suggested prompts, toast handling for review completion and failure. The starter's client-side timezone tool was removed because every tool here runs on the server.

## 5. Verification before I looked at it

- `tsc --noEmit` clean.
- `oxlint` and `oxfmt` clean.
- A smoke test of the rules module against a deliberately bad snippet: all eight rules fired, score 0. A clean snippet: zero findings, score 100. One bug found and fixed here: a rule that matched a line twice reported the line twice, so hits are now deduplicated.

## 6. My review of the running app

**Prompt**

> Before you submit, show me what you built as well.

**What happened**

_(filled in after the live run, see below)_

## 7. The prompt history itself

**Prompt**

> The prompt history should be top class and read like a human wrote it. No em dashes or anything like that if you write generally.

That is the one rule this document follows on purpose.
