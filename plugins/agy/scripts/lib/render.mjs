function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/agy:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/agy:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /agy:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /agy:result ${job.id}`);
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

const MODE_SOURCE_LABELS = {
  flag: "from --mode",
  workspace: "set for this workspace by /agy:setup --mode",
  env: "from AGY_PLUGIN_DEFAULT_MODE",
  default: "default"
};

function describeModeSource(source) {
  return MODE_SOURCE_LABELS[source] ?? source;
}

export function renderSetupReport(report) {
  const lines = [
    "# agy Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- agy: ${report.agy.detail}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    report.modeError ? `- run mode: invalid (${report.modeError})` : `- run mode: ${report.mode} (${describeModeSource(report.modeSource)})`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// Headless agy skips actions it would have asked about, exits 0 and says so
// only on stderr. Without this the skip is invisible to whoever reads stdout.
export function appendAgyNotices(text, stderr) {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const notices = typeof stderr === "string" ? stderr.trim() : "";
  if (!notices) {
    return body;
  }
  return `${body}\nNotices from agy:\n${notices}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput =
    typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return appendAgyNotices(rawOutput, parsedResult?.failureMessage);
  }

  const message =
    String(parsedResult?.failureMessage ?? "").trim() ||
    "agy did not return a final message.";
  return `${message}\n`;
}

export function renderReviewResult(rawOutput, meta) {
  const output = typeof rawOutput === "string" ? rawOutput.trim() : "";
  const lines = [`# agy ${meta.reviewLabel}`, "", `Target: ${meta.targetLabel}`, ""];

  if (output) {
    lines.push(output);
  } else {
    lines.push("agy review completed without output.");
  }

  return appendAgyNotices(lines.join("\n").trimEnd(), meta.stderr);
}

export function renderStatusReport(report) {
  const lines = [
    "# agy Status",
    "",
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push(
      "The stop-time review gate is enabled.",
      "Ending the session will trigger a fresh agy review and block if it finds issues."
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# agy Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.rendered === "string" && storedJob.rendered) ||
    "";

  if (rawOutput) {
    // Task results keep agy's stderr beside rawOutput; review results are
    // served from `rendered`, which already carries the notices.
    const stderr = rawOutput === storedJob?.result?.rawOutput ? storedJob.result.stderr : null;
    return appendAgyNotices(rawOutput, stderr);
  }

  const lines = [
    `# ${job.title ?? "agy Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# agy Cancel", "", `Cancelled ${job.id}.`, ""];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/agy:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
