import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Report } from "../evaluation/types.js";

/**
 * Generate self-contained HTML report from report.json.
 * All CSS and JS are inlined — the output is a single file.
 */
export async function generateHtmlReport(
  reportPath: string,
  outputPath?: string,
): Promise<string> {
  const raw = await readFile(resolve(process.cwd(), reportPath), "utf-8");
  const report: Report = JSON.parse(raw);
  const html = buildHtml(report);
  if (outputPath) {
    await writeFile(resolve(process.cwd(), outputPath), html, "utf-8");
  }
  return html;
}

export function buildHtml(report: Report): string {
  const failingPolicies = report.policies
    .filter((p) => p.failing > 0)
    .sort((a, b) => a.complianceRate - b.complianceRate);

  const criticalCount = report.conversations.filter(
    (c) => c.diagnosis?.severity === "critical",
  ).length;

  const totalFailures = report.failurePatterns.totalFailures;

  const promptFixable = report.failurePatterns.byType
    .filter((t) => t.type === "prompt_issue" || t.type === "retrieval_rag_issue")
    .reduce((s, t) => s + t.count, 0);

  const needsCode = report.failurePatterns.byType
    .filter((t) => t.type === "orchestration_issue" || t.type === "model_limitation")
    .reduce((s, t) => s + t.count, 0);

  const worstConv = report.conversations
    .filter((c) => c.diagnosis)
    .sort((a, b) => {
      const aAvg = avgMetrics(a.metrics);
      const bAvg = avgMetrics(b.metrics);
      return aAvg - bAvg;
    })[0];

  const failingConvs = report.conversations.filter(
    (c) => c.policyResults.some((pr) => !pr.passed),
  );

  const duration = formatDuration(report.runDuration);
  const date = new Date(report.generatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Converra Triage — ${esc(report.agent.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="page">

  ${renderHeader(report, date, duration)}
  ${renderPipeline(report, failingPolicies.length, criticalCount, totalFailures)}
  ${renderVerdict(report, failingPolicies.length, criticalCount, promptFixable, needsCode)}
  ${renderMetricsBar(report)}
  ${renderFailurePatterns(report)}
  ${renderRecommendations(report)}
  ${worstConv ? renderDeepDive(worstConv, report) : ""}
  ${renderNextStep(report)}
  ${renderAllConversations(failingConvs, report)}
  ${renderReproducibility(report)}

</div>

${renderFooter()}

<script>${JS}</script>
</body>
</html>`;
}

function renderHeader(report: Report, date: string, duration: string): string {
  return `<div class="hdr">
    <div class="hdr-top">
      <div class="logo">${ICONS.check}</div>
      <div class="tool-name"><b>converra</b>-triage</div>
    </div>
    <h1>${esc(report.agent.name)}</h1>
    <div class="hdr-desc">Analyzed ${report.totalConversations} production conversations against ${report.policies.length} behavioral policies extracted from your system prompt.</div>
    <div class="hdr-meta">
      Model <span>${esc(report.llmModel)}</span> &middot;
      Cost <span>$${report.cost.estimatedCost.toFixed(2)}</span> &middot;
      Duration <span>${duration}</span> &middot;
      <span>${date}</span>
    </div>
  </div>`;
}

function renderPipeline(
  report: Report,
  failingCount: number,
  criticalCount: number,
  totalFailures: number,
): string {
  return `<div class="pipeline">
    <div class="pipe-steps">
      <div class="pipe-step"><div class="pipe-num">${report.policies.length}</div><div class="pipe-label"><b>Policies extracted</b><br>from system prompt</div></div>
      <div class="pipe-step"><div class="pipe-num">${report.totalConversations}</div><div class="pipe-label"><b>Conversations</b><br>evaluated</div></div>
      <div class="pipe-step"><div class="pipe-num coral">${totalFailures}</div><div class="pipe-label"><b>Failures found</b><br>across ${report.failurePatterns.byType.length} root causes</div></div>
      <div class="pipe-step"><div class="pipe-num red">${criticalCount}</div><div class="pipe-label"><b>Critical issues</b><br>need immediate fix</div></div>
      <div class="pipe-step"><div class="pipe-num emerald">${report.failurePatterns.topRecommendations.length}</div><div class="pipe-label"><b>Recommendations</b><br>prompt &amp; config</div></div>
    </div>
  </div>`;
}

function renderVerdict(
  report: Report,
  failingCount: number,
  criticalCount: number,
  promptFixable: number,
  needsCode: number,
): string {
  if (failingCount === 0) {
    return `<div class="verdict" style="background:var(--green-bg);border-color:var(--green-border);">
      <div class="verdict-icon" style="color:var(--green);">${ICONS.checkCircle}</div>
      <div>
        <div class="verdict-text">All ${report.policies.length} policies are passing.</div>
        <div class="verdict-detail">No failures detected across ${report.totalConversations} conversations.</div>
      </div>
    </div>`;
  }

  const parts = [];
  if (promptFixable > 0)
    parts.push(
      `${promptFixable} failures (${Math.round((promptFixable / (promptFixable + needsCode)) * 100)}%) are prompt &amp; config issues Converra can fix automatically`,
    );
  if (needsCode > 0)
    parts.push(`${needsCode} need code changes to routing logic`);

  return `<div class="verdict">
    <div class="verdict-icon">${ICONS.alertTriangle}</div>
    <div>
      <div class="verdict-text">${failingCount} of ${report.policies.length} policies are failing${criticalCount > 0 ? ` — ${criticalCount} are critical` : ""}.</div>
      <div class="verdict-detail">${parts.join(". ")}.</div>
    </div>
  </div>`;
}

function renderMetricsBar(report: Report): string {
  const metrics = [
    { key: "successScore", label: "Success" },
    { key: "aiRelevancy", label: "Relevancy" },
    { key: "sentiment", label: "Sentiment" },
    { key: "hallucinationScore", label: "Hallucination" },
    { key: "contextRetentionScore", label: "Context" },
    { key: "clarity", label: "Clarity" },
  ];

  const cells = metrics.map((m) => {
    const val = report.metricSummary[m.key] ?? 0;
    const color = val >= 80 ? "green" : val >= 60 ? "amber" : "red";
    return `<div class="mb-cell"><div class="mb-label">${m.label}</div><div class="mb-val ${color}">${val}</div></div>`;
  });

  return `<div class="metrics-bar" style="margin-top:16px;">${cells.join("")}</div>`;
}

function renderFailurePatterns(report: Report): string {
  if (report.failurePatterns.byType.length === 0) return "";

  const fixable = report.failurePatterns.byType.filter(
    (t) => t.type === "prompt_issue" || t.type === "retrieval_rag_issue",
  );
  const needsCode = report.failurePatterns.byType.filter(
    (t) => t.type === "orchestration_issue" || t.type === "model_limitation",
  );

  let html = `<div class="patterns"><div class="stitle">Where things break</div>`;

  if (fixable.length > 0) {
    html += `<div class="group-label fixable">${ICONS.checkCircleSm} Fixable by Converra — prompt &amp; config <span class="gl-line"></span></div>`;
    for (const pattern of fixable) {
      html += renderPatternDetail(pattern, report);
    }
  }

  if (needsCode.length > 0) {
    html += `<div class="group-label needs-code">${ICONS.code} Needs code change — routing &amp; infrastructure <span class="gl-line"></span></div>`;
    for (const pattern of needsCode) {
      html += renderPatternDetail(pattern, report);
    }
  }

  html += `<div class="trust-note">${ICONS.lock} This report is local-only. No data was uploaded. Converra import is optional.</div>`;
  html += `</div>`;
  return html;
}

function renderPatternDetail(
  pattern: Report["failurePatterns"]["byType"][0],
  report: Report,
): string {
  const typeClass =
    pattern.type === "prompt_issue"
      ? "prompt"
      : pattern.type === "orchestration_issue"
        ? "orch"
        : "model";
  const label = formatFailureType(pattern.type);

  const subtypesHtml = pattern.subtypes
    .map(
      (s) =>
        `<div class="subtype"><div class="sdot ctx"></div>${esc(formatSubtype(s.name))} ${s.count} <span class="spct">(${s.percentage}%)</span></div>`,
    )
    .join("");

  // Find top affected conversations for this pattern
  const affected = report.conversations
    .filter((c) =>
      c.policyResults.some(
        (pr) => !pr.passed && pr.failureType === pattern.type,
      ),
    )
    .slice(0, 3);

  const convRows = affected
    .map((c) => {
      const severity = c.diagnosis?.severity ?? "major";
      const sevClass = severity === "critical" ? "crit" : "major";
      const cause = c.diagnosis?.summary ?? "Policy violation detected";
      return `<div class="mini-row"><span class="mini-id">${esc(c.id.slice(0, 10))}</span><span class="mini-cause">${esc(cause)}</span><span class="sev-badge ${sevClass}">${severity}</span><button class="mini-link" data-conv-id="${esc(c.id)}" onclick="viewConv(event, this)">View ${ICONS.chevRight}</button></div>`;
    })
    .join("");

  const criticalTag =
    pattern.criticalCount > 0
      ? `<span class="critical-tag">${ICONS.alertTriangleSm} ${pattern.criticalCount} critical</span>`
      : "";

  return `<details class="pattern">
    <summary>
      <span class="type-badge ${typeClass}">${label}</span>
      <span class="pattern-count">${pattern.count}</span>
      ${criticalTag}
      <a href="https://converra.ai" class="fix-btn" style="margin-left:auto;">Test fixes in Converra ${ICONS.externalSm}</a>
      ${ICONS.chevDown}
    </summary>
    <div class="pattern-body">
      <div class="subtypes">${subtypesHtml}</div>
      ${convRows ? `<div class="pattern-convs"><div class="pattern-convs-label">Top affected conversations</div>${convRows}</div>` : ""}
    </div>
  </details>`;
}

function renderRecommendations(report: Report): string {
  if (report.failurePatterns.topRecommendations.length === 0) return "";

  const cards = report.failurePatterns.topRecommendations
    .map((rec, i) => {
      const targets = [...rec.targetSubtypes, ...rec.targetFailureTypes]
        .map(formatSubtype)
        .join(", ");
      return `<details class="rec-card"${i === 0 ? " open" : ""}>
      <summary>
        <span class="rec-num">${i + 1}</span>
        <div class="rec-main">
          <div class="rec-title">${esc(rec.title)}</div>
          <div class="rec-meta"><span class="fix-target">${esc(targets)}</span> · ${rec.confidence} confidence · ${rec.affectedConversations} conversations</div>
        </div>
        ${ICONS.chevDown}
      </summary>
      <div class="rec-detail">
        <div class="rec-desc">${esc(rec.description)}</div>
      </div>
    </details>`;
    })
    .join("");

  return `<div class="recs">
    <div class="stitle">How to fix it</div>
    ${cards}
  </div>`;
}

function renderDeepDive(
  conv: Report["conversations"][0],
  report: Report,
): string {
  const d = conv.diagnosis!;
  const typeClass =
    d.failureType === "prompt_issue"
      ? "prompt"
      : d.failureType === "orchestration_issue"
        ? "orch"
        : "model";

  // Build turn timeline
  const turns = conv.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((msg, i) => {
      const turnNum = i + 1;
      const isRoot = turnNum === d.rootCauseTurn;
      const isFailing = conv.policyResults.some(
        (pr) => !pr.passed && pr.failingTurns?.includes(turnNum),
      );
      const dotClass = isFailing ? "f" : isRoot ? "f" : "p";

      const failBadges = conv.policyResults
        .filter(
          (pr) => !pr.passed && pr.failingTurns?.includes(turnNum),
        )
        .map((pr) => {
          const policy = report.policies.find((p) => p.id === pr.policyId);
          return `<span class="tb f">${esc(policy?.name ?? pr.policyId)} ×</span>`;
        })
        .join("");

      const label = isRoot ? `Turn ${turnNum} — root cause` : `Turn ${turnNum}`;
      const content = msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content;

      return `<div class="turn"><div class="tdot ${dotClass}"></div><div class="tc"><div class="tc-label">${label}</div><div class="tc-text">${esc(content)}</div>${failBadges ? `<div class="tc-badges">${failBadges}</div>` : ""}</div></div>`;
    });

  // Only show key turns (up to 8)
  const keyTurns = turns.slice(0, 8);

  const blastHtml =
    d.blastRadius.length > 0
      ? `<div class="blast"><span class="blast-icon">${ICONS.alertTriangleSm}</span><span><strong>Blast radius:</strong> Editing may affect ${d.blastRadius.map((r) => `<em>${esc(r)}</em>`).join(", ")}. Manual edits often fix one policy while breaking another.</span></div>`
      : "";

  return `<details class="diag" open>
    <summary>
      <div>
        <h2>Deep Dive — Most Severe Failure</h2>
        <div class="diag-sub">
          Root cause at Turn ${d.rootCauseTurn}${d.rootCauseAgent ? ` (${esc(d.rootCauseAgent)})` : ""} — ${esc(d.summary.split(".")[0] ?? d.summary)}
          <span class="sev-badge ${d.severity === "critical" ? "crit" : "major"}">${d.severity}</span>
          <span class="conf">${d.confidence} confidence</span>
        </div>
        <div class="diag-badges"><span class="diag-b type">${formatFailureType(d.failureType)}</span></div>
      </div>
      ${ICONS.chevDownLg}
    </summary>

    <div class="tl">
      <div class="tl-header">
        <div class="tl-label">Turn Timeline</div>
        <div class="tl-filter">Key turns (${keyTurns.length} of ${conv.messages.length})</div>
      </div>
      ${keyTurns.join("")}
    </div>

    <div class="wif">
      <div class="wif-s"><div class="wif-l">What happened</div><div class="wif-t">${esc(d.summary)}</div></div>
      <div class="wif-s"><div class="wif-l impact">Impact</div><div class="wif-t">${esc(d.impact)}</div></div>
      <div class="wif-s"><div class="wif-l fix">Fix</div><div class="wif-t">${esc(d.fix)} <span class="wif-conf">(${d.confidence} confidence)</span></div></div>
    </div>

    ${blastHtml}

    <div class="diag-cta">
      <a href="https://converra.ai" class="diag-link">Generate patch + simulate in Converra ${ICONS.externalSm}</a>
    </div>
  </details>`;
}

function renderNextStep(report: Report): string {
  return `<div class="next-step">
    <div class="next-step-header">${ICONS.external} What Converra does with this report</div>
    <div class="next-step-body">
      <div class="next-step-item">${ICONS.fileSm} <strong>Generate prompt patches</strong> for all ${report.failurePatterns.topRecommendations.length} recommendations</div>
      <div class="next-step-item">${ICONS.checkCircleSm2} <strong>Simulate against all ${report.policies.length} policies</strong> with 50 conversations</div>
      <div class="next-step-item">${ICONS.checkAll} <strong>Deploy the winning variant</strong> without regressions</div>
    </div>
    <div class="next-step-footer">
      <a class="cta" href="https://converra.ai">Import report into Converra (free) ${ICONS.externalSm}</a>
    </div>
  </div>`;
}

function renderAllConversations(
  failing: Report["conversations"],
  report: Report,
): string {
  if (failing.length === 0) return "";

  const shown = failing.slice(0, 50);
  const convHtml = shown
    .map((c) => {
      const d = c.diagnosis;
      const failTypes = [
        ...new Set(
          c.policyResults
            .filter((pr) => !pr.passed && pr.failureType)
            .map((pr) => pr.failureType),
        ),
      ];
      const typeClass = failTypes[0] === "prompt_issue" ? "prompt" : failTypes[0] === "orchestration_issue" ? "orch" : "model";
      const typeLabel = failTypes[0] ? formatFailureType(failTypes[0]) : "Unknown";
      const severity = d?.severity ?? "major";
      const sevClass = severity === "critical" ? "crit" : "major";
      const cause = d?.summary ?? "Policy violation detected";

      const wif = d
        ? `<div class="conv-expand"><div class="wif">
            <div class="wif-s"><div class="wif-l">What happened</div><div class="wif-t">${esc(d.summary)}</div></div>
            <div class="wif-s"><div class="wif-l impact">Impact</div><div class="wif-t">${esc(d.impact)}</div></div>
            <div class="wif-s"><div class="wif-l fix">Fix</div><div class="wif-t">${esc(d.fix)} <span class="wif-conf">(${d.confidence} confidence)</span></div></div>
          </div></div>`
        : "";

      return `<details class="conv-detail" id="${esc(c.id)}">
        <summary>
          <span class="cid">${esc(c.id.slice(0, 10))}</span>
          <span class="type-badge ${typeClass}">${typeLabel}</span>
          <span class="conv-cause">${esc(cause)}</span>
          <span class="sev-badge ${sevClass}">${severity}</span>
          ${ICONS.chevDownSm}
        </summary>
        ${wif}
      </details>`;
    })
    .join("");

  const moreText =
    failing.length > 50
      ? `<div class="show-all">Showing 50 of ${failing.length} failing conversations · <a href="https://converra.ai">View all in Converra</a></div>`
      : "";

  return `<div class="convs">
    <div class="stitle">All failing conversations</div>
    ${convHtml}
    ${moreText}
  </div>`;
}

function renderReproducibility(report: Report): string {
  return `<div class="repro">
    <div class="repro-header">${ICONS.terminal} How this report was generated</div>
    <div class="repro-body">
      <code class="repro-cmd">converra-triage analyze --traces [source] --model ${esc(report.llmModel)}</code>
      <button class="repro-copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">${ICONS.copy} Copy</button>
    </div>
    <div class="repro-meta">converra-triage v${report.converraTriageVersion} · ${report.policies.length} policies · ${report.totalConversations} conversations</div>
  </div>`;
}

function renderFooter(): string {
  return `<div class="ftr">
  <div class="ftr-brand">
    <div class="ftr-mark">${ICONS.check}</div>
    <span class="ftr-text">Powered by <a href="https://converra.ai" class="ftr-name">Converra</a></span>
  </div>
  <div class="ftr-tag">This report diagnoses problems. Converra treats them — generates prompt patches, simulates against all policies, and deploys without regressions.</div>
  <a class="ftr-cta" href="https://converra.ai">See how Converra works ${ICONS.externalSm}</a>
  <div class="helpful">
    Was this report useful?
    <button class="hbtn">${ICONS.thumbUp}</button>
    <button class="hbtn">${ICONS.thumbDown}</button>
  </div>
</div>`;
}

// ── Helpers ──

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function avgMetrics(m: Record<string, number>): number {
  const vals = Object.values(m);
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function formatFailureType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatSubtype(subtype: string): string {
  return subtype
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Inline SVG Icons ──

const ICONS = {
  check: '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3.5 7.5l2.5 2.5 4.5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  checkCircle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  checkCircleSm: '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  checkCircleSm2: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  checkAll: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  alertTriangle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  alertTriangleSm: '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  chevDown: '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  chevDownLg: '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  chevDownSm: '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  chevRight: '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  external: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  externalSm: '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  lock: '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
  code: '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  terminal: '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  copy: '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
  fileSm: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  thumbUp: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>',
  thumbDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15V19a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z"/><path d="M17 2h3a2 2 0 012 2v7a2 2 0 01-2 2h-3"/></svg>',
};

// ── Inlined CSS (from mockup) ──

const CSS = `
:root {
  --coral: #ED7B65;
  --coral-dark: #D4624D;
  --coral-50: rgba(237,123,101,0.06);
  --coral-border: rgba(237,123,101,0.22);
  --emerald: #4FA397;
  --emerald-50: rgba(79,163,151,0.06);
  --emerald-border: rgba(79,163,151,0.22);
  --bg: #FFFFFF;
  --bg-subtle: #F8F9FB;
  --bg-warm: #FDFAF8;
  --border: #E5E7EB;
  --border-subtle: #F0F1F3;
  --text: #1A1D23;
  --text-2: #5A6070;
  --text-3: #6B7280;
  --red: #E5534B;
  --red-bg: rgba(229,83,75,0.06);
  --red-border: rgba(229,83,75,0.18);
  --amber: #D4963A;
  --amber-bg: rgba(212,150,58,0.06);
  --amber-border: rgba(212,150,58,0.18);
  --green: #2EA043;
  --green-bg: rgba(46,160,67,0.06);
  --green-border: rgba(46,160,67,0.18);
  --blue: #388BFD;
  --violet: #8B7EC8;
  --r: 8px;
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04);
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; background:var(--bg-subtle); color:var(--text); line-height:1.6; font-size:14px; }
h1,h2,h3 { font-family:'Space Grotesk',system-ui,sans-serif; }
.page { max-width:1060px; margin:0 auto; padding:0 24px; background:var(--bg); min-height:100vh; }
svg.ic { width:14px; height:14px; vertical-align:-2px; }
svg.ic-s { width:12px; height:12px; vertical-align:-1px; }
details summary { list-style:none; cursor:pointer; }
details summary::-webkit-details-marker { display:none; }
details summary::marker { content:''; }
.chev { color:var(--text-3); flex-shrink:0; transition:transform 0.2s; }
details[open] > summary .chev { transform:rotate(180deg); }
.hdr { padding:24px 0 16px; border-bottom:1px solid var(--border); }
.hdr-top { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
.logo { width:22px; height:22px; background:var(--coral); border-radius:5px; display:flex; align-items:center; justify-content:center; }
.tool-name { font-family:'Space Grotesk',sans-serif; font-size:13px; color:var(--text-3); font-weight:500; }
.tool-name b { color:var(--coral); font-weight:600; }
.hdr h1 { font-size:22px; font-weight:700; letter-spacing:-0.02em; margin-bottom:2px; }
.hdr-desc { font-size:13px; color:var(--text-2); margin-bottom:8px; }
.hdr-meta { display:flex; gap:16px; font-size:12px; color:var(--text-3); flex-wrap:wrap; }
.hdr-meta span { color:var(--text-2); font-weight:500; }
.pipeline { padding:20px 0 16px; }
.pipe-steps { display:flex; align-items:stretch; gap:2px; }
.pipe-step { flex:1; background:var(--bg-subtle); border:1px solid var(--border-subtle); border-radius:var(--r); padding:14px 8px; text-align:center; position:relative; }
.pipe-step:not(:last-child) { margin-right:16px; }
.pipe-step:not(:last-child)::after { content:''; position:absolute; right:-12px; top:50%; transform:translateY(-50%); width:0; height:0; border-top:8px solid transparent; border-bottom:8px solid transparent; border-left:8px solid var(--border); }
.pipe-num { font-family:'Space Grotesk',sans-serif; font-size:24px; font-weight:700; line-height:1; margin-bottom:4px; }
.pipe-num.coral { color:var(--coral); }
.pipe-num.red { color:var(--red); }
.pipe-num.emerald { color:var(--emerald); }
.pipe-label { font-size:11px; color:var(--text-3); line-height:1.3; }
.pipe-label b { color:var(--text-2); font-weight:600; }
.verdict { display:flex; align-items:flex-start; gap:14px; padding:14px 18px; background:var(--red-bg); border:1px solid var(--red-border); border-radius:var(--r); box-shadow:var(--shadow-sm); margin-bottom:4px; }
.verdict-icon { flex-shrink:0; color:var(--red); margin-top:1px; }
.verdict-text { font-size:14px; font-weight:600; color:var(--text); font-family:'Space Grotesk',sans-serif; margin-bottom:2px; }
.verdict-detail { font-size:13px; color:var(--text-2); }
.stitle { font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.1em; color:var(--text-3); margin-bottom:10px; }
.type-badge { font-size:11px; font-weight:600; padding:2px 10px; border-radius:20px; display:inline-flex; align-items:center; gap:4px; }
.type-badge.prompt { background:var(--coral-50); color:var(--coral); border:1px solid var(--coral-border); }
.type-badge.orch { background:var(--amber-bg); color:var(--amber); border:1px solid var(--amber-border); }
.type-badge.model { background:var(--bg-subtle); color:var(--text-2); border:1px solid var(--border); }
.sev-badge { font-size:11px; font-weight:600; padding:1px 8px; border-radius:20px; }
.sev-badge.crit { background:var(--red-bg); color:var(--red); border:1px solid var(--red-border); }
.sev-badge.major { background:var(--amber-bg); color:var(--amber); border:1px solid var(--amber-border); }
.patterns { padding:20px 0 8px; }
.group-label { font-family:'Space Grotesk',sans-serif; font-size:12px; font-weight:600; padding:8px 0 4px; display:flex; align-items:center; gap:10px; }
.group-label .gl-line { flex:1; height:1px; background:var(--border-subtle); }
.group-label.fixable { color:var(--emerald); }
.group-label.needs-code { color:var(--text-3); margin-top:12px; }
.pattern { border-bottom:1px solid var(--border-subtle); }
.pattern:last-child { border-bottom:none; }
.pattern > summary { display:flex; align-items:center; gap:10px; padding:12px 12px; margin:0 -12px; flex-wrap:wrap; border-radius:4px; }
.pattern > summary:hover { background:var(--bg-subtle); }
.pattern-count { font-family:'Space Grotesk',sans-serif; font-size:15px; font-weight:700; }
.critical-tag { font-size:12px; color:var(--red); font-weight:500; display:flex; align-items:center; gap:4px; }
.fix-btn { font-size:12px; font-weight:600; color:#fff; background:var(--coral); border:1px solid var(--coral); border-radius:var(--r); padding:5px 12px; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:5px; transition:all 0.15s; }
.fix-btn:hover { background:var(--coral-dark); border-color:var(--coral-dark); }
.pattern-body { padding:0 0 12px 0; }
.subtypes { display:flex; gap:14px; flex-wrap:wrap; padding:0 2px 10px; }
.subtype { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text-2); }
.sdot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
.sdot.ctx { background:var(--violet); }
.pattern-convs { background:var(--bg-subtle); border-radius:var(--r); padding:10px 14px; }
.pattern-convs-label { font-size:11px; font-weight:600; color:var(--text-3); text-transform:uppercase; letter-spacing:0.06em; margin-bottom:6px; }
.mini-row { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border-subtle); font-size:12px; }
.mini-row:last-child { border-bottom:none; }
.mini-id { font-family:'SF Mono','Fira Code',monospace; color:var(--text-3); font-weight:600; min-width:68px; }
.mini-cause { color:var(--text-2); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mini-link { color:var(--coral); font-size:11px; font-weight:600; text-decoration:none; white-space:nowrap; cursor:pointer; display:flex; align-items:center; gap:3px; background:none; border:none; padding:0; font-family:inherit; }
.mini-link:hover { text-decoration:underline; }
.conv-detail.highlight { animation: flash 1.5s ease; }
@keyframes flash { 0%,100% { background:transparent; } 15% { background:var(--coral-50); } }
.trust-note { font-size:11px; color:var(--text-3); padding:8px 0 0; display:flex; align-items:center; gap:5px; }
.recs { padding:20px 0; border-top:1px solid var(--border); }
.rec-card { border:1px solid var(--border-subtle); border-radius:var(--r); margin-bottom:6px; overflow:hidden; }
.rec-card > summary { padding:10px 12px; display:flex; align-items:flex-start; gap:8px; }
.rec-card > summary:hover { background:var(--bg-subtle); }
.rec-num { font-family:'Space Grotesk',sans-serif; font-size:12px; font-weight:700; color:var(--coral); flex-shrink:0; }
.rec-main { flex:1; }
.rec-title { font-size:13px; font-weight:600; color:var(--text); }
.rec-meta { font-size:11px; color:var(--text-3); margin-top:2px; }
.rec-meta .fix-target { color:var(--coral); font-weight:500; }
.rec-detail { padding:0 12px 12px 28px; }
.rec-desc { font-size:13px; color:var(--text-2); line-height:1.6; }
.cta { display:inline-flex; align-items:center; gap:6px; background:var(--coral); color:#fff; border:none; border-radius:var(--r); padding:8px 16px; font-size:13px; font-weight:600; font-family:'Space Grotesk',sans-serif; cursor:pointer; text-decoration:none; transition:all 0.15s; }
.cta:hover { background:var(--coral-dark); transform:translateY(-1px); box-shadow:0 4px 12px rgba(237,123,101,0.2); }
.next-step { border:1px solid var(--coral-border); border-radius:var(--r); margin:20px 0; overflow:hidden; background:var(--coral-50); }
.next-step-header { padding:10px 14px; background:var(--bg); border-bottom:1px solid var(--coral-border); font-family:'Space Grotesk',sans-serif; font-size:12px; font-weight:600; color:var(--text-2); display:flex; align-items:center; gap:8px; }
.next-step-body { padding:14px 14px 8px; display:flex; flex-direction:column; gap:10px; }
.next-step-item { font-size:13px; color:var(--text); display:flex; align-items:center; gap:8px; }
.next-step-item svg { color:var(--coral); flex-shrink:0; }
.next-step-footer { padding:8px 14px 14px; display:flex; justify-content:center; }
.diag { border:1px solid var(--border); border-radius:var(--r); margin:20px 0; overflow:hidden; box-shadow:var(--shadow-md); }
.diag > summary { padding:16px 18px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.diag > summary:hover { background:var(--bg-subtle); }
.diag > summary h2 { font-size:15px; font-weight:700; margin-bottom:2px; }
.diag-sub { font-size:13px; color:var(--text-2); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.diag-badges { display:flex; gap:6px; margin-top:5px; align-items:center; }
.diag-b { font-size:11px; font-weight:500; padding:2px 10px; border-radius:20px; }
.diag-b.type { background:var(--coral-50); color:var(--coral); border:1px solid var(--coral-border); }
.conf { color:var(--text-3); font-size:12px; }
.tl { padding:14px 18px; border-top:1px solid var(--border-subtle); }
.tl-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.tl-label { font-family:'Space Grotesk',sans-serif; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.1em; color:var(--text-3); }
.tl-filter { font-size:11px; color:var(--text-3); }
.turn { display:flex; gap:12px; padding:4px 0; position:relative; }
.turn:not(:last-child)::before { content:''; position:absolute; left:5px; top:20px; bottom:-2px; width:1px; background:var(--border); }
.tdot { width:11px; height:11px; border-radius:50%; flex-shrink:0; margin-top:5px; }
.tdot.p { background:var(--emerald); }
.tdot.f { background:var(--red); }
.tdot.w { background:var(--amber); }
.tc { flex:1; }
.tc-label { font-size:13px; font-weight:600; margin-bottom:1px; }
.tc-text { font-size:13px; color:var(--text-2); line-height:1.5; }
.tc-badges { display:flex; gap:5px; margin-top:4px; flex-wrap:wrap; }
.tb { font-size:11px; padding:1px 8px; border-radius:20px; font-weight:500; }
.tb.f { background:var(--red-bg); color:var(--red); border:1px solid var(--red-border); }
.tb.p { background:var(--green-bg); color:var(--green); border:1px solid var(--green-border); }
.wif { margin:10px 18px 14px; background:var(--bg-warm); border:1px solid var(--border-subtle); border-radius:var(--r); padding:16px; }
.wif-s { margin-bottom:8px; }
.wif-s:last-child { margin-bottom:0; }
.wif-l { font-size:13px; font-weight:700; margin-bottom:2px; }
.wif-l.impact { color:var(--amber); }
.wif-l.fix { color:var(--emerald); }
.wif-t { font-size:13px; color:var(--text-2); line-height:1.6; }
.wif-conf { font-size:12px; color:var(--text-3); }
.blast { background:var(--amber-bg); border:1px solid var(--amber-border); border-radius:var(--r); padding:10px 14px; font-size:13px; color:var(--text-2); line-height:1.5; margin:0 18px; display:flex; gap:8px; align-items:flex-start; }
.blast-icon { color:var(--amber); flex-shrink:0; margin-top:1px; }
.blast strong { color:var(--amber); }
.diag-cta { padding:12px 18px; display:flex; align-items:center; gap:10px; }
.diag-link { color:var(--coral); font-size:13px; font-weight:600; text-decoration:none; display:inline-flex; align-items:center; gap:5px; }
.diag-link:hover { text-decoration:underline; }
.metrics-bar { display:flex; gap:0; border:1px solid var(--border); border-radius:var(--r); overflow:hidden; margin-bottom:20px; }
.mb-cell { flex:1; padding:10px 12px; border-right:1px solid var(--border-subtle); text-align:center; min-width:0; }
.mb-cell:last-child { border-right:none; }
.mb-label { font-size:10px; color:var(--text-3); text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mb-val { font-family:'Space Grotesk',sans-serif; font-size:18px; font-weight:700; letter-spacing:-0.02em; }
.mb-val.green { color:var(--green); }
.mb-val.amber { color:var(--amber); }
.mb-val.red { color:var(--red); }
.convs { padding:0 0 20px; }
.conv-detail { border-bottom:1px solid var(--border-subtle); }
.conv-detail > summary { display:flex; align-items:center; gap:8px; padding:8px 8px; margin:0 -8px; border-radius:4px; }
.conv-detail > summary:hover { background:var(--bg-subtle); }
.cid { font-size:12px; font-weight:600; font-family:'SF Mono','Fira Code',monospace; color:var(--text-3); min-width:68px; }
.conv-cause { font-size:12px; color:var(--text-2); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conv-expand { padding:8px 14px 14px; margin-left:80px; }
.conv-expand .wif { margin:0; }
.show-all { font-size:12px; color:var(--text-3); padding:10px 0; text-align:center; }
.show-all a { color:var(--coral); text-decoration:none; font-weight:500; }
.show-all a:hover { text-decoration:underline; }
.repro { border:1px solid var(--border); border-radius:var(--r); margin-bottom:20px; overflow:hidden; }
.repro-header { padding:8px 14px; background:var(--bg-subtle); border-bottom:1px solid var(--border-subtle); font-size:11px; font-weight:600; color:var(--text-3); text-transform:uppercase; letter-spacing:0.06em; display:flex; align-items:center; gap:6px; }
.repro-body { padding:10px 14px; font-family:'SF Mono','Fira Code','Consolas',monospace; font-size:12px; color:var(--text-2); line-height:1.5; display:flex; align-items:center; justify-content:space-between; }
.repro-cmd { flex:1; }
.repro-copy { font-size:11px; color:var(--text-3); cursor:pointer; background:none; border:1px solid var(--border); border-radius:4px; padding:3px 8px; display:flex; align-items:center; gap:4px; transition:all 0.15s; }
.repro-copy:hover { border-color:var(--text-3); color:var(--text-2); }
.repro-meta { padding:0 14px 8px; font-size:11px; color:var(--text-3); }
.ftr { border-top:1px solid var(--border); padding:28px 0; text-align:center; }
.ftr-brand { display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:6px; }
.ftr-mark { width:20px; height:20px; background:var(--coral); border-radius:4px; display:flex; align-items:center; justify-content:center; }
.ftr-text { font-size:13px; color:var(--text-3); }
.ftr-name { font-family:'Space Grotesk',sans-serif; font-weight:700; color:var(--coral); text-decoration:none; }
.ftr-name:hover { color:var(--coral-dark); }
.ftr-tag { font-size:12px; color:var(--text-3); margin-bottom:12px; max-width:380px; margin-left:auto; margin-right:auto; line-height:1.5; }
.ftr-cta { display:inline-flex; align-items:center; gap:6px; color:var(--coral); text-decoration:none; font-family:'Space Grotesk',sans-serif; font-size:13px; font-weight:600; padding:8px 16px; border:1px solid var(--coral-border); border-radius:var(--r); transition:all 0.15s; }
.ftr-cta:hover { background:var(--coral-50); border-color:var(--coral); }
.helpful { display:flex; align-items:center; justify-content:center; gap:10px; margin-top:14px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-3); }
.hbtn { width:28px; height:28px; border:1px solid var(--border); border-radius:5px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:var(--bg); color:var(--text-3); transition:all 0.15s; }
.hbtn:hover { border-color:var(--coral-border); color:var(--coral); }
@media(max-width:768px) {
  .page { padding:0 12px; }
  .pipe-steps { flex-wrap:wrap; gap:6px; }
  .pipe-step { flex:none; width:calc(33.33% - 4px); margin-right:0!important; }
  .pipe-step::after { display:none; }
  .metrics-bar { flex-wrap:wrap; }
  .mb-cell { flex:none; width:33.33%; }
  .conv-expand { margin-left:0; }
  .rec-detail { padding:0 12px 12px 12px; }
  .mini-cause { white-space:normal; }
}
`;

// ── Inlined JS ──

const JS = `
function viewConv(e, btn) {
  e.stopPropagation();
  e.preventDefault();
  var id = btn.getAttribute('data-conv-id');
  if (!id) return;
  var el = document.getElementById(id);
  if (!el) return;
  el.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('highlight');
  void el.offsetWidth;
  el.classList.add('highlight');
}
`;
