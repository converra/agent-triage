import type { Report } from "../evaluation/types.js";
import { buildConversationFixMd, buildPatternFixMd, buildRecommendationFixMd } from "./fix-instructions.js";
import {
  avgMetrics,
  buildConvAgentMap,
  conversationHealth,
  describeWeakMetrics,
  esc,
  escBold,
  formatFailureType,
  formatSubtype,
  stripHtml,
} from "./helpers.js";
import { ICONS } from "./styles.js";

export function renderHeader(report: Report, date: string, duration: string): string {
  const agentCount = report.agents?.length ?? 0;
  const autoName = report.agents?.[0]?.name;
  const agentName = autoName && autoName !== "Unknown Agent" ? autoName : report.agent.name;
  const headerTitle = agentCount > 1
    ? `${agentCount} Agents Analyzed`
    : esc(agentName !== "AI Agent" ? agentName : `${report.totalConversations} Conversations Analyzed`);

  return `<div class="hdr">
    <div class="hdr-top">
      <div class="logo">${ICONS.check}</div>
      <div class="tool-name"><b>agent</b>-triage</div>
      <span class="hdr-by">by <a href="https://converra.ai" class="hdr-by-link">Converra</a></span>
    </div>
    <h1>${headerTitle}</h1>
    <div class="hdr-desc">Evaluated ${report.totalConversations} production conversations${agentCount > 1 ? ` across ${agentCount} agents` : ""} with ${Object.keys(report.metricSummary).length} quality metrics and step-level diagnosis.</div>
    <div class="hdr-meta">
      Model <span>${esc(report.llmModel)}</span> &middot;
      Cost <span>$${report.cost.estimatedCost.toFixed(2)}</span> &middot;
      Duration <span>${duration}</span> &middot;
      <span>${date}</span>
    </div>
  </div>`;
}

export function renderHealthSummary(
  report: Report,
  healthy: number,
  needsAttention: number,
  critical: number,
): string {
  const total = report.totalConversations;
  const issues = needsAttention + critical;

  const counts = `<div class="pipe-steps">
    <div class="pipe-step"><div class="pipe-num">${total}</div><div class="pipe-label"><b>Conversations</b><br>evaluated</div></div>
    <div class="pipe-step"><div class="pipe-num emerald">${healthy}</div><div class="pipe-label"><b>Healthy</b><br>no issues</div></div>
    <div class="pipe-step"><div class="pipe-num coral">${needsAttention}</div><div class="pipe-label"><b>Need attention</b><br>low scores or failures</div></div>
    <div class="pipe-step"><div class="pipe-num red">${critical}</div><div class="pipe-label"><b>Critical</b><br>score below 50</div></div>
  </div>`;

  if (issues === 0) {
    return `<div class="health-summary">${counts}
      <div class="verdict" style="background:var(--green-bg);border-color:var(--green-border);margin-top:16px;">
        <div class="verdict-icon" style="color:var(--green);">${ICONS.checkCircle}</div>
        <div><div class="verdict-text">All ${total} conversations are healthy.</div><div class="verdict-detail">Quality scores above 75 and no policy failures.</div></div>
      </div>
    </div>`;
  }

  const promptFixable = report.failurePatterns.byType.filter((t) => t.type === "prompt_issue" || t.type === "retrieval_rag_issue").reduce((s, t) => s + t.count, 0);
  const needsCode = report.failurePatterns.byType.filter((t) => t.type === "orchestration_issue" || t.type === "model_limitation").reduce((s, t) => s + t.count, 0);
  let detail = `${issues} conversations scored below 75 or have policy failures.`;
  if (promptFixable > 0 && needsCode > 0) detail = `${promptFixable} root causes fixable via prompt changes, ${needsCode} need code changes.`;
  else if (promptFixable > 0) detail = "Root causes are fixable via prompt changes.";

  // Bright spot: count passing rules
  const evaluated = report.policies.filter((p) => p.evaluated > 0);
  const passingRules = evaluated.filter((p) => p.failing === 0).length;
  const brightSpot = passingRules > 0
    ? `<div class="verdict-detail" style="margin-top:2px;color:var(--text-3);">${passingRules} behavioral rule${passingRules !== 1 ? "s" : ""} passing at 100%.</div>`
    : "";

  const isAmber = critical === 0;
  const verdictStyle = isAmber
    ? `background:var(--amber-bg);border-color:var(--amber-border);margin-top:16px;`
    : `margin-top:16px;`;
  const iconStyle = isAmber ? ` style="color:var(--amber);"` : "";
  const ctaClass = isAmber ? ` style="color:var(--amber);border-color:var(--amber-border);"` : "";

  return `<div class="health-summary">${counts}
    <div class="verdict" style="${verdictStyle}">
      <div class="verdict-icon"${iconStyle}>${ICONS.alertTriangle}</div>
      <div class="verdict-body">
        <div class="verdict-text">${issues} of ${total} conversations have issues${critical > 0 ? ` — ${critical} critical` : ""}.</div>
        <div class="verdict-detail">${detail}</div>
        ${brightSpot}
      </div>
      <a href="#diagnosis" class="verdict-cta"${ctaClass} onclick="document.querySelector('.convs')?.scrollIntoView({behavior:'smooth',block:'start'});return false;">See diagnosis ${ICONS.chevDownSm}</a>
    </div>
  </div>`;
}

export function renderMetricsBar(report: Report): string {
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

  return `<details class="section-collapse">
  <summary><div class="stitle" style="margin:0;">Quality metrics (averages)</div>${ICONS.chevDown}</summary>
  <div class="metrics-bar">${cells.join("")}</div>
  </details>`;
}
export function renderAgentHealth(report: Report): string {
  if (!report.agents || report.agents.length <= 1) return "";

  const cards = report.agents
    .map((agent) => {
      const color = agent.compliance >= 80 ? "green" : agent.compliance >= 60 ? "amber" : "red";
      const topFailing = agent.topFailingPolicies
        .map((p) => `<div class="agent-fail">${esc(p.name)} <span class="${p.complianceRate < 50 ? "red" : "amber"}">${p.complianceRate}%</span></div>`)
        .join("");

      return `<div class="agent-card">
        <div class="agent-name">${esc(agent.name)}</div>
        <div class="agent-stats">
          <div class="agent-stat"><span class="agent-stat-num">${agent.conversationCount}</span> conversations</div>
          <div class="agent-stat"><span class="agent-stat-num ${color}">${agent.compliance}%</span> rule compliance</div>
        </div>
        ${topFailing ? `<div class="agent-fails"><div class="agent-fails-label">Top issues</div>${topFailing}</div>` : ""}
      </div>`;
    })
    .join("");

  return `<details class="section-collapse">
    <summary><div class="stitle" style="margin:0;">Agent health</div>${ICONS.chevDown}</summary>
    <div class="agents-section"><div class="agents-grid">${cards}</div></div>
  </details>`;
}


/** Detect raw JSON / structured routing data and return a short summary instead. */
function summarizeTurnContent(text: string): string {
  const trimmed = text.trim();

  // Detect JSON objects or arrays — these are internal routing data, not user-facing content
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "[Routing decision]";
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Truncate long text
  if (trimmed.length > 200) return trimmed.slice(0, 200) + "...";
  return trimmed;
}

/** Find the orchestrator/router agent name from policy metadata, if one exists. */
function findOrchestratorName(report: Report): string | undefined {
  const sourceAgents = [...new Set(report.policies.map((p) => p.sourceAgent).filter(Boolean))];
  return sourceAgents.find((a) => /orchestrat|router|coordinator|dispatch/i.test(a!)) as string | undefined;
}

function buildTurnTimeline(
  conv: Report["conversations"][0],
  report: Report,
  cascadeMap: Map<number, string>,
  fixMd?: string,
): string[] {
  const d = conv.diagnosis!;
  const orchestrator = findOrchestratorName(report);
  let lastAgent: string | undefined;

  const visible = conv.messages.filter((m) => m.role === "user" || m.role === "assistant");

  return visible.map((msg, i) => {
      const turnNum = i + 1;
      const isRoot = turnNum === d.rootCauseTurn;
      const isFailing = conv.policyResults.some((pr) => !pr.passed && pr.failingTurns?.includes(turnNum));
      const isCascade = !isRoot && !isFailing && turnNum > d.rootCauseTurn;
      const dotClass = isRoot || isFailing ? "f" : isCascade ? "w" : "p";
      const isUser = msg.role === "user";

      // Policy badges on all failing turns — show first 2 inline, rest in expandable tooltip
      let failBadges = "";
      let fixCta = "";
      const failingPolicies = (isRoot || isFailing)
        ? conv.policyResults.filter((pr) => !pr.passed && pr.failingTurns?.includes(turnNum))
        : [];
      if (failingPolicies.length > 0) {
        const MAX_INLINE = isRoot ? 3 : 2;
        const shownPolicies = failingPolicies.slice(0, MAX_INLINE);
        const overflowCount = failingPolicies.length - MAX_INLINE;
        const overflowPolicies = failingPolicies.slice(MAX_INLINE);
        failBadges = shownPolicies
          .map((pr) => {
            const policy = report.policies.find((p) => p.id === pr.policyId);
            return `<span class="tb f">${esc(policy?.name ?? pr.policyId)} ×</span>`;
          })
          .join("");
        if (overflowCount > 0) {
          const hiddenBadges = overflowPolicies
            .map((pr) => {
              const policy = report.policies.find((p) => p.id === pr.policyId);
              return `<span class="tb f">${esc(policy?.name ?? pr.policyId)} ×</span>`;
            })
            .join("");
          failBadges += `<span class="tb f tb-more" onclick="this.nextElementSibling.classList.toggle('show');this.remove()">+${overflowCount} more</span><span class="tb-overflow">${hiddenBadges}</span>`;
        }
        if (isRoot && fixMd) {
          fixCta = `<button class="copy-btn" style="padding:2px 8px;font-size:11px;" data-fix="${fixMd}" onclick="copyFix(this)">${ICONS.copy} Copy fix</button>`;
        }
      }

      // Routing chain: show on first assistant turn, then only when agent changes
      let agentTag = "";
      if (isUser) {
        agentTag = `<span class="agent-badge user">User</span>`;
      } else if (msg.agent) {
        const agentChanged = msg.agent !== lastAgent;
        if (agentChanged) {
          if (orchestrator && msg.agent !== orchestrator) {
            agentTag = `<span class="agent-badge subtle">${esc(orchestrator)}</span><span class="agent-arrow">→</span><span class="agent-badge">${esc(msg.agent)}</span>`;
          } else {
            agentTag = `<span class="agent-badge">${esc(msg.agent)}</span>`;
          }
        }
        lastAgent = msg.agent;
      }

      const stepLabel = `<span class="step-num">Step ${turnNum}</span>`;
      const rcTag = isRoot ? `<span class="rc-label">root cause</span>` : "";
      const cascadeDesc = cascadeMap.get(turnNum);
      const plain = stripHtml(msg.content);
      const content = summarizeTurnContent(plain);
      const diagNote = cascadeDesc ? `<div class="tc-diag">↳ ${escBold(cascadeDesc)}</div>` : "";
      const turnClass = isUser ? "turn turn-user" : "turn";

      return `<div class="${turnClass}"><div class="tdot ${dotClass}"></div><div class="tc"><div class="tc-label">${stepLabel}${agentTag}${rcTag}</div><div class="tc-text">${escBold(content)}</div>${diagNote}${failBadges || fixCta ? `<div class="tc-badges">${failBadges}${fixCta}</div>` : ""}</div></div>`;
    });
}

function buildMetricBadges(metrics: Record<string, number>): string {
  return [
    { key: "successScore", label: "Success" },
    { key: "aiRelevancy", label: "Relevancy" },
    { key: "sentiment", label: "Sentiment" },
    { key: "clarity", label: "Clarity" },
  ].map((m) => {
    const val = metrics[m.key] ?? 0;
    const color = val >= 80 ? "green" : val >= 60 ? "amber" : "red";
    return `<span class="metric-pill ${color}">${m.label} ${val}</span>`;
  }).join("");
}

export function renderAllConversations(
  issues: Report["conversations"],
  report: Report,
): string {
  if (issues.length === 0) return "";

  const convAgentMap = buildConvAgentMap(report);
  const shown = issues.slice(0, 50);

  const convHtml = shown
    .map((c, index) => {
      const avg = Math.round(avgMetrics(c.metrics));
      const failures = c.policyResults.filter((pr) => !pr.passed).length;
      const health = conversationHealth(c.metrics, failures);
      const healthClass = health === "critical" ? "crit" : "major";
      const d = c.diagnosis;
      const cause = d?.summary ?? describeWeakMetrics(c.metrics as Record<string, number>);
      const agentName = convAgentMap.get(c.id);
      const agentBadge = agentName && (report.agents?.length ?? 0) > 1
        ? `<span class="agent-badge">${esc(agentName)}</span>`
        : "";

      // Metric mini-pills
      const pills = [
        { key: "successScore" },
        { key: "sentiment" },
        { key: "clarity" },
      ].map((m) => {
        const val = (c.metrics as Record<string, number>)[m.key] ?? 0;
        const color = val >= 80 ? "green" : val >= 60 ? "amber" : "red";
        return `<span class="metric-mini ${color}">${val}</span>`;
      }).join("");

      // First conversation gets full step analysis (expanded), rest get compact view
      const isFirst = index === 0;
      const expand = d ? renderConvDive(c, d, report, isFirst) : "";

      return `<details class="conv-detail" id="${esc(c.id)}"${isFirst ? " open" : ""}>
        <summary>
          <span class="cid">${esc(c.id.slice(0, 10))}</span>
          ${agentBadge}
          <span class="conv-score ${healthClass}">${avg}</span>
          <span class="conv-cause">${escBold(cause)}</span>
          <span class="conv-pills">${pills}</span>
          <span class="sev-badge ${healthClass}">${health === "critical" ? "critical" : "attention"}</span>
          ${ICONS.chevDownSm}
        </summary>
        ${expand}
      </details>`;
    })
    .join("");

  const moreText =
    issues.length > 50
      ? `<div class="show-all">Showing 50 of ${issues.length} conversations with issues</div>`
      : "";

  const colHeader = `<div class="conv-colhdr">
    <span class="colhdr-id">ID</span>
    <span class="colhdr-score">Score</span>
    <span class="colhdr-cause">Diagnosis</span>
    <span class="colhdr-metrics"><span>Success</span><span>Sentiment</span><span>Clarity</span></span>
  </div>`;

  return `<div class="convs">
    <div class="stitle">Step analysis</div>
    ${colHeader}
    ${convHtml}
    ${moreText}
  </div>`;
}

function renderConvDive(
  conv: Report["conversations"][0],
  d: NonNullable<Report["conversations"][0]["diagnosis"]>,
  report: Report,
  isFirst = false,
): string {
  const cascadeMap = new Map<number, string>();
  for (const entry of d.cascadeChain) {
    const match = entry.match(/^Turn\s+(\d+)\s*:\s*(.+)$/i);
    if (match) cascadeMap.set(Number(match[1]), match[2]!.trim());
  }

  const fixMd = btoa(unescape(encodeURIComponent(buildConversationFixMd(conv, report))));
  const maxTurns = isFirst ? 8 : 6;
  const turns = buildTurnTimeline(conv, report, cascadeMap, fixMd).slice(0, maxTurns);

  const blastHtml = isFirst && d.blastRadius.length > 0
    ? `<div class="blast"><span class="blast-icon">${ICONS.alertTriangleSm}</span><span><strong>Blast radius:</strong> Editing may affect ${d.blastRadius.map((r) => `<em>${esc(r)}</em>`).join(", ")}.</span></div>`
    : "";

  const converraLink = isFirst
    ? `<a href="https://converra.ai" class="diag-link">Test with Converra ${ICONS.externalSm}</a>`
    : "";

  return `<div class="conv-expand">
    <div class="tl">
      <div class="tl-header"><div class="tl-label">Turn Timeline</div><div class="tl-filter">${turns.length} of ${conv.messages.length} turns</div></div>
      ${turns.join("")}
    </div>
    <div class="wif">
      <div class="wif-s"><div class="wif-l">What happened</div><div class="wif-t">${escBold(d.summary)}</div></div>
      <div class="wif-s"><div class="wif-l impact">Impact</div><div class="wif-t">${escBold(d.impact)}</div></div>
      <div class="wif-s"><div class="wif-l fix">Fix</div><div class="wif-t">${escBold(d.fix)} <span class="wif-conf">(${d.confidence} confidence)</span></div></div>
    </div>
    ${blastHtml}
    <div class="diag-cta">
      <button class="copy-btn" data-fix="${fixMd}" onclick="copyFix(this)">${ICONS.copy} Copy fix instructions</button>
      <button class="copy-btn" data-fix="${fixMd}" onclick="downloadFix(this, 'fix-${esc(conv.id.slice(0, 10))}')">${ICONS.fileSm} Download .md</button>
      ${converraLink}
    </div>
  </div>`;
}

export function renderFailurePatterns(report: Report): string {
  if (report.failurePatterns.byType.length === 0) return "";

  const fixable = report.failurePatterns.byType.filter(
    (t) => t.type === "prompt_issue" || t.type === "retrieval_rag_issue",
  );
  const needsCode = report.failurePatterns.byType.filter(
    (t) => t.type === "orchestration_issue" || t.type === "model_limitation",
  );

  let html = `<div class="patterns"><div class="stitle">Root cause analysis</div>`;

  if (fixable.length > 0) {
    html += `<div class="group-label fixable">${ICONS.checkCircleSm} Fixable — prompt &amp; config <span class="gl-line"></span></div>`;
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

  html += `<div class="trust-note">${ICONS.lock} This report is local-only. No data was uploaded.</div>`;
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
      const cause = c.diagnosis?.summary ?? "Quality issue detected";
      return `<div class="mini-row"><span class="mini-id">${esc(c.id.slice(0, 10))}</span><span class="mini-cause">${escBold(cause)}</span><span class="sev-badge ${sevClass}">${severity}</span><button class="mini-link" data-conv-id="${esc(c.id)}" onclick="viewConv(event, this)">View ${ICONS.chevRight}</button></div>`;
    })
    .join("");

  const criticalTag =
    pattern.criticalCount > 0
      ? `<span class="critical-tag">${ICONS.alertTriangleSm} ${pattern.criticalCount} critical</span>`
      : "";

  const patternMd = btoa(unescape(encodeURIComponent(buildPatternFixMd(pattern, affected))));

  return `<details class="pattern">
    <summary>
      <span class="type-badge ${typeClass}">${label}</span>
      <span class="pattern-count">${pattern.count}</span>
      ${criticalTag}
      ${ICONS.chevDown}
    </summary>
    <div class="pattern-body">
      <div class="subtypes">${subtypesHtml}</div>
      ${convRows ? `<div class="pattern-convs"><div class="pattern-convs-label">Top affected conversations</div>${convRows}</div>` : ""}
      <div class="rec-actions" style="margin-top:12px;">
        <button class="copy-btn" data-fix="${patternMd}" onclick="copyFix(this)">${ICONS.copy} Copy fix instructions</button>
        <button class="copy-btn" data-fix="${patternMd}" onclick="downloadFix(this, 'fix-${esc(pattern.type)}')">${ICONS.fileSm} Download .md</button>
      </div>
    </div>
  </details>`;
}

function buildFullFixMd(report: Report): string {
  const lines: string[] = [];
  const agent = report.agents?.[0]?.name ?? report.agent.name;
  const issues = report.conversations.filter((c) => c.diagnosis);

  lines.push(`# Agent Triage — Fix Report for ${agent}`);
  lines.push(`> ${issues.length} conversations with issues · ${report.failurePatterns.topRecommendations.length} recommendations`);
  lines.push("");

  // Recommendations
  if (report.failurePatterns.topRecommendations.length > 0) {
    lines.push("---");
    lines.push("## Recommendations");
    lines.push("");
    for (const [i, rec] of report.failurePatterns.topRecommendations.entries()) {
      lines.push(`### ${i + 1}. ${rec.title}`);
      lines.push(`**Confidence:** ${rec.confidence} · **Affected:** ${rec.affectedConversations} conversations`);
      lines.push("");
      lines.push(rec.description);
      lines.push("");
    }
  }

  // Per-conversation diagnosis
  lines.push("---");
  lines.push("## Conversation Diagnoses");
  lines.push("");
  for (const conv of issues) {
    const d = conv.diagnosis!;
    lines.push(`### ${conv.id.slice(0, 10)} — ${d.severity}`);
    lines.push(`**Root cause:** Turn ${d.rootCauseTurn}${d.rootCauseAgent ? ` (${d.rootCauseAgent})` : ""} · ${formatFailureType(d.failureType)} → ${formatSubtype(d.failureSubtype)}`);
    lines.push("");
    lines.push(`**What happened:** ${d.summary}`);
    lines.push("");
    lines.push(`**Impact:** ${d.impact}`);
    lines.push("");
    lines.push(`**Fix:** ${d.fix}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by [agent-triage](https://github.com/converra/agent-triage)*");
  return lines.join("\n");
}

export function renderRecommendations(report: Report): string {
  if (report.failurePatterns.topRecommendations.length === 0) return "";

  const fullMd = btoa(unescape(encodeURIComponent(buildFullFixMd(report))));

  const cards = report.failurePatterns.topRecommendations
    .map((rec, i) => {
      const targets = [...rec.targetSubtypes, ...rec.targetFailureTypes]
        .map(formatSubtype)
        .join(", ");
      const recMd = btoa(unescape(encodeURIComponent(buildRecommendationFixMd(rec, i))));

      // Pull evidence from conversations matching this recommendation's failure types
      const evidence = report.conversations
        .filter((c) => c.diagnosis && rec.targetFailureTypes.includes(c.diagnosis.failureType))
        .slice(0, 2)
        .map((c) => `<span style="color:var(--text-3);font-size:12px;">${esc(c.id.slice(0, 10))}: ${escBold(c.diagnosis!.summary.split(".")[0]!)}</span>`)
        .join("<br>");
      const evidenceHtml = evidence ? `<div style="margin-top:8px;padding:8px 10px;background:var(--bg-subtle);border-radius:var(--r);border:1px solid var(--border-subtle);line-height:1.6;">${evidence}</div>` : "";

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
        ${evidenceHtml}
        <div class="rec-actions">
          <button class="copy-btn" data-fix="${recMd}" onclick="copyFix(this)">${ICONS.copy} Copy instructions</button>
          <button class="copy-btn" data-fix="${recMd}" onclick="downloadFix(this, 'rec-${i + 1}')">${ICONS.fileSm} Download .md</button>
        </div>
      </div>
    </details>`;
    })
    .join("");

  return `<div class="recs">
    <div class="recs-header">
      <div class="stitle" style="margin:0;">How to fix it</div>
      <div class="recs-cta">
        <button class="copy-btn primary" data-fix="${fullMd}" onclick="copyFix(this)">${ICONS.copy} Copy all fixes</button>
        <button class="copy-btn primary" data-fix="${fullMd}" onclick="downloadFix(this, 'fix-instructions')">${ICONS.fileSm} Download .md</button>
      </div>
    </div>
    ${cards}
  </div>`;
}

export function renderBehavioralRules(report: Report): string {
  if (report.policies.length === 0) return "";

  const evaluated = report.policies.filter((p) => p.evaluated > 0);
  const failing = evaluated.filter((p) => p.failing > 0).sort((a, b) => a.complianceRate - b.complianceRate);
  const passing = evaluated.filter((p) => p.failing === 0);
  const na = report.policies.filter((p) => p.evaluated === 0);

  if (failing.length === 0) {
    return `<div class="rules-section-inline">${ICONS.checkCircleSm} <span>${evaluated.length} behavioral rules evaluated — all passing.</span>${na.length > 0 ? ` <span class="rules-na-inline">${na.length} not applicable.</span>` : ""}</div>`;
  }

  const failingHtml = failing.map((p) => {
    const icon = p.complianceRate < 50 ? "red" : "amber";
    return `<div class="rule-row"><span class="rule-icon ${icon}">${p.complianceRate < 50 ? "×" : "!"}</span><span class="rule-name">${esc(p.name)}</span><span class="rule-stat ${icon}">${p.complianceRate}% (${p.failing}/${p.evaluated} failing)</span></div>`;
  }).join("");

  return `<details class="rules-section" open>
    <summary>
      <div class="stitle" style="margin:0;">Behavioral rules</div>
      <span class="rules-summary">${failing.length} failing · ${passing.length} passing · ${na.length} not applicable</span>
      ${ICONS.chevDown}
    </summary>
    <div class="rules-body">
      ${failingHtml}
      <div class="rules-na">${passing.length} rules passing at 100%.${na.length > 0 ? ` ${na.length} not applicable.` : ""}</div>
    </div>
  </details>`;
}

export function renderReproducibility(report: Report): string {
  const cmd = `agent-triage analyze --traces conversations.json --model ${esc(report.llmModel)}`;
  return `<div class="repro">
    <div class="repro-header">${ICONS.terminal} Re-run analysis</div>
    <div class="repro-body">
      <code class="repro-cmd">${cmd}</code>
      <button class="repro-copy" onclick="copyText(this, '${cmd}')">${ICONS.refresh} Copy command</button>
    </div>
    <div class="repro-meta">agent-triage v${report.agentTriageVersion} · ${report.totalConversations} conversations · ${report.policies.length} behavioral rules</div>
  </div>`;
}

export function renderFooter(): string {
  return `<div class="ftr"><div class="ftr-brand"><div class="ftr-mark">${ICONS.check}</div><span class="ftr-text">Powered by <a href="https://converra.ai" class="ftr-name">Converra</a></span> — for when you're done fixing agents manually. <a href="https://converra.ai" class="ftr-link">Learn more ${ICONS.externalSm}</a></span></div><div class="helpful">Was this report useful? <button class="hbtn">${ICONS.thumbUp}</button> <button class="hbtn">${ICONS.thumbDown}</button></div></div>`;
}
