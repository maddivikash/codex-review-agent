import { AgentWorkflow, type AgentWorkflowStep } from "agents/workflows";
import type { WorkflowEvent } from "cloudflare:workers";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";
import type { ChatAgent } from "./server";
import { runCodexRules, scoreFindings, type RuleFinding } from "./codex";

export const REVIEW_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type ReviewParams = {
  reviewId: string;
  title: string;
  language: string;
  code: string;
  /** Facts the agent remembers about the project, injected into the LLM step. */
  projectContext: string[];
};

export type ReviewResult = {
  reviewId: string;
  title: string;
  language: string;
  score: number;
  verdict: "approve" | "request-changes" | "block";
  ruleFindings: RuleFinding[];
  llmReview: string;
  summary: string;
  completedAt: string;
};

/**
 * A durable, multi-step code review.
 *
 * Step 1 runs the deterministic Codex rules (policy-as-code).
 * Step 2 asks Llama 3.3 on Workers AI for a design and correctness review,
 *        with the rule findings and remembered project facts as context.
 * Step 3 scores the result, writes it back to the agent, and reports completion.
 *
 * Each step is retried independently by Workflows, so a flaky model call does
 * not redo the rule pass, and a crash mid-run resumes where it left off.
 */
export class CodexReviewWorkflow extends AgentWorkflow<
  ChatAgent,
  ReviewParams
> {
  async run(event: WorkflowEvent<ReviewParams>, step: AgentWorkflowStep) {
    const { reviewId, title, language, code, projectContext } = event.payload;

    await this.reportProgress({
      step: "rules",
      status: "running",
      percent: 0.1
    });

    const ruleFindings = await step.do("run codex rules", async () =>
      runCodexRules(code, language)
    );

    await this.reportProgress({
      step: "llm-review",
      status: "running",
      percent: 0.4,
      message: `${ruleFindings.length} rule finding(s)`
    });

    const llmReview = await step.do(
      "llm review",
      {
        retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes"
      },
      async () => {
        const workersai = createWorkersAI({ binding: this.env.AI });
        const { text } = await generateText({
          model: workersai(REVIEW_MODEL),
          system: [
            "You are a senior engineer on a developer productivity team reviewing a change against an internal Engineering Codex.",
            "Be specific and concise. Reference line numbers when you can. Do not repeat the rule findings that were already detected mechanically; build on them.",
            "Cover: correctness bugs, error handling, reliability (timeouts, retries, idempotency), security, and readability.",
            "Finish with a short list titled 'Suggested changes' with at most five items.",
            "Plain prose and short bullets. No markdown headings."
          ].join(" "),
          prompt: [
            `Change title: ${title}`,
            `Language: ${language}`,
            projectContext.length
              ? `Known facts about this project:\n- ${projectContext.join("\n- ")}`
              : "No stored project facts.",
            ruleFindings.length
              ? `Mechanical Codex findings already detected:\n${ruleFindings
                  .map(
                    (f) =>
                      `- ${f.ruleId} ${f.title} (lines ${f.lines.join(", ")})`
                  )
                  .join("\n")}`
              : "No mechanical Codex findings.",
            "Code under review:",
            "```" + language,
            code,
            "```"
          ].join("\n\n"),
          maxOutputTokens: 900
        });
        return text.trim();
      }
    );

    await this.reportProgress({
      step: "score",
      status: "running",
      percent: 0.9
    });

    const result = await step.do("score and persist", async () => {
      const score = scoreFindings(ruleFindings);
      const hasBlocker = ruleFindings.some((f) => f.severity === "blocker");
      const verdict: ReviewResult["verdict"] = hasBlocker
        ? "block"
        : score < 80
          ? "request-changes"
          : "approve";
      const summary = hasBlocker
        ? `Blocked: ${ruleFindings
            .filter((f) => f.severity === "blocker")
            .map((f) => f.title)
            .join("; ")}.`
        : ruleFindings.length
          ? `${ruleFindings.length} Codex finding(s), score ${score}/100.`
          : `No Codex findings, score ${score}/100.`;

      const review: ReviewResult = {
        reviewId,
        title,
        language,
        score,
        verdict,
        ruleFindings,
        llmReview,
        summary,
        completedAt: new Date().toISOString()
      };
      await this.agent.saveReview(review);
      return review;
    });

    await step.reportComplete(result);
    return result;
  }
}
