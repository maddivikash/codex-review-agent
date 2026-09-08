import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { describeRules, CODEX_RULES } from "./codex";
import {
  CodexReviewWorkflow,
  REVIEW_MODEL,
  type ReviewResult
} from "./workflow";

export { CodexReviewWorkflow };

type FactRow = { id: string; topic: string; fact: string; created_at: string };
type ReviewRow = {
  review_id: string;
  title: string;
  language: string;
  score: number;
  verdict: string;
  summary: string;
  payload: string;
  created_at: string;
};

const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Codex Review Agent.
 *
 * One Durable Object per chat session. Chat history is persisted by
 * AIChatAgent; project facts and finished reviews live in the same SQLite
 * store so the agent remembers them across reloads and hibernation.
 */
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  waitForMcpConnections = true;

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS project_facts (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      fact TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS reviews (
      review_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      language TEXT NOT NULL,
      score INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;

    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  // ---- memory helpers -------------------------------------------------

  private listFacts(): FactRow[] {
    return this
      .sql<FactRow>`SELECT id, topic, fact, created_at FROM project_facts ORDER BY created_at ASC`;
  }

  private getReview(reviewId: string): ReviewResult | undefined {
    const rows = this
      .sql<ReviewRow>`SELECT * FROM reviews WHERE review_id = ${reviewId} LIMIT 1`;
    return rows.length
      ? (JSON.parse(rows[0].payload) as ReviewResult)
      : undefined;
  }

  /** Called by CodexReviewWorkflow over RPC once a review is finished. */
  async saveReview(review: ReviewResult) {
    this.sql`INSERT OR REPLACE INTO reviews
      (review_id, title, language, score, verdict, summary, payload, created_at)
      VALUES (${review.reviewId}, ${review.title}, ${review.language}, ${review.score},
              ${review.verdict}, ${review.summary}, ${JSON.stringify(review)}, ${review.completedAt})`;
  }

  async onWorkflowComplete(
    _workflowName: string,
    _workflowId: string,
    result?: unknown
  ) {
    const review = result as ReviewResult | undefined;
    this.broadcast(
      JSON.stringify({
        type: "codex-review-complete",
        reviewId: review?.reviewId,
        title: review?.title,
        verdict: review?.verdict,
        score: review?.score,
        summary: review?.summary
      })
    );
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    this.broadcast(
      JSON.stringify({ type: "codex-review-error", workflowId, error })
    );
  }

  // ---- MCP management (callable from the UI) ---------------------------

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  // ---- chat -------------------------------------------------------------

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });
    const facts = this.listFacts();

    const result = streamText({
      model: workersai(CHAT_MODEL, { sessionAffinity: this.sessionAffinity }),
      system: `You are the Codex Review Agent, an assistant for a developer productivity team. You help engineers check code against the team's Engineering Codex, remember facts about their projects, and schedule follow-ups.

How to behave:
- When the user pastes code or asks for a review, call runCodexReview with a short title, the language, and the exact code. Do not review code yourself without the tool; the tool runs a durable multi-step workflow.
- When the user tells you something about their project (language, framework, CI system, deploy target, conventions), call rememberProjectFact so it is available in later reviews and sessions.
- When asked what you know or remember, call recallProjectFacts.
- Keep answers short and concrete. Plain prose and short bullets. No markdown headings and no em dashes.

Engineering Codex rules the workflow enforces:
${describeRules()}

${facts.length ? `Facts you already remember about this project:\n- ${facts.map((f) => `[${f.topic}] ${f.fact}`).join("\n- ")}` : "You have no stored project facts yet."}

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task or a reminder, use the scheduleTask tool.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        ...mcpTools,

        runCodexReview: tool({
          description:
            "Run a durable, multi-step Codex review on a code snippet or diff. Returns rule findings, an LLM review, a score and a verdict.",
          inputSchema: z.object({
            title: z
              .string()
              .describe(
                "Short title for the change, like 'Add retry to webhook client'"
              ),
            language: z
              .string()
              .describe(
                "Programming language, like typescript, python, go, bash"
              ),
            code: z.string().min(1).describe("The exact code or diff to review")
          }),
          execute: async ({ title, language, code }) => {
            const reviewId = crypto.randomUUID().slice(0, 8);
            const projectContext = this.listFacts().map(
              (f) => `[${f.topic}] ${f.fact}`
            );
            const workflowId = await this.runWorkflow(
              "CODEX_REVIEW_WORKFLOW",
              { reviewId, title, language, code, projectContext },
              { metadata: { reviewId, title } }
            );

            // Give the workflow a moment to finish so the answer is inline.
            // If it is still running, the UI gets a toast on completion and
            // the user can ask for the result by id.
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline) {
              const review = this.getReview(reviewId);
              if (review) return review;
              const status = await this.getWorkflowStatus(
                "CODEX_REVIEW_WORKFLOW",
                workflowId
              );
              if (
                status.status === "errored" ||
                status.status === "terminated"
              ) {
                return {
                  reviewId,
                  workflowId,
                  status: status.status,
                  error: status.error
                };
              }
              await new Promise((r) => setTimeout(r, 1500));
            }
            return {
              reviewId,
              workflowId,
              status: "running",
              note: "The review is still running. Ask for the result with this reviewId in a moment."
            };
          }
        }),

        getReviewResult: tool({
          description: "Fetch a finished Codex review by its reviewId.",
          inputSchema: z.object({ reviewId: z.string() }),
          execute: async ({ reviewId }) => {
            const review = this.getReview(reviewId);
            if (review) return review;
            const running = this.getWorkflows({
              status: ["queued", "running", "paused", "waiting"]
            });
            const match = running.workflows.find(
              (w) => w.metadata?.reviewId === reviewId
            );
            return match
              ? { reviewId, status: match.status, note: "Still running." }
              : {
                  reviewId,
                  status: "unknown",
                  note: "No review with that id."
                };
          }
        }),

        listReviews: tool({
          description: "List past Codex reviews stored for this session.",
          inputSchema: z.object({}),
          execute: async () => {
            const rows = this
              .sql<ReviewRow>`SELECT review_id, title, language, score, verdict, summary, created_at
              FROM reviews ORDER BY created_at DESC LIMIT 20`;
            return rows.length ? rows : "No reviews yet.";
          }
        }),

        listCodexRules: tool({
          description:
            "List the Engineering Codex rules the review workflow enforces.",
          inputSchema: z.object({}),
          execute: async () =>
            CODEX_RULES.map(({ id, title, severity, rationale }) => ({
              id,
              title,
              severity,
              rationale
            }))
        }),

        rememberProjectFact: tool({
          description:
            "Store a fact about the user's project so it persists across sessions and is used in future reviews.",
          inputSchema: z.object({
            topic: z
              .string()
              .describe(
                "Short category, like language, ci, deploy, conventions, team"
              ),
            fact: z.string().describe("The fact to remember, in one sentence")
          }),
          execute: async ({ topic, fact }) => {
            const id = crypto.randomUUID().slice(0, 8);
            this.sql`INSERT INTO project_facts (id, topic, fact, created_at)
              VALUES (${id}, ${topic.toLowerCase()}, ${fact}, ${new Date().toISOString()})`;
            return { id, topic, fact, stored: true };
          }
        }),

        recallProjectFacts: tool({
          description: "List everything remembered about the user's project.",
          inputSchema: z.object({}),
          execute: async () => {
            const facts = this.listFacts();
            return facts.length ? facts : "Nothing stored yet.";
          }
        }),

        forgetProjectFact: tool({
          description: "Delete a remembered project fact by id.",
          inputSchema: z.object({ id: z.string() }),
          execute: async ({ id }) => {
            this.sql`DELETE FROM project_facts WHERE id = ${id}`;
            return { id, deleted: true };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a follow-up or reminder for later. Use when the user asks to be reminded or wants something re-checked later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule")
              return "Not a valid schedule input";
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all scheduled tasks",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({ taskId: z.string() }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        chatModel: CHAT_MODEL,
        reviewModel: REVIEW_MODEL
      });
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
