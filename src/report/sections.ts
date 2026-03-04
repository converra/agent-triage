import type { Report } from "../evaluation/types.js";
import { buildConversationFixMd, buildRecommendationFixMd } from "./fix-instructions.js";
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

/** Truncate text at the last space before `max` characters and append "…". */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, max)) + "…";
}

export function renderHeader(report: Report, date: string): string {
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
    <div class="hdr-meta">
      Model <span>${esc(report.llmModel)}</span> &middot;
      Cost <span>$${report.cost.estimatedCost.toFixed(2)}</span> &middot;
      <span>${date}</span>
    </div>
  </div>`;
}

export function renderHealthSummary(
  report: Report,
  healthy: number,
  needsAttention: number,
  critical: number,
  issueConvs: Report["conversations"],
): string {
  const total = report.totalConversations;
  const issues = needsAttention + critical;

  if (issues === 0) {
    return `<div class="health-summary">
      <div class="verdict" style="background:var(--green-bg);border-color:var(--green-border);">
        <div class="verdict-icon" style="color:var(--green);">${ICONS.checkCircle}</div>
        <div><div class="verdict-text">All ${total} conversations are healthy.</div><div class="verdict-detail">Quality scores above 75 and no policy failures.</div></div>
      </div>
    </div>`;
  }

  // Pull top diagnosis summaries — prioritize critical, deduplicate, cap at 2
  const topSummaries = buildTopSummaries(issueConvs);

  const isAmber = critical === 0;
  const verdictStyle = isAmber
    ? `background:var(--amber-bg);border-color:var(--amber-border);`
    : ``;
  const iconStyle = isAmber ? ` style="color:var(--amber);"` : "";

  return `<div class="health-summary">
    <div class="verdict" style="${verdictStyle}">
      <div class="verdict-icon"${iconStyle}>${ICONS.alertTriangle}</div>
      <div class="verdict-body">
        <div class="verdict-text">${issues} of ${total} conversations have issues${critical > 0 ? ` — ${critical} critical` : ""}.</div>
        ${topSummaries}
      </div>
      <a href="#recs-section" class="verdict-cta" onclick="event.preventDefault();scrollToRecs()">See fixes below ${ICONS.chevDownSm}</a>
    </div>
  </div>`;
}

/** Extract top 2 distinct problem descriptions from failing conversations. */
function buildTopSummaries(issueConvs: Report["conversations"]): string {
  const withDiag = issueConvs.filter((c) => c.diagnosis);
  if (withDiag.length === 0) return "";

  const seen = new Set<string>();
  const items: string[] = [];
  for (const c of withDiag) {
    const d = c.diagnosis!;
    const text = d.shortSummary || d.summary.split(/\.\s/)[0]!.replace(/\.$/, "");
    const key = text.slice(0, 30).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const typeClass = d.failureType === "prompt_issue" ? "prompt" : d.failureType === "orchestration_issue" ? "orch" : "model";
    items.push(`<li><span class="type-badge sm ${typeClass}">${esc(formatFailureType(d.failureType))}</span> ${escBold(text)}</li>`);
    if (items.length >= 2) break;
  }

  return `<ul class="verdict-summaries">${items.join("")}</ul>`;
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
function summarizeTurnContent(text: string, maxLen: number): string {
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

  if (trimmed.length > maxLen) return trimmed.slice(0, maxLen) + "...";
  return trimmed;
}

/** Find the orchestrator/router agent name from policy metadata, if one exists. */
function findOrchestratorName(report: Report): string | undefined {
  const sourceAgents = [...new Set(report.policies.map((p) => p.sourceAgent).filter(Boolean))];
  return sourceAgents.find((a) => /orchestrat|router|coordinator|dispatch/i.test(a!)) as string | undefined;
}

/** Classify each turn for visual hierarchy. */
interface TurnClassification {
  turnNum: number;
  originalTurn: number;
  isRoot: boolean;
  isFailing: boolean;
  isCascade: boolean;
  isUser: boolean;
  msg: Report["conversations"][0]["messages"][0];
}

function classifyTurns(
  conv: Report["conversations"][0],
  d: NonNullable<Report["conversations"][0]["diagnosis"]>,
): TurnClassification[] {
  // Build a map from original 1-based message index to visible step number.
  // The LLM numbers ALL messages (including system/tool) so failingTurns uses
  // that global numbering. We need to translate when matching against visible steps.
  const visibleSteps: { msg: Report["conversations"][0]["messages"][0]; originalTurn: number }[] = [];
  for (let i = 0; i < conv.messages.length; i++) {
    const m = conv.messages[i];
    if (m.role === "user" || m.role === "assistant") {
      visibleSteps.push({ msg: m, originalTurn: i + 1 });
    }
  }

  // If the LLM marked a user turn as root cause, shift to the previous assistant turn.
  // The root cause is always the agent's action, not the user's reaction.
  let effectiveRootTurn = d.rootCauseTurn;
  const rootMsg = conv.messages[d.rootCauseTurn - 1];
  if (rootMsg?.role === "user") {
    for (let j = d.rootCauseTurn - 2; j >= 0; j--) {
      if (conv.messages[j].role === "assistant") {
        effectiveRootTurn = j + 1;
        break;
      }
    }
  }

  return visibleSteps.map(({ msg, originalTurn }, i) => {
    const turnNum = i + 1;
    const isUser = msg.role === "user";
    const isRoot = originalTurn === effectiveRootTurn;
    // Violations can only be attributed to assistant turns
    const isFailing = !isUser && conv.policyResults.some(
      (pr) => !pr.passed && pr.failingTurns?.includes(originalTurn),
    );
    const isCascade = !isRoot && !isFailing && originalTurn > effectiveRootTurn;
    return { turnNum, originalTurn, isRoot, isFailing, isCascade, isUser, msg };
  });
}

/** Collapse consecutive OK turns into summary rows (mirrors app's compactTimeline). */
type TimelineEntry =
  | { kind: "turn"; turn: TurnClassification }
  | { kind: "summary"; startStep: number; endStep: number; count: number };

function compactTimeline(turns: TurnClassification[]): TimelineEntry[] {
  // Keep root cause ± 1 expanded even if OK
  const rootIdx = turns.findIndex((t) => t.isRoot);
  const keepExpanded = new Set<number>();
  if (rootIdx >= 0) {
    for (let i = Math.max(0, rootIdx - 1); i <= Math.min(turns.length - 1, rootIdx + 1); i++) {
      keepExpanded.add(i);
    }
  }

  const entries: TimelineEntry[] = [];
  let okRun: TurnClassification[] = [];

  const flushOkRun = () => {
    if (okRun.length >= 3) {
      entries.push({ kind: "summary", startStep: okRun[0].turnNum, endStep: okRun[okRun.length - 1].turnNum, count: okRun.length });
    } else {
      for (const t of okRun) entries.push({ kind: "turn", turn: t });
    }
    okRun = [];
  };

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const isOk = !t.isRoot && !t.isFailing && !t.isCascade;
    if (isOk && !keepExpanded.has(i)) {
      okRun.push(t);
    } else {
      flushOkRun();
      entries.push({ kind: "turn", turn: t });
    }
  }
  flushOkRun();
  return entries;
}

function buildTurnTimeline(
  conv: Report["conversations"][0],
  report: Report,
  cascadeMap: Map<number, string>,
): string[] {
  const d = conv.diagnosis!;
  const orchestrator = findOrchestratorName(report);
  let lastAgent: string | undefined;

  const allTurns = classifyTurns(conv, d);
  const entries = compactTimeline(allTurns);

  return entries.map((entry) => {
    // Summary row for collapsed OK steps
    if (entry.kind === "summary") {
      return `<div class="turn turn-summary"><div class="tdot summary"></div><div class="tc"><div class="tc-summary">Steps ${entry.startStep}–${entry.endStep}: OK (${entry.count} steps)</div></div></div>`;
    }

    const { turnNum, originalTurn, isRoot, isFailing, isCascade, isUser, msg } = entry.turn;
    const dotClass = isRoot || isFailing ? "f" : isCascade ? "w" : "p";

    // Policy violations — show names directly
    let failBadges = "";
    const failingPolicies = (isRoot || isFailing)
      ? conv.policyResults.filter((pr) => !pr.passed && pr.failingTurns?.includes(originalTurn))
      : [];
    if (failingPolicies.length > 0) {
      failBadges = failingPolicies
        .map((pr) => {
          const policy = report.policies.find((p) => p.id === pr.policyId);
          return `<span class="tb f">${esc(policy?.name ?? pr.policyId)}</span>`;
        })
        .join("");
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
    const rcTypeClass = d.failureType === "prompt_issue" ? "prompt" : d.failureType === "orchestration_issue" ? "orch" : "model";
    const rcTag = isRoot
      ? `<span class="rc-label">root cause:</span> <span class="rc-type ${rcTypeClass}">${esc(formatFailureType(d.failureType))}</span>`
      : "";
    const cascadeDesc = cascadeMap.get(originalTurn);
    const plain = stripHtml(msg.content);
    const turnDesc = d.turnDescriptions?.[originalTurn];

    // Narrative-first: diagnosis/description is primary, message is secondary
    const diagText = isRoot ? (d.shortSummary || d.summary) : (isFailing || isCascade) ? cascadeDesc : undefined;
    let contentHtml: string;
    if (diagText && (isRoot || isFailing || isCascade)) {
      const maxLen = isRoot ? 200 : 120;
      const content = summarizeTurnContent(plain, maxLen);
      contentHtml = `<div class="tc-narrative">${escBold(diagText)}</div><div class="tc-msg">${escBold(content)}</div>`;
    } else if (turnDesc) {
      const maxLen = isUser ? 80 : 120;
      const content = summarizeTurnContent(plain, maxLen);
      contentHtml = `<div class="tc-narrative">${escBold(turnDesc)}</div><div class="tc-msg">${escBold(content)}</div>`;
    } else {
      const maxLen = isUser ? 80 : 120;
      const content = summarizeTurnContent(plain, maxLen);
      contentHtml = `<div class="tc-text">${escBold(content)}</div>`;
    }

    // Visual hierarchy classes
    const turnClasses = ["turn"];
    if (isUser) turnClasses.push("turn-user");
    if (isRoot) turnClasses.push("turn-root");
    else if (isFailing) turnClasses.push("turn-failing");
    else if (isCascade) turnClasses.push("turn-cascade");

    return `<div class="${turnClasses.join(" ")}"><div class="tdot ${dotClass}"></div><div class="tc"><div class="tc-label">${stepLabel}${agentTag}${rcTag}</div>${contentHtml}${failBadges ? `<div class="tc-badges">${failBadges}</div>` : ""}</div></div>`;
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

      const expand = d ? renderConvDive(c, d, report) : "";
      const openAttr = index === 0 ? " open" : "";

      return `<details class="conv-detail" id="${esc(c.id)}"${openAttr}>
        <summary>
          <span class="cid">${esc(c.id.slice(0, 10))}</span>
          ${agentBadge}
          <span class="conv-score ${healthClass}">${avg}</span>
          <span class="conv-cause">${escBold(cause)}</span>
          <span class="conv-pills">${pills}</span>
          <span class="sev-badge ${healthClass}">${health === "critical" ? "critical" : "attention"}</span>
          ${d?.failureSubtype ? `<span class="type-badge sm ${d.failureType === "prompt_issue" ? "prompt" : d.failureType === "orchestration_issue" ? "orch" : "model"}">${esc(formatSubtype(d.failureSubtype))}</span>` : ""}
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
): string {
  const cascadeMap = new Map<number, string>();
  for (const entry of d.cascadeChain) {
    const match = entry.match(/^Turn\s+(\d+)\s*:\s*(.+)$/i);
    if (match) cascadeMap.set(Number(match[1]), match[2]!.trim());
  }

  const fixMd = btoa(unescape(encodeURIComponent(buildConversationFixMd(conv, report))));
  const turns = buildTurnTimeline(conv, report, cascadeMap).slice(0, 6);

  const blastHtml = d.blastRadius.length > 0
    ? `<div class="blast"><span class="blast-icon">${ICONS.alertTriangleSm}</span><span><strong>Blast radius:</strong> Editing may affect ${d.blastRadius.map((r) => `<em>${esc(r)}</em>`).join(", ")}.</span></div>`
    : "";


  return `<div class="conv-expand">
    <div class="tl">
      <div class="tl-header"><div class="tl-label">Step Timeline</div><div class="tl-filter">${turns.length} of ${conv.messages.length} steps</div></div>
      ${turns.join("")}
    </div>
    <div class="wif">
      <div class="wif-s"><div class="wif-l">What happened</div><div class="wif-t">${escBold(truncate(d.summary, 300))}</div></div>
      <div class="wif-s"><div class="wif-l impact">Impact</div><div class="wif-t">${escBold(truncate(d.impact, 300))}</div></div>
      <div class="wif-s"><div class="wif-l fix">Fix</div><div class="wif-t">${escBold(truncate(d.fix, 250))} <span class="wif-conf">(${d.confidence} confidence)</span></div></div>
    </div>
    ${blastHtml}
    <div class="diag-cta">
      <button class="copy-btn" data-fix="${fixMd}" onclick="copyFix(this)">${ICONS.copy} Copy for coding agent</button>
      ${d.failureType === "prompt_issue" || d.failureType === "retrieval_rag_issue" ? `<a href="https://converra.ai" class="diag-link">Fix in Converra ${ICONS.externalSm}</a>` : ""}
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

  const renderGroupLine = (
    patterns: Report["failurePatterns"]["byType"],
    label: string,
    icon: string,
    cssClass: string,
  ): string => {
    const subtypes = patterns.flatMap((p) =>
      p.subtypes.map((s) => `${esc(formatSubtype(s.name))} ${s.count} (${s.percentage}%)`),
    );
    return `<div class="group-label ${cssClass}">${icon} ${label}: ${subtypes.join(", ")}</div>`;
  };

  let html = `<div class="patterns" style="border-bottom:1px solid var(--border-subtle);padding:12px 0 8px;">`;
  html += `<div class="stitle">Root cause analysis</div>`;

  if (fixable.length > 0) {
    html += renderGroupLine(fixable, "Fixable — prompt &amp; config", ICONS.checkCircleSm, "fixable");
  }

  if (needsCode.length > 0) {
    html += renderGroupLine(needsCode, "Needs code change", ICONS.code, "needs-code");
  }

  html += `<div class="trust-note">${ICONS.lock} This report is local-only. No data was uploaded.</div>`;
  html += `</div>`;
  return html;
}


export function renderRecommendations(report: Report): string {
  if (report.failurePatterns.topRecommendations.length === 0) return "";

  const cards = report.failurePatterns.topRecommendations
    .map((rec, i) => {
      const targets = rec.targetFailureTypes
        .map(formatFailureType)
        .join(", ");
      const recMd = btoa(unescape(encodeURIComponent(buildRecommendationFixMd(rec, i))));

      // Pull evidence from conversations matching this recommendation's failure types
      const evidence = report.conversations
        .filter((c) => c.diagnosis && rec.targetFailureTypes.includes(c.diagnosis.failureType))
        .slice(0, 2)
        .map((c) => `<span style="color:var(--text-3);font-size:12px;">${esc(c.id.slice(0, 10))}: ${escBold(c.diagnosis!.summary.split(".")[0]!)}</span>`)
        .join("<br>");
      const evidenceHtml = evidence ? `<div style="margin-top:8px;padding:8px 10px;background:var(--bg-subtle);border-radius:var(--r);border:1px solid var(--border-subtle);line-height:1.6;">${evidence}</div>` : "";

      const howToApplyHtml = rec.howToApply
        ? `<div class="rec-how-to-apply"><div class="rec-how-label">How to apply</div><div class="rec-how-content">${escBold(truncate(rec.howToApply, 400))}</div></div>`
        : "";

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
        ${howToApplyHtml}
        ${evidenceHtml}
        <div class="rec-actions">
          <button class="copy-btn" data-fix="${recMd}" onclick="copyFix(this)">${ICONS.copy} Copy for coding agent</button>
          ${rec.targetFailureTypes.some((t: string) => t === "prompt_issue" || t === "retrieval_rag_issue") ? `<a href="https://converra.ai" class="diag-link">Fix in Converra ${ICONS.externalSm}</a>` : ""}
        </div>
      </div>
    </details>`;
    })
    .join("");

  return `<details class="recs" id="recs-section" open>
    <summary class="recs-header">
      <div class="stitle" style="margin:0;">How to fix it</div>
      <a href="https://converra.ai" class="verdict-cta" onclick="event.stopPropagation()">Track fixes over time ${ICONS.externalSm}</a>
      ${ICONS.chevDown}
    </summary>
    ${cards}
  </details>`;
}

export function renderBehavioralRules(report: Report): string {
  if (report.policies.length === 0) return "";

  const evaluated = report.policies.filter((p) => p.evaluated > 0);
  const failing = evaluated.filter((p) => p.failing > 0).sort((a, b) => a.complianceRate - b.complianceRate);
  const passing = evaluated.filter((p) => p.failing === 0);
  const na = report.policies.filter((p) => p.evaluated === 0);

  if (failing.length === 0) {
    return `<div class="rules-section-inline">${ICONS.checkCircleSm} <span>${evaluated.length} behavioral rules evaluated — all passing.</span></div>`;
  }

  const failingHtml = failing.map((p) => {
    const icon = p.complianceRate < 50 ? "red" : "amber";
    return `<div class="rule-row"><span class="rule-icon ${icon}">${p.complianceRate < 50 ? "×" : "!"}</span><span class="rule-name">${esc(p.name)}</span><span class="rule-stat ${icon}">${p.complianceRate}% (${p.failing}/${p.evaluated} failing)</span></div>`;
  }).join("");

  return `<details class="rules-section">
    <summary>
      <div class="stitle" style="margin:0;">Behavioral rules</div>
      <span class="rules-summary">${failing.length} failing · ${passing.length} passing</span>
      ${ICONS.chevDown}
    </summary>
    <div class="rules-body">
      ${failingHtml}
      <div class="rules-na">${passing.length} rules passing at 100%.</div>
    </div>
  </details>`;
}

export function renderReproducibility(report: Report): string {
  const cmd = `agent-triage analyze --traces conversations.json --model ${esc(report.llmModel)}`;
  return `<div class="repro">
    <div class="repro-header">${ICONS.terminal} Reproduce this report</div>
    <div class="repro-desc">Run this CLI command to re-run the same analysis on your machine.</div>
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
