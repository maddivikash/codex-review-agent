/**
 * Engineering Codex: a small set of policy-as-code rules.
 *
 * Each rule is deterministic and cheap. The idea is the same one that drives
 * CI guardrails: catch the obvious, mechanical problems before a model ever
 * sees the code, so the LLM review can spend its attention on design and
 * correctness instead of secrets and debug statements.
 */

export type Severity = "blocker" | "warning" | "info";

export type CodexRule = {
  id: string;
  title: string;
  severity: Severity;
  rationale: string;
  /** Returns the 1-based line numbers where the rule fires. */
  check: (lines: string[], language: string) => number[];
};

export type RuleFinding = {
  ruleId: string;
  title: string;
  severity: Severity;
  lines: number[];
  rationale: string;
};

function matchLines(lines: string[], pattern: RegExp): number[] {
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (pattern.test(line)) hits.push(i + 1);
  });
  return hits;
}

export const CODEX_RULES: CodexRule[] = [
  {
    id: "CX-001",
    title: "No hardcoded secrets",
    severity: "blocker",
    rationale:
      "Credentials in source end up in git history and CI logs. Read them from bindings or a secret store instead.",
    check: (lines) =>
      matchLines(
        lines,
        /(api[_-]?key|secret|password|passwd|token|authorization)\s*[:=]\s*["'`][^"'`]{6,}["'`]/i
      ).concat(matchLines(lines, /(sk|ghp|xox[bap]|AKIA)[A-Za-z0-9_-]{16,}/))
  },
  {
    id: "CX-002",
    title: "No leftover debug logging",
    severity: "warning",
    rationale:
      "console.log and print statements leak into production logs and hide real signal. Use structured logging.",
    check: (lines, language) =>
      /(python|py)/i.test(language)
        ? matchLines(lines, /^\s*print\(/)
        : matchLines(lines, /console\.(log|debug)\(/)
  },
  {
    id: "CX-003",
    title: "Network calls need a timeout",
    severity: "warning",
    rationale:
      "A fetch or HTTP call without a timeout can hang a worker or a workflow step forever. Use AbortSignal.timeout or a request timeout.",
    check: (lines, language) => {
      const source = lines.join("\n");
      const hasTimeout = /AbortSignal\.timeout|timeout\s*[:=]|signal\s*:/i.test(
        source
      );
      if (hasTimeout) return [];
      return /(python|py)/i.test(language)
        ? matchLines(lines, /requests\.(get|post|put|delete|patch)\(/)
        : matchLines(lines, /\bfetch\(|axios\.(get|post|put|delete|patch)\(/);
    }
  },
  {
    id: "CX-004",
    title: "Empty catch blocks swallow errors",
    severity: "warning",
    rationale:
      "An empty catch hides failures from operators. Log, rethrow, or return a typed error.",
    check: (lines) => {
      const hits: number[] = [];
      for (let i = 0; i < lines.length - 1; i++) {
        if (
          /catch\s*(\([^)]*\))?\s*\{\s*$/.test(lines[i]) &&
          /^\s*\}/.test(lines[i + 1])
        ) {
          hits.push(i + 1);
        }
        if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(lines[i])) hits.push(i + 1);
        if (
          /^\s*except[^:]*:\s*$/.test(lines[i]) &&
          /^\s*pass\s*$/.test(lines[i + 1])
        ) {
          hits.push(i + 1);
        }
      }
      return hits;
    }
  },
  {
    id: "CX-005",
    title: "No TODO or FIXME without an owner or ticket",
    severity: "info",
    rationale:
      "Bare TODOs never get picked up. Reference a ticket or an owner so the work is trackable.",
    check: (lines) =>
      matchLines(lines, /\b(TODO|FIXME|HACK)\b(?![^\n]*(#\d+|[A-Z]+-\d+|@\w+))/)
  },
  {
    id: "CX-006",
    title: "Avoid the any type",
    severity: "info",
    rationale:
      "Explicit any turns off the type checker where it matters most, at the boundaries.",
    check: (lines, language) =>
      /(typescript|ts)/i.test(language)
        ? matchLines(lines, /:\s*any\b|as\s+any\b/)
        : []
  },
  {
    id: "CX-007",
    title: "SQL should be parameterized",
    severity: "blocker",
    rationale:
      "String-built SQL is the classic injection path. Use bound parameters or a tagged template.",
    check: (lines) =>
      matchLines(
        lines,
        /(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(\+\s*\w|\$\{|%s|\.format\()/i
      )
  },
  {
    id: "CX-008",
    title: "Retries need a bound",
    severity: "warning",
    rationale:
      "An unbounded retry loop turns a transient outage into a self-inflicted one.",
    check: (lines) =>
      matchLines(lines, /while\s*\(\s*true\s*\)|while\s+True\s*:/)
  }
];

export function runCodexRules(code: string, language: string): RuleFinding[] {
  const lines = code.split(/\r?\n/);
  const findings: RuleFinding[] = [];
  for (const rule of CODEX_RULES) {
    const hits = rule.check(lines, language);
    const uniqueHits = [...new Set(hits)].sort((a, b) => a - b);
    if (uniqueHits.length > 0) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        lines: uniqueHits,
        rationale: rule.rationale
      });
    }
  }
  return findings;
}

export function scoreFindings(findings: RuleFinding[]): number {
  const penalty: Record<Severity, number> = {
    blocker: 30,
    warning: 12,
    info: 4
  };
  const total = findings.reduce((sum, f) => sum + penalty[f.severity], 0);
  return Math.max(0, 100 - total);
}

export function describeRules(): string {
  return CODEX_RULES.map(
    (r) => `${r.id} [${r.severity}] ${r.title}: ${r.rationale}`
  ).join("\n");
}
