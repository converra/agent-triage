# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in converra-triage, please report it responsibly.

**Email:** [hello@converra.ai](mailto:hello@converra.ai)

Please include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

The following are in scope:
- Command injection or code execution via CLI inputs
- XSS or injection in generated HTML reports
- Credential leakage (API keys in logs, reports, or error messages)
- Dependency vulnerabilities with a known exploit

The following are out of scope:
- LLM prompt injection (inherent to LLM-based evaluation — the tool evaluates untrusted conversations by design)
- Denial of service via large input files (no server component)
- Issues in dependencies without a proof-of-concept exploit

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
