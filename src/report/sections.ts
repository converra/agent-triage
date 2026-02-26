import type { Report } from "../evaluation/types.js";
import { buildConversationFixMd, buildPatternFixMd, buildRecommendationFixMd } from "./fix-instructions.js";
import {
  avgMetrics,
  buildConvAgentMap,
  conversationHealth,
  describeWeakMetrics,
  esc,
  formatFailureType,
  formatSubtype,
  stripHtml,
} from "./helpers.js";
import { ICONS } from "./styles.js";

export function renderHeader(report: Report, date: string, duration: string): string {
  const agentCount = report.agents?.length ?? 0;
  const headerTitle = agentCount > 1
    ? `${agentCount} Agents Analyzed`
    : esc(report.agents?.[0]?.name ?? report.agent.name);

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
  const healthyPct = total > 0 ? Math.round((healthy / total) * 100) : 100;

  return `<div class="health-summary">
    <div class="pipe-steps">
      <div class="pipe-step"><div class="pipe-num">${total}</div><div class="pipe-label"><b>Conversations</b><br>evaluated</div></div>
      <div class="pipe-step"><div class="pipe-num emerald">${healthy}</div><div class="pipe-label"><b>Healthy</b><br>${healthyPct}% of total</div></div>
      <div class="pipe-step"><div class="pipe-num coral">${needsAttention}</div><div class="pipe-label"><b>Need attention</b><br>score 50–74</div></div>
      <div class="pipe-step"><div class="pipe-num red">${critical}</div><div class="pipe-label"><b>Critical</b><br>score below 50</div></div>
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

  return `<div class="stitle" style="margin-top:16px;">Quality metrics (averages)</div>
  <div class="metrics-bar">${cells.join("")}</div>`;
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

  return `<div class="agents-section">
    <div class="stitle">Agent health</div>
    <div class="agents-grid">${cards}</div>
  </div>`;
}

export function renderVerdict(
  report: Report,
  needsAttention: number,
  critical: number,
): string {
  const issues = needsAttention + critical;

  if (issues === 0) {
    return `<div class="verdict" style="background:var(--green-bg);border-color:var(--green-border);">
      <div class="verdict-icon" style="color:var(--green);">${ICONS.checkCircle}</div>
      <div>
        <div class="verdict-text">All ${report.totalConversations} conversations are healthy.</div>
        <div class="verdict-detail">Average quality scores are above 75 across all metrics.</div>
      </div>
    </div>`;
  }

  const promptFixable = report.failurePatterns.byType
    .filter((t) => t.type === "prompt_issue" || t.type === "retrieval_rag_issue")
    .reduce((s, t) => s + t.count, 0);

  const needsCode = report.failurePatterns.byType
    .filter((t) => t.type === "orchestration_issue" || t.type === "model_limitation")
    .reduce((s, t) => s + t.count, 0);

  const parts = [];
  if (promptFixable > 0 && needsCode > 0) {
    parts.push(
      `${promptFixable} root causes are fixable via prompt changes, ${needsCode} need code changes`,
    );
  } else if (promptFixable > 0) {
    parts.push(`Root causes are fixable via prompt changes`);
  }

  return `<div class="verdict">
    <div class="verdict-icon">${ICONS.alertTriangle}</div>
    <div class="verdict-body">
      <div class="verdict-text">${issues} of ${report.totalConversations} conversations have issues${critical > 0 ? ` — ${critical} are critical` : ""}.</div>
      <div class="verdict-detail">${parts.length > 0 ? parts.join(". ") + "." : `${issues} conversations scored below 75 on quality metrics.`}</div>
    </div>
    <a href="#diagnosis" class="verdict-cta" onclick="document.querySelector('.diag')?.scrollIntoView({behavior:'smooth',block:'start'});return false;">See diagnosis ${ICONS.chevDownSm}</a>
  </div>`;
}

function buildTurnTimeline(
  conv: Report["conversations"][0],
  report: Report,
  cascadeMap: Map<number, string>,
): string[] {
  const d = conv.diagnosis!;
  return conv.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((msg, i) => {
      const turnNum = i + 1;
      const isRoot = turnNum === d.rootCauseTurn;
      const isFailing = conv.policyResults.some((pr) => !pr.passed && pr.failingTurns?.includes(turnNum));
      const isCascade = !isRoot && !isFailing && turnNum > d.rootCauseTurn;
      const dotClass = isRoot || isFailing ? "f" : isCascade ? "w" : "p";

      const failBadges = conv.policyResults
        .filter((pr) => !pr.passed && pr.failingTurns?.includes(turnNum))
        .map((pr) => {
          const policy = report.policies.find((p) => p.id === pr.policyId);
          return `<span class="tb f">${esc(policy?.name ?? pr.policyId)} ×</span>`;
        })
        .join("");

      const label = isRoot ? `Turn ${turnNum} — root cause` : `Turn ${turnNum}`;
      const cascadeDesc = cascadeMap.get(turnNum);
      const plain = stripHtml(msg.content);
      const content = cascadeDesc ?? (plain.length > 200 ? plain.slice(0, 200) + "..." : plain);

      return `<div class="turn"><div class="tdot ${dotClass}"></div><div class="tc"><div class="tc-label">${label}</div><div class="tc-text">${esc(content)}</div>${failBadges ? `<div class="tc-badges">${failBadges}</div>` : ""}</div></div>`;
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

export function renderDeepDive(
  conv: Report["conversations"][0],
  report: Report,
): string {
  const d = conv.diagnosis!;

  const cascadeMap = new Map<number, string>();
  for (const entry of d.cascadeChain) {
    const match = entry.match(/^Turn\s+(\d+)\s*:\s*(.+)$/i);
    if (match) cascadeMap.set(Number(match[1]), match[2]!.trim());
  }

  const keyTurns = buildTurnTimeline(conv, report, cascadeMap).slice(0, 8);
  const metricBadges = buildMetricBadges(conv.metrics as Record<string, number>);
  const fixMd = btoa(unescape(encodeURIComponent(buildConversationFixMd(conv, report))));
  const blastHtml = d.blastRadius.length > 0
    ? `<div class="blast"><span class="blast-icon">${ICONS.alertTriangleSm}</span><span><strong>Blast radius:</strong> Editing may affect ${d.blastRadius.map((r) => `<em>${esc(r)}</em>`).join(", ")}.</span></div>`
    : "";

  return `<details class="diag" open>
    <summary>
      <div>
        <h2>Deep Dive — Worst Conversation</h2>
        <div class="diag-sub">
          Root cause at Turn ${d.rootCauseTurn}${d.rootCauseAgent ? ` (${esc(d.rootCauseAgent)})` : ""} — ${esc(d.summary.split(".")[0] ?? d.summary)}
          <span class="sev-badge ${d.severity === "critical" ? "crit" : "major"}">${d.severity}</span>
          <span class="conf">${d.confidence} confidence</span>
        </div>
        <div class="diag-badges">${metricBadges}<span class="diag-b type">${formatFailureType(d.failureType)}</span></div>
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
      <button class="copy-btn" data-fix="${fixMd}" onclick="copyFix(this)">${ICONS.copy} Copy fix instructions</button>
      <button class="copy-btn" data-fix="${fixMd}" onclick="downloadFix(this, 'fix-${esc(conv.id.slice(0, 10))}')">${ICONS.fileSm} Download .md</button>
      <a href="https://converra.ai" class="diag-link">Test with Converra ${ICONS.externalSm}</a>
    </div>
  </details>`;
}

export function renderAllConversations(
  issues: Report["conversations"],
  report: Report,
): string {
  if (issues.length === 0) return "";

  const convAgentMap = buildConvAgentMap(report);
  const shown = issues.slice(0, 50);

  const convHtml = shown
    .map((c) => {
      const avg = Math.round(avgMetrics(c.metrics));
      const health = conversationHealth(c.metrics);
      const healthClass = health === "critical" ? "crit" : "major";
      const d = c.diagnosis;
      const cause = d?.summary ?? describeWeakMetrics(c.metrics as Record<string, number>);
      const agentName = convAgentMap.get(c.id);
      const agentBadge = agentName && (report.agents?.length ?? 0) > 1
        ? `<span class="agent-badge">${esc(agentName)}</span>`
        : "";

      // Metric mini-pills
      const pills = [
        { key: "successScore", label: "S" },
        { key: "sentiment", label: "Se" },
        { key: "clarity", label: "C" },
      ].map((m) => {
        const val = (c.metrics as Record<string, number>)[m.key] ?? 0;
        const color = val >= 80 ? "green" : val >= 60 ? "amber" : "red";
        return `<span class="metric-mini ${color}">${val}</span>`;
      }).join("");

      const wif = d ? `<div class="conv-expand"><div class="wif"><div class="wif-s"><div class="wif-l">What happened</div><div class="wif-t">${esc(d.summary)}</div></div><div class="wif-s"><div class="wif-l impact">Impact</div><div class="wif-t">${esc(d.impact)}</div></div><div class="wif-s"><div class="wif-l fix">Fix</div><div class="wif-t">${esc(d.fix)} <span class="wif-conf">(${d.confidence} confidence)</span></div></div></div></div>` : "";

      return `<details class="conv-detail" id="${esc(c.id)}">
        <summary>
          <span class="cid">${esc(c.id.slice(0, 10))}</span>
          ${agentBadge}
          <span class="conv-score ${healthClass}">${avg}</span>
          <span class="conv-cause">${esc(cause)}</span>
          <span class="conv-pills">${pills}</span>
          <span class="sev-badge ${healthClass}">${health === "critical" ? "critical" : "attention"}</span>
          ${ICONS.chevDownSm}
        </summary>
        ${wif}
      </details>`;
    })
    .join("");

  const moreText =
    issues.length > 50
      ? `<div class="show-all">Showing 50 of ${issues.length} conversations with issues</div>`
      : "";

  return `<div class="convs">
    <div class="stitle">Conversations with issues</div>
    ${convHtml}
    ${moreText}
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
      return `<div class="mini-row"><span class="mini-id">${esc(c.id.slice(0, 10))}</span><span class="mini-cause">${esc(cause)}</span><span class="sev-badge ${sevClass}">${severity}</span><button class="mini-link" data-conv-id="${esc(c.id)}" onclick="viewConv(event, this)">View ${ICONS.chevRight}</button></div>`;
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

export function renderRecommendations(report: Report): string {
  if (report.failurePatterns.topRecommendations.length === 0) return "";

  const cards = report.failurePatterns.topRecommendations
    .map((rec, i) => {
      const targets = [...rec.targetSubtypes, ...rec.targetFailureTypes]
        .map(formatSubtype)
        .join(", ");
      const recMd = btoa(unescape(encodeURIComponent(buildRecommendationFixMd(rec, i))));
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
        <div class="rec-actions">
          <button class="copy-btn" data-fix="${recMd}" onclick="copyFix(this)">${ICONS.copy} Copy instructions</button>
          <button class="copy-btn" data-fix="${recMd}" onclick="downloadFix(this, 'rec-${i + 1}')">${ICONS.fileSm} Download .md</button>
        </div>
      </div>
    </details>`;
    })
    .join("");

  return `<div class="recs">
    <div class="recs-header"><div class="stitle" style="margin:0;">How to fix it</div><a href="https://converra.ai" class="recs-cta">Generate patches with Converra ${ICONS.externalSm}</a></div>
    ${cards}
  </div>`;
}

export function renderBehavioralRules(report: Report): string {
  const evaluated = report.policies.filter((p) => p.evaluated > 0);
  const failing = evaluated.filter((p) => p.failing > 0).sort((a, b) => a.complianceRate - b.complianceRate);
  const passing = evaluated.filter((p) => p.failing === 0);
  const na = report.policies.filter((p) => p.evaluated === 0);

  if (report.policies.length === 0) return "";

  const failingHtml = failing.map((p) => {
    const icon = p.complianceRate < 50 ? "red" : "amber";
    return `<div class="rule-row"><span class="rule-icon ${icon}">${p.complianceRate < 50 ? "×" : "!"}</span><span class="rule-name">${esc(p.name)}</span><span class="rule-stat ${icon}">${p.complianceRate}% (${p.failing}/${p.evaluated} failing)</span></div>`;
  }).join("");

  const passingHtml = passing.map((p) =>
    `<div class="rule-row"><span class="rule-icon green">✓</span><span class="rule-name">${esc(p.name)}</span><span class="rule-stat green">100%</span></div>`,
  ).join("");

  const openIfFailing = failing.length > 0 ? " open" : "";

  return `<details class="rules-section"${openIfFailing}>
    <summary>
      <div class="stitle" style="margin:0;">Behavioral rules</div>
      <span class="rules-summary">${evaluated.length} evaluated · ${failing.length} failing · ${na.length} not applicable</span>
      ${ICONS.chevDown}
    </summary>
    <div class="rules-body">
      ${failingHtml}
      ${passing.length > 0 ? `<div class="rules-divider"></div>${passingHtml}` : ""}
      ${na.length > 0 ? `<div class="rules-na">${na.length} rules not applicable to evaluated conversations</div>` : ""}
    </div>
  </details>`;
}

export function renderNextStep(report: Report): string {
  const recCount = report.failurePatterns.topRecommendations.length;
  return `<div class="next-step">
    <div class="next-step-header">${ICONS.external} What Converra can do with this report</div>
    <div class="next-step-body">
      <div class="next-step-item">${ICONS.fileSm} <strong>Generate prompt patches</strong> for all ${recCount} recommendations</div>
      <div class="next-step-item">${ICONS.checkCircleSm2} <strong>Simulate</strong> to validate fixes before deploying</div>
      <div class="next-step-item">${ICONS.checkAll} <strong>Deploy the winning variant</strong> without regressions</div>
    </div>
    <div class="next-step-footer">
      <a class="cta" href="https://converra.ai">Import report into Converra ${ICONS.externalSm}</a>
    </div>
  </div>`;
}

export function renderReproducibility(report: Report): string {
  return `<div class="repro">
    <div class="repro-header">${ICONS.terminal} How this report was generated</div>
    <div class="repro-body">
      <code class="repro-cmd">agent-triage analyze --traces [source] --model ${esc(report.llmModel)}</code>
      <button class="repro-copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">${ICONS.copy} Copy</button>
    </div>
    <div class="repro-meta">agent-triage v${report.agentTriageVersion} · ${report.totalConversations} conversations · ${report.policies.length} behavioral rules</div>
  </div>`;
}

export function renderFooter(): string {
  return `<div class="ftr"><div class="ftr-brand"><div class="ftr-mark">${ICONS.check}</div><span class="ftr-text">Powered by <a href="https://converra.ai" class="ftr-name">Converra</a></span></div><div class="ftr-tag">This report diagnoses problems. Converra treats them — generates prompt patches, simulates against your rules, and deploys without regressions.</div><a class="ftr-cta" href="https://converra.ai">See how Converra works ${ICONS.externalSm}</a><div class="helpful">Was this report useful? <button class="hbtn">${ICONS.thumbUp}</button> <button class="hbtn">${ICONS.thumbDown}</button></div></div>`;
}
